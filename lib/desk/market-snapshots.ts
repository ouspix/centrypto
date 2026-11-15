import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { listInstruments } from "./instruments";
import { readDiscoveryScan } from "./discovery-scan";
import { bps, hour, instrumentFeatures, intervals, minute, rankPercentile, type MarketFeatureRow, type MarketFeatureSnapshot } from "./market-features";
import type { SwingBar } from "./swing";

const retention = 30 * minute;
const history = 7 * 24 * hour;
const step = intervals["15m"];
const batchSize = 12;
export const contextMode = () => {
    const mode = process.env.DESK_MARKET_CONTEXT_MODE;
    return mode === "shadow" || mode === "enabled" ? mode : "legacy";
};
export const networkOf = (isTestnet: boolean): MarketFeatureSnapshot["network"] => isTestnet ? "testnet" : "mainnet";

type NetworkHistory = {
    bars: Map<string, SwingBar[]>;
    historyReadAt: Map<string, number>;
    funding: Map<string, { samples: number[]; refreshedAt: number }>;
    pending: Promise<void> | null;
    lastCandleRead: number;
    lastCandleClose: number;
    directory?: Awaited<ReturnType<typeof listInstruments>>;
    directoryAt?: number;
    nextAt: number;
    failures: number;
};
const histories = new Map<boolean, NetworkHistory>();
function historyFor(isTestnet: boolean) {
    let state = histories.get(isTestnet);
    if (!state) {
        state = { bars: new Map(), historyReadAt: new Map(), funding: new Map(), pending: null, nextAt: 0, failures: 0, lastCandleRead: 0, lastCandleClose: 0 };
        histories.set(isTestnet, state);
    }
    return state;
}

async function readBars(isTestnet: boolean, symbols: string[], from: number, end: number) {
    const db = isTestnet ? marketDbTest : marketDbMain;
    // The database returns complete aggregates only, keeping 1m history off the SSH tunnel.
    return db.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '6s'`;
        return tx.$queryRaw<Array<SwingBar & { symbol: string }>>`
            SELECT names.symbol, buckets.*
            FROM unnest(${symbols}::text[]) AS names(symbol)
            CROSS JOIN LATERAL (
                SELECT floor(extract(epoch FROM "openTime") / 900)::double precision * 900000 AS at,
                    (array_agg("open" ORDER BY "openTime"))[1] AS open, max("high") AS high,
                    min("low") AS low, (array_agg("close" ORDER BY "openTime" DESC))[1] AS close,
                    sum("volume" * "close") AS volume
                FROM "MarketCandle"
                WHERE "timeframe" = '1m' AND "symbol" = names.symbol
                    AND "openTime" >= ${new Date(from)} AND "openTime" < ${new Date(end)}
                    AND "open" > 0 AND "close" > 0 AND "low" > 0 AND "volume" >= 0
                    AND "high" >= greatest("open", "close") AND "low" <= least("open", "close")
                    AND "openTime" = date_trunc('minute', "openTime")
                GROUP BY floor(extract(epoch FROM "openTime") / 900)
                HAVING count(*) = 15
            ) AS buckets
            ORDER BY names.symbol, buckets.at`;
    }, { maxWait: 1000, timeout: 12_000 });
}

async function fundingSamples(isTestnet: boolean, symbols: string[], asOf: number) {
    const db = isTestnet ? marketDbTest : marketDbMain;
    const last = new Date(Math.floor(asOf / (4 * hour)) * 4 * hour);
    return db.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '4s'`;
        return tx.$queryRaw<Array<{ symbol: string; fundingRate: number }>>`
            SELECT name AS symbol, tick."fundingRate"
            FROM unnest(${symbols}::text[]) AS name
            CROSS JOIN generate_series(${new Date(+last - history)}::timestamp,
                                       ${new Date(+last - 4 * hour)}::timestamp, interval '4 hours') AS sample
            CROSS JOIN LATERAL (
                SELECT "fundingRate" FROM "MarketTick"
                WHERE "symbol" = name AND "ts" <= sample AND "ts" >= sample - interval '2 minutes'
                  AND "fundingRate" IS NOT NULL ORDER BY "ts" DESC LIMIT 1
            ) AS tick`;
    }, { maxWait: 1000, timeout: 9000 });
}

const number = (value: number | null | undefined) => value != null && Number.isFinite(value) ? value : null;

export async function refreshMarketFeatures(isTestnet: boolean, signal: AbortSignal) {
    const started = Date.now(), state = historyFor(isTestnet);
    const scan = await readDiscoveryScan(isTestnet);
    signal.throwIfAborted();
    const asOf = Date.parse(scan.asOf);
    // Allow the collector time to flush the last minute before using a completed bar.
    const closedThrough = Math.floor((asOf - 25_000) / step) * step;
    const symbols = scan.coverage.map(row => row.symbol);
    const active = new Set(symbols);
    for (const symbol of state.bars.keys()) if (!active.has(symbol)) { state.bars.delete(symbol); state.historyReadAt.delete(symbol); }
    for (const symbol of state.funding.keys()) if (!active.has(symbol)) state.funding.delete(symbol);
    let candleError: string | null = null;
    const warm = symbols.filter(symbol => state.bars.has(symbol));
    const cold = symbols.filter(symbol => !state.bars.has(symbol))
        .sort((a, b) => Number(["BTC", "ETH"].includes(b)) - Number(["BTC", "ETH"].includes(a)) || a.localeCompare(b))
        .slice(0, batchSize);
    const repair = warm.filter(symbol => asOf - (state.historyReadAt.get(symbol) ?? 0) >= hour)
        .sort((a, b) => (state.historyReadAt.get(a) ?? 0) - (state.historyReadAt.get(b) ?? 0))
        .slice(0, batchSize - cold.length);
    async function merge(selected: string[], from: number) {
        if (!selected.length) return;
        const rows = await readBars(isTestnet, selected, from, closedThrough);
        signal.throwIfAborted();
        const map = new Map(selected.map(symbol => [symbol, (state.bars.get(symbol) ?? [])
            .filter(bar => bar.at >= closedThrough - history && bar.at < from)]));
        for (const { symbol, ...bar } of rows) {
            if (Object.values(bar).every(Number.isFinite)) map.get(symbol)?.push(bar);
        }
        for (const [symbol, bars] of map) state.bars.set(symbol, bars);
    }
    try {
        const latest = Math.min(...warm.map(symbol => (state.bars.get(symbol)?.at(-1)?.at ?? closedThrough - 3 * step)));
        if (state.lastCandleClose !== closedThrough || asOf - state.lastCandleRead >= 5 * minute) {
            await merge(warm, Math.max(closedThrough - 8 * step, Math.min(closedThrough - 3 * step, latest)));
            state.lastCandleRead = asOf;
            state.lastCandleClose = closedThrough;
        }
    } catch {
        signal.throwIfAborted();
        candleError = "Collector candle refresh unavailable";
    }
    try {
        await merge([...cold, ...repair], closedThrough - history);
        for (const symbol of [...cold, ...repair]) state.historyReadAt.set(symbol, asOf);
    } catch {
        signal.throwIfAborted();
        candleError = "Collector candle history refresh unavailable";
    }
    const fundingDue = symbols.filter(symbol => asOf - (state.funding.get(symbol)?.refreshedAt ?? 0) >= hour).slice(0, batchSize);
    if (fundingDue.length) {
        try {
            const rows = await fundingSamples(isTestnet, fundingDue, asOf);
            const map = new Map(fundingDue.map(symbol => [symbol, [] as number[]]));
            for (const row of rows) if (Number.isFinite(row.fundingRate)) map.get(row.symbol)?.push(row.fundingRate);
            for (const [symbol, samples] of map) state.funding.set(symbol, { samples, refreshedAt: asOf });
        } catch {
            signal.throwIfAborted();
            // Current funding stays usable when its historical comparison cannot be refreshed.
        }
    }
    const instruments: MarketFeatureRow[] = scan.coverage.map(row => {
        const features = instrumentFeatures(state.bars.get(row.symbol) ?? [], closedThrough);
        const samples = state.funding.get(row.symbol);
        const funding = samples && asOf - samples.refreshedAt <= 2 * hour ? samples.samples : [];
        if (row.status !== "observed") return {
            ...features, instrumentId: row.instrumentId, symbol: row.symbol, observedAt: null, price: null, volume24h: null,
            fundingHourly: null, fundingPercentile: null, fundingSamples: 0, openInterestBase: null,
            openInterestUsd: null, oiChange1hPct: null, basisBps: null, spreadBps: null,
        };
        const { instrumentId, symbol, observedAt, price, oiChange1hPct } = row;
        const fundingHourly = number(row.fundingHourly);
        const openInterestBase = number(row.openInterestBase);
        const bid = number(row.bookBidPx), ask = number(row.bookAskPx);
        return {
            ...features, instrumentId, symbol, observedAt, price, tickReturns: { "1h": number(row.return1hBps), "4h": number(row.return4hBps) }, oiChange1hPct: number(oiChange1hPct), volume24h: number(row.volume24h),
            fundingHourly, fundingSamples: funding.length,
            fundingPercentile: fundingHourly != null && funding.length >= 20 ? rankPercentile(fundingHourly, funding) : null,
            openInterestBase, openInterestUsd: openInterestBase != null ? openInterestBase * price : null,
            basisBps: row.indexPrice && row.indexPrice > 0 ? bps(price, row.indexPrice) : null,
            spreadBps: bid != null && ask != null && bid > 0 && ask >= bid ? (ask - bid) / ((ask + bid) / 2) * 10_000 : null,
        };
    });
    const network = networkOf(isTestnet);
    if (!state.directory || asOf - (state.directoryAt ?? 0) >= 5 * minute) {
        state.directory = await listInstruments(isTestnet, "all").catch(() => []);
        state.directoryAt = asOf;
    }
    const directory = state.directory;
    const body = { directory, version: 1 as const, network, asOf, instruments, candleError };
    const id = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const snapshot: MarketFeatureSnapshot = { ...body, id, durationMs: Date.now() - started };
    signal.throwIfAborted();
    await prisma.$transaction([
        prisma.deskMarketSnapshot.upsert({ where: { id }, update: {}, create: { id, network, asOf: new Date(asOf), dataJson: JSON.stringify(snapshot) } }),
        prisma.deskMarketSnapshot.deleteMany({ where: { network, asOf: { lt: new Date(asOf - retention) } } }),
        prisma.deskArtifact.deleteMany({ where: { kind: "market_screen_page", createdAt: { lt: new Date(asOf - retention) } } }),
    ]);
    return snapshot;
}

export function scheduleMarketFeatures(isTestnet: boolean, signal: AbortSignal) {
    if (contextMode() === "legacy" || signal.aborted) return;
    const state = historyFor(isTestnet), now = Date.now();
    if (state.pending || now < state.nextAt) return;
    state.nextAt = now + minute;
    state.pending = refreshMarketFeatures(isTestnet, signal).then(() => { state.failures = 0; }, () => {
        state.failures = Math.min(state.failures + 1, 4);
        state.nextAt = Date.now() + minute * 2 ** state.failures;
        if (!signal.aborted) console.warn("[Trading desk] Market context refresh failed; retry scheduled.");
    }).finally(() => { state.pending = null; });
}

export async function readMarketFeatures(isTestnet: boolean, id?: string, at = Date.now()): Promise<MarketFeatureSnapshot | null> {
    const row = await prisma.deskMarketSnapshot.findFirst({
        where: { network: networkOf(isTestnet), asOf: { lte: new Date(at) }, ...(id ? { id } : {}) },
        orderBy: { asOf: "desc" }, select: { dataJson: true },
    });
    return row ? JSON.parse(row.dataJson) : null;
}
