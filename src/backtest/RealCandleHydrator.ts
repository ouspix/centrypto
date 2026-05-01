import crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import { createInterface } from "readline";
import { Readable } from "stream";
import { PrismaClient } from "@prisma/market-client";
import { waitForHyperliquidSlot } from "@/lib/hyperliquid-info";
import { createBacktestDbClient, ensureBacktestDbSchema } from "./BacktestDb";

const DEFAULT_CANDLE_CONCURRENCY = 4;
const NODE_DATA_BUCKET_URL = "https://hl-mainnet-node-data.s3.ap-northeast-1.amazonaws.com";
const NODE_DATA_AWS_REGION = process.env.HYPERLIQUID_NODE_DATA_AWS_REGION || "ap-northeast-1";

type RawCandle = {
    t: number;
    o: string | number;
    h: string | number;
    l: string | number;
    c: string | number;
    v: string | number;
};

type ArchiveHour = {
    date: string;
    hour: number;
    start: Date;
};

type RawNodeFill = {
    coin?: string;
    px?: string | number;
    sz?: string | number;
    time?: string | number;
    tid?: string | number;
    hash?: string;
    oid?: string | number;
};

type CandleAccumulator = BacktestRealCandle & {
    firstTime: number;
    lastTime: number;
};

export type BacktestRealCandle = {
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
};

export type HydrateRealCandlesOptions = {
    symbols: string[];
    network: "mainnet" | "testnet";
    start: Date;
    end: Date;
    dbPath?: string;
    concurrency?: number;
    useNodeFillArchive?: boolean;
    preferNodeFillArchive?: boolean;
    tmpRoot?: string;
    keepTmp?: boolean;
};

export type RealCandleCoverageReport = {
    expectedMinutes: number;
    missingBySymbol: Record<string, string[]>;
    complete: boolean;
};

export type HydrateRealCandlesResult = {
    symbols: string[];
    candlesFetched: number;
    candlesUpserted: number;
    coverage: RealCandleCoverageReport;
};

export async function hydrateRealCandlesForBacktest(options: HydrateRealCandlesOptions): Promise<HydrateRealCandlesResult> {
    const symbols = uniqueSymbols(options.symbols);
    const concurrency = positiveInt(options.concurrency, DEFAULT_CANDLE_CONCURRENCY);
    const archiveEnabled = options.network === "mainnet" && options.useNodeFillArchive !== false;
    let candlesFetched = 0;
    let candlesUpserted = 0;

    if (archiveEnabled && options.preferNodeFillArchive) {
        console.log(
            `[backtest:candles] Using node_fills_by_block archive before candleSnapshot for ` +
            `${options.start.toISOString()}..${options.end.toISOString()}`
        );
        const archive = await hydrateRealCandlesFromNodeFillsArchive({
            symbols,
            start: options.start,
            end: options.end,
            dbPath: options.dbPath,
            concurrency,
            tmpRoot: options.tmpRoot,
            keepTmp: options.keepTmp
        });
        candlesFetched += archive.candlesFetched;
        candlesUpserted += archive.candlesUpserted;
    }

    let coverage = await getRealCandleCoverageReport({
        symbols,
        start: options.start,
        end: options.end,
        dbPath: options.dbPath
    });
    const restSymbols = coverage.complete ? [] : uniqueSymbols(Object.keys(coverage.missingBySymbol));
    const fetched = await runWithConcurrency(restSymbols, concurrency, async symbol => ({
        symbol,
        candles: await fetchHyperliquidCandles(symbol, options.network, options.start, options.end)
    }));

    if (fetched.length > 0) {
        const db = createBacktestDbClient(options.dbPath);
        try {
            await ensureBacktestDbSchema(db);
            for (const result of fetched) {
                candlesFetched += result.candles.length;
                candlesUpserted += await upsertRealCandles(db, result.symbol, result.candles);
                console.log(`[backtest:candles] ${result.symbol}: upserted ${result.candles.length} real 1m candles`);
            }
        } finally {
            await db.$disconnect();
        }
    }

    coverage = await getRealCandleCoverageReport({
        symbols,
        start: options.start,
        end: options.end,
        dbPath: options.dbPath
    });

    if (!coverage.complete && archiveEnabled && !options.preferNodeFillArchive) {
        const missingSymbols = uniqueSymbols(Object.keys(coverage.missingBySymbol));
        console.log(
            `[backtest:candles] candleSnapshot missing ${missingSymbols.length} symbols for ` +
            `${options.start.toISOString()}..${options.end.toISOString()}; falling back to node_fills_by_block archive`
        );
        const archive = await hydrateRealCandlesFromNodeFillsArchive({
            symbols: missingSymbols,
            start: options.start,
            end: options.end,
            dbPath: options.dbPath,
            concurrency,
            tmpRoot: options.tmpRoot,
            keepTmp: options.keepTmp
        });
        candlesFetched += archive.candlesFetched;
        candlesUpserted += archive.candlesUpserted;
        coverage = await getRealCandleCoverageReport({
            symbols,
            start: options.start,
            end: options.end,
            dbPath: options.dbPath
        });
    }

    return {
        symbols,
        candlesFetched,
        candlesUpserted,
        coverage
    };
}

async function hydrateRealCandlesFromNodeFillsArchive(options: {
    symbols: string[];
    start: Date;
    end: Date;
    dbPath?: string;
    concurrency: number;
    tmpRoot?: string;
    keepTmp?: boolean;
}): Promise<{ candlesFetched: number; candlesUpserted: number }> {
    const symbols = uniqueSymbols(options.symbols);
    if (symbols.length === 0) return { candlesFetched: 0, candlesUpserted: 0 };

    const seedStart = new Date(options.start.getTime() - 60 * 60_000);
    const hours = archiveHours(seedStart, new Date(options.end.getTime() - 1));
    let candlesFetched = 0;
    let candlesUpserted = 0;

    try {
        const parsedByHour = await runWithConcurrency(hours, options.concurrency, async hour => {
            const key = `node_fills_by_block/hourly/${hour.date}/${hour.hour}.lz4`;
            console.log(`[backtest:candles] Streaming node fills ${hour.date}/${hour.hour}`);
            return deriveRealCandlesFromNodeFillsObject(key, symbols, seedStart, options.end);
        });

        const candlesBySymbol = new Map<string, BacktestRealCandle[]>();
        for (const parsed of parsedByHour) {
            mergeCandles(candlesBySymbol, parsed);
        }
        for (const symbol of symbols) {
            candlesBySymbol.set(symbol, fillNoTradeCandles(candlesBySymbol.get(symbol) ?? [], options.start, options.end));
        }

        const db = createBacktestDbClient(options.dbPath);
        try {
            await ensureBacktestDbSchema(db);
            for (const symbol of symbols) {
                const candles = candlesBySymbol.get(symbol) ?? [];
                candlesFetched += candles.length;
                candlesUpserted += await upsertRealCandles(db, symbol, candles);
                console.log(`[backtest:candles] ${symbol}: upserted ${candles.length} real 1m candles from node fills`);
            }
        } finally {
            await db.$disconnect();
        }
    } catch (error) {
        throw new Error(
            `Real candle archive fallback failed for ${options.start.toISOString()}..${options.end.toISOString()}: ${errorMessage(error)}`
        );
    }

    return { candlesFetched, candlesUpserted };
}

export async function fetchHyperliquidCandles(
    symbol: string,
    network: "mainnet" | "testnet",
    start: Date,
    end: Date
): Promise<BacktestRealCandle[]> {
    const apiUrl = network === "testnet"
        ? "https://api.hyperliquid-testnet.xyz/info"
        : "https://api.hyperliquid.xyz/info";
    await waitForHyperliquidSlot();
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            type: "candleSnapshot",
            req: {
                coin: baseSymbol(symbol),
                interval: "1m",
                startTime: start.getTime(),
                endTime: end.getTime()
            }
        })
    });
    if (!res.ok) throw new Error(`candleSnapshot failed for ${symbol}: ${res.status} ${await res.text()}`);
    const payload = await res.json();
    return Array.isArray(payload)
        ? payload.map(normalizeCandle).filter((candle): candle is BacktestRealCandle =>
            !!candle && candle.t >= start.getTime() && candle.t < end.getTime()
        )
        : [];
}

export async function upsertRealCandles(db: PrismaClient, symbol: string, candles: BacktestRealCandle[]): Promise<number> {
    if (candles.length === 0) return 0;
    const normalizedSymbol = baseSymbol(symbol);
    const normalizedCandles = normalizeRealCandles(candles);
    const batchSize = 100;
    for (let i = 0; i < normalizedCandles.length; i += batchSize) {
        await bulkUpsertRealCandleBatch(db, normalizedSymbol, normalizedCandles.slice(i, i + batchSize));
    }
    return normalizedCandles.length;
}

function normalizeRealCandles(candles: BacktestRealCandle[]): BacktestRealCandle[] {
    const byMinute = new Map<number, BacktestRealCandle>();
    for (const candle of candles) {
        const normalized = normalizeCandle(candle);
        if (!normalized) continue;
        byMinute.set(Math.floor(normalized.t / 60_000) * 60_000, {
            ...normalized,
            t: Math.floor(normalized.t / 60_000) * 60_000
        });
    }
    return Array.from(byMinute.values()).sort((a, b) => a.t - b.t);
}

async function bulkUpsertRealCandleBatch(db: PrismaClient, symbol: string, candles: BacktestRealCandle[]): Promise<void> {
    if (candles.length === 0) return;
    const rows = candles.map(candle => [
        symbol,
        "1m",
        new Date(candle.t),
        candle.o,
        candle.h,
        candle.l,
        candle.c,
        candle.v,
        "real_1m"
    ]);
    const placeholders = rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
    const params = rows.flat();

    await db.$transaction([
        db.$executeRawUnsafe(`
            CREATE TEMP TABLE IF NOT EXISTS "_BacktestRealCandleBulk" (
                "symbol" TEXT NOT NULL,
                "timeframe" TEXT NOT NULL,
                "openTime" DATETIME NOT NULL,
                "open" REAL NOT NULL,
                "high" REAL NOT NULL,
                "low" REAL NOT NULL,
                "close" REAL NOT NULL,
                "volume" REAL NOT NULL,
                "source" TEXT NOT NULL,
                PRIMARY KEY ("symbol", "timeframe", "openTime")
            )
        `),
        db.$executeRawUnsafe(`DELETE FROM "_BacktestRealCandleBulk"`),
        db.$executeRawUnsafe(
            `INSERT INTO "_BacktestRealCandleBulk" (
                "symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume", "source"
             ) VALUES ${placeholders}`,
            ...params
        ),
        db.$executeRawUnsafe(`
            INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume", "source")
            SELECT "symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume", "source"
            FROM "_BacktestRealCandleBulk"
            WHERE true
            ON CONFLICT("symbol", "timeframe", "openTime") DO UPDATE SET
                "open" = excluded."open",
                "high" = excluded."high",
                "low" = excluded."low",
                "close" = excluded."close",
                "volume" = excluded."volume",
                "source" = excluded."source"
        `)
    ]);
}

export async function getRealCandleCoverageReport(options: {
    symbols: string[];
    start: Date;
    end: Date;
    dbPath?: string;
}): Promise<RealCandleCoverageReport> {
    const symbols = uniqueSymbols(options.symbols);
    const expectedMinutes = realCandleOpenTimestamps(options.start, options.end);
    const missingBySymbol: Record<string, string[]> = {};
    if (symbols.length === 0 || expectedMinutes.length === 0) {
        return { expectedMinutes: expectedMinutes.length, missingBySymbol, complete: true };
    }

    const db = createBacktestDbClient(options.dbPath);
    try {
        await ensureBacktestDbSchema(db);
        const rows = await db.$queryRawUnsafe<Array<{ symbol: string; openTime: Date | string }>>(
            `SELECT "symbol", "openTime" FROM "MarketCandle"
             WHERE "timeframe" = '1m'
               AND COALESCE("source", CASE WHEN "volume" = 0 THEN 'synthetic_from_features' ELSE 'real_1m' END) = 'real_1m'
               AND "openTime" >= ? AND "openTime" <= ?
               AND "symbol" IN (${symbols.map(() => "?").join(",")})`,
            new Date(expectedMinutes[0]),
            new Date(expectedMinutes[expectedMinutes.length - 1]),
            ...symbols
        );
        const bySymbol = new Map<string, Set<number>>();
        for (const row of rows) {
            const ts = asDate(row.openTime).getTime();
            if (ts % 60_000 !== 0) continue;
            const bucket = bySymbol.get(row.symbol) ?? new Set<number>();
            bucket.add(ts);
            bySymbol.set(row.symbol, bucket);
        }
        for (const symbol of symbols) {
            const existing = bySymbol.get(symbol) ?? new Set<number>();
            const missing = expectedMinutes.filter(ts => !existing.has(ts)).map(ts => new Date(ts).toISOString());
            if (missing.length > 0) missingBySymbol[symbol] = missing;
        }
    } finally {
        await db.$disconnect();
    }

    return {
        expectedMinutes: expectedMinutes.length,
        missingBySymbol,
        complete: Object.keys(missingBySymbol).length === 0
    };
}

export async function getSyntheticCandleSymbols(options: {
    symbols?: string[];
    start: Date;
    end: Date;
    dbPath?: string;
}): Promise<string[]> {
    const symbols = options.symbols?.length ? uniqueSymbols(options.symbols) : await getFeatureSymbols(options);
    if (symbols.length === 0) return [];
    const db = createBacktestDbClient(options.dbPath);
    try {
        await ensureBacktestDbSchema(db);
        const rows = await db.$queryRawUnsafe<Array<{ symbol: string; openTime: Date | string; volume: number; source: string | null }>>(
            `SELECT "symbol", "openTime", "volume", "source" FROM "MarketCandle"
             WHERE "timeframe" = '1m'
               AND "openTime" >= ? AND "openTime" <= ?
             AND "symbol" IN (${symbols.map(() => "?").join(",")})
             ORDER BY "symbol" ASC, "openTime" ASC`,
            options.start,
            options.end,
            ...symbols
        );
        const realMinutesBySymbol = new Map<string, Set<number>>();
        const realCloseTimesBySymbol = new Map<string, Set<number>>();
        for (const row of rows) {
            if (candleSource(row) !== "real_1m") continue;
            const ts = asDate(row.openTime).getTime();
            if (ts % 60_000 !== 0) continue;
            const realMinutes = realMinutesBySymbol.get(row.symbol) ?? new Set<number>();
            const realCloseTimes = realCloseTimesBySymbol.get(row.symbol) ?? new Set<number>();
            realMinutes.add(floorMinute(ts));
            realCloseTimes.add(ts + 60_000);
            realMinutesBySymbol.set(row.symbol, realMinutes);
            realCloseTimesBySymbol.set(row.symbol, realCloseTimes);
        }

        const syntheticSymbols = new Set<string>();
        for (const row of rows) {
            if (candleSource(row) !== "synthetic_from_features") continue;
            const ts = asDate(row.openTime).getTime();
            const realMinutes = realMinutesBySymbol.get(row.symbol) ?? new Set<number>();
            const realCloseTimes = realCloseTimesBySymbol.get(row.symbol) ?? new Set<number>();
            if (!realMinutes.has(floorMinute(ts)) && !realCloseTimes.has(ts)) syntheticSymbols.add(row.symbol);
        }
        return Array.from(syntheticSymbols).sort();
    } finally {
        await db.$disconnect();
    }
}

export async function assertNoDisallowedSyntheticCandles(options: {
    symbols?: string[];
    start: Date;
    end: Date;
    dbPath?: string;
    allowSyntheticCandles: boolean;
}): Promise<void> {
    if (options.allowSyntheticCandles) return;
    const syntheticSymbols = await getSyntheticCandleSymbols(options);
    if (syntheticSymbols.length > 0) {
        throw new Error(
            `Synthetic execution candles remain for ${syntheticSymbols.join(",")}. ` +
            `Run with --hydrate-real-candles true or pass --allow-synthetic-candles true for approximate smoke tests.`
        );
    }
}

export function deriveRealCandlesFromNodeFillsLines(
    lines: string[],
    symbols: string[],
    start: Date,
    end: Date
): Record<string, BacktestRealCandle[]> {
    const symbolSet = new Set(uniqueSymbols(symbols));
    const expectedMinutes = realCandleOpenTimestamps(start, end);
    if (symbolSet.size === 0 || expectedMinutes.length === 0) return {};
    const startMs = expectedMinutes[0];
    const lastCandleOpenMs = expectedMinutes[expectedMinutes.length - 1];
    const sourceEndMs = lastCandleOpenMs + 60_000;
    const seenTrades = new Set<string>();
    const buckets = new Map<string, CandleAccumulator>();
    for (const line of lines) {
        addNodeFillLineToCandles(line, symbolSet, startMs, lastCandleOpenMs, sourceEndMs, seenTrades, buckets);
    }
    return finalizeCandles(buckets);
}

async function deriveRealCandlesFromNodeFillsObject(
    key: string,
    symbols: string[],
    start: Date,
    end: Date
): Promise<Map<string, BacktestRealCandle[]>> {
    return withDecodedNodeDataLz4ObjectStream(key, stream => deriveRealCandlesFromNodeFillsStream(stream, symbols, start, end));
}

async function deriveRealCandlesFromNodeFillsStream(
    input: NodeJS.ReadableStream,
    symbols: string[],
    start: Date,
    end: Date
): Promise<Map<string, BacktestRealCandle[]>> {
    const symbolSet = new Set(uniqueSymbols(symbols));
    const expectedMinutes = realCandleOpenTimestamps(start, end);
    if (symbolSet.size === 0 || expectedMinutes.length === 0) return new Map();
    const startMs = expectedMinutes[0];
    const lastCandleOpenMs = expectedMinutes[expectedMinutes.length - 1];
    const sourceEndMs = lastCandleOpenMs + 60_000;
    const seenTrades = new Set<string>();
    const buckets = new Map<string, CandleAccumulator>();
    const rl = createInterface({
        input,
        crlfDelay: Infinity
    });
    for await (const line of rl) {
        addNodeFillLineToCandles(line, symbolSet, startMs, lastCandleOpenMs, sourceEndMs, seenTrades, buckets);
    }
    return new Map(Object.entries(finalizeCandles(buckets)));
}

function addNodeFillLineToCandles(
    line: string,
    symbolSet: Set<string>,
    startMs: number,
    lastCandleOpenMs: number,
    sourceEndMs: number,
    seenTrades: Set<string>,
    buckets: Map<string, CandleAccumulator>
): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    const payload = JSON.parse(trimmed);
    const fills = extractNodeFills(payload);
    for (const fill of fills) {
        const symbol = baseSymbol(String(fill.coin ?? ""));
        if (!symbolSet.has(symbol)) continue;

        const time = Number(fill.time);
        const price = Number(fill.px);
        const size = Number(fill.sz);
        if (!Number.isFinite(time) || !Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
        if (time < startMs || time >= sourceEndMs) continue;

        const tradeKey = nodeFillTradeKey(symbol, fill);
        if (seenTrades.has(tradeKey)) continue;
        seenTrades.add(tradeKey);

        const minute = Math.floor(time / 60_000) * 60_000;
        if (minute > lastCandleOpenMs) continue;
        const bucketKey = `${symbol}:${minute}`;
        const bucket = buckets.get(bucketKey);
        if (!bucket) {
            buckets.set(bucketKey, {
                t: minute,
                o: price,
                h: price,
                l: price,
                c: price,
                v: size,
                firstTime: time,
                lastTime: time
            });
            continue;
        }

        if (time < bucket.firstTime) {
            bucket.o = price;
            bucket.firstTime = time;
        }
        if (time >= bucket.lastTime) {
            bucket.c = price;
            bucket.lastTime = time;
        }
        bucket.h = Math.max(bucket.h, price);
        bucket.l = Math.min(bucket.l, price);
        bucket.v += size;
    }
}

function extractNodeFills(payload: unknown): RawNodeFill[] {
    if (!payload) return [];
    if (Array.isArray(payload)) {
        if (payload.length >= 2 && isNodeFill(payload[1])) return [payload[1]];
        return payload.flatMap(item => extractNodeFills(item));
    }
    if (typeof payload !== "object") return [];
    const maybeBlock = payload as { events?: unknown };
    return Array.isArray(maybeBlock.events) ? extractNodeFills(maybeBlock.events) : [];
}

function isNodeFill(value: unknown): value is RawNodeFill {
    return !!value && typeof value === "object" && "coin" in value && "px" in value && "sz" in value && "time" in value;
}

function nodeFillTradeKey(symbol: string, fill: RawNodeFill): string {
    if (fill.tid !== undefined && fill.tid !== null) return `${symbol}:tid:${fill.tid}`;
    return `${symbol}:fallback:${fill.hash ?? ""}:${fill.oid ?? ""}:${fill.time ?? ""}:${fill.px ?? ""}:${fill.sz ?? ""}`;
}

function finalizeCandles(buckets: Map<string, CandleAccumulator>): Record<string, BacktestRealCandle[]> {
    const out: Record<string, BacktestRealCandle[]> = {};
    const entries = Array.from(buckets.entries()).sort((a, b) => {
        const [aSymbol] = a[0].split(":");
        const [bSymbol] = b[0].split(":");
        return aSymbol.localeCompare(bSymbol) || a[1].t - b[1].t;
    });
    for (const [key, candle] of entries) {
        const [symbol] = key.split(":");
        out[symbol] ??= [];
        out[symbol].push({
            t: candle.t,
            o: candle.o,
            h: candle.h,
            l: candle.l,
            c: candle.c,
            v: Number(candle.v.toFixed(12))
        });
    }
    return out;
}

function fillNoTradeCandles(candles: BacktestRealCandle[], start: Date, end: Date): BacktestRealCandle[] {
    const byMinute = new Map(candles.map(candle => [Math.floor(candle.t / 60_000) * 60_000, candle]));
    const expectedMinutes = realCandleOpenTimestamps(start, end);
    if (expectedMinutes.length === 0) return [];
    const filled: BacktestRealCandle[] = [];
    const firstMinute = expectedMinutes[0];
    let lastClose = candles
        .filter(candle => candle.t < firstMinute)
        .sort((a, b) => b.t - a.t)[0]?.c ?? null;
    for (const minute of expectedMinutes) {
        const candle = byMinute.get(minute);
        if (candle) {
            lastClose = candle.c;
            filled.push(candle);
        } else if (lastClose !== null) {
            filled.push({
                t: minute,
                o: lastClose,
                h: lastClose,
                l: lastClose,
                c: lastClose,
                v: 0
            });
        }
    }
    return filled;
}

function mergeCandles(target: Map<string, BacktestRealCandle[]>, source: Map<string, BacktestRealCandle[]>): void {
    for (const [symbol, candles] of source) {
        const existing = target.get(symbol) ?? [];
        existing.push(...candles);
        existing.sort((a, b) => a.t - b.t);
        target.set(symbol, existing);
    }
}

async function getFeatureSymbols(options: { start: Date; end: Date; dbPath?: string }): Promise<string[]> {
    const db = createBacktestDbClient(options.dbPath);
    try {
        await ensureBacktestDbSchema(db);
        const rows = await db.$queryRawUnsafe<Array<{ symbol: string }>>(
            `SELECT DISTINCT "symbol" FROM "MarketFeature"
             WHERE "ts" >= ? AND "ts" <= ?
             ORDER BY "symbol" ASC`,
            options.start,
            options.end
        );
        return rows.map(row => baseSymbol(row.symbol));
    } finally {
        await db.$disconnect();
    }
}

function normalizeCandle(candle: RawCandle): BacktestRealCandle | null {
    const normalized = {
        t: Number(candle.t),
        o: Number(candle.o),
        h: Number(candle.h),
        l: Number(candle.l),
        c: Number(candle.c),
        v: Number(candle.v)
    };
    return Object.values(normalized).every(Number.isFinite) ? normalized : null;
}

function realCandleOpenTimestamps(start: Date, end: Date): number[] {
    const first = Math.ceil(start.getTime() / 60_000) * 60_000;
    const last = Math.floor((end.getTime() - 60_000) / 60_000) * 60_000;
    const out: number[] = [];
    for (let ts = first; ts <= last; ts += 60_000) out.push(ts);
    return out;
}

function candleSource(row: { volume: number; source?: string | null }): "real_1m" | "synthetic_from_features" {
    if (row.source === "real_1m") return "real_1m";
    if (row.source === "synthetic_from_features") return "synthetic_from_features";
    return Number(row.volume) === 0 ? "synthetic_from_features" : "real_1m";
}

function floorMinute(ts: number): number {
    return Math.floor(ts / 60_000) * 60_000;
}

function uniqueSymbols(symbols: string[]): string[] {
    return Array.from(new Set(symbols.map(baseSymbol).filter(Boolean))).sort();
}

function baseSymbol(symbol: string): string {
    return symbol.replace(/-PERP$/, "");
}

function asDate(value: Date | string | number): Date {
    return value instanceof Date ? value : new Date(value);
}

function archiveHours(start: Date, end: Date): ArchiveHour[] {
    const hours: ArchiveHour[] = [];
    let cursor = floorHour(start);
    const last = floorHour(end);
    while (cursor <= last) {
        hours.push({ date: yyyymmdd(cursor), hour: cursor.getUTCHours(), start: cursor });
        cursor = new Date(cursor.getTime() + 60 * 60_000);
    }
    return hours;
}

function floorHour(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()));
}

function yyyymmdd(date: Date): string {
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

async function signedNodeDataFetch(url: URL | string): Promise<Response> {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
        throw new Error(
            "Hyperliquid node-fill archive is a Requester Pays S3 bucket. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY."
        );
    }
    const requestUrl = typeof url === "string" ? new URL(url) : url;
    return fetch(requestUrl, { headers: signS3Get(requestUrl, accessKeyId, secretAccessKey, NODE_DATA_AWS_REGION, process.env.AWS_SESSION_TOKEN) });
}

async function withDecodedNodeDataLz4ObjectStream<T>(key: string, consumer: (stream: NodeJS.ReadableStream) => Promise<T>): Promise<T> {
    const decompressor = findLz4();
    if (!decompressor) throw new Error("lz4/unlz4 is required for real candle archive hydration. Install it with: sudo apt install lz4");

    const url = `${NODE_DATA_BUCKET_URL}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const res = await signedNodeDataFetch(url);
    if (!res.ok) throw new Error(`Download failed for s3://hl-mainnet-node-data/${key}: ${res.status} ${await res.text()}`);
    if (!res.body) throw new Error(`Download failed for s3://hl-mainnet-node-data/${key}: empty response body`);

    const args = decompressor.includes("unlz4") ? ["-c"] : ["-d", "-c"];
    const child = spawn(decompressor, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", chunk => {
        if (stderr.length < 4000) stderr += String(chunk);
    });
    child.stdin?.on("error", () => {
        // The decompressor owns failure reporting through its exit code.
    });

    const source = Readable.fromWeb(res.body as any);
    source.on("error", error => child.stdin?.destroy(error));
    source.pipe(child.stdin!);

    const exit = new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", code => {
            if (code === 0) resolve();
            else reject(new Error(`Failed to decompress s3://hl-mainnet-node-data/${key}${stderr ? `: ${stderr.trim()}` : ""}`));
        });
    });

    try {
        const result = await consumer(child.stdout!);
        await exit;
        return result;
    } catch (error) {
        child.kill();
        throw error;
    }
}

function findLz4(): string | null {
    for (const candidate of ["lz4", "unlz4"]) {
        const result = spawnSync("which", [candidate], { encoding: "utf8" });
        if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    }
    return null;
}

function signS3Get(
    url: URL,
    accessKeyId: string,
    secretAccessKey: string,
    region: string,
    sessionToken?: string
): Record<string, string> {
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const payloadHash = "UNSIGNED-PAYLOAD";
    const headers: Record<string, string> = {
        host: url.host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        "x-amz-request-payer": "requester"
    };
    if (sessionToken) headers["x-amz-security-token"] = sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers).sort().map(key => `${key}:${headers[key].trim()}\n`).join("");
    const canonicalRequest = ["GET", canonicalUri(url.pathname), canonicalQuery(url.searchParams), canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
    const signature = hmacHex(getSignatureKey(secretAccessKey, dateStamp, region, "s3"), stringToSign);
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return headers;
}

function canonicalUri(pathname: string): string {
    return pathname.split("/").map(segment => encodeURIComponent(decodeURIComponent(segment))).join("/");
}

function canonicalQuery(params: URLSearchParams): string {
    return Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
}

function toAmzDate(date: Date): string {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256(input: string): string {
    return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function hmac(key: Buffer | string, input: string): Buffer {
    return crypto.createHmac("sha256", key).update(input, "utf8").digest();
}

function hmacHex(key: Buffer | string, input: string): string {
    return crypto.createHmac("sha256", key).update(input, "utf8").digest("hex");
}

function getSignatureKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, "aws4_request");
}

async function runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

function positiveInt(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value as number));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
