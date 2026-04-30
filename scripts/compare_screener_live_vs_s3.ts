import { AGENT_PRESETS, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { DEFAULT_SCREENER_CONFIG, SCREENER_PRESETS, ScreenerConfig } from "@/lib/screener-config";
import { OrderBookMetrics } from "@/services/MarketAnalysisService";
import { EnrichedMarketData, ScreenerService, ScreenedSymbol } from "@/services/ScreenerService";
import { hydrateArchiveForBacktest } from "@/src/backtest/ArchiveHydrator";
import { createBacktestDbClient, ensureBacktestDbSchema } from "@/src/backtest/BacktestDb";
import { FeatureStore } from "@/src/backtest/FeatureStore";
import { MarketFeatureRow } from "@/src/backtest/BacktestTypes";

type Network = "mainnet" | "testnet";

type TickRow = {
    ts: Date | string;
    symbol: string;
    markPrice: number;
    indexPrice?: number | null;
    openInterest?: number | null;
    fundingRate?: number | null;
    volume24h?: number | null;
    bookBidPx?: number | null;
    bookAskPx?: number | null;
};

type CandleRow = {
    symbol: string;
    openTime: Date | string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

type LayerResult = {
    timestamp: Date;
    universe: EnrichedMarketData[];
    activity: EnrichedMarketData[];
    liquidity: EnrichedMarketData[];
    ranked: ScreenedSymbol[];
};

type Summary = {
    source: "live_db" | "s3_archive";
    snapshots: number;
    avgUniverse: number;
    avgActivity: number;
    avgLiquidity: number;
    avgRanked: number;
    selectedCounts: Record<string, number>;
    avgRank: Record<string, number>;
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const network = (args.network ?? "mainnet") as Network;
    const intervalSeconds = Number(args["interval-seconds"] ?? 60);
    const start = args.start ? new Date(args.start) : previousFullUtcHour();
    const end = args.end ? new Date(args.end) : new Date(start.getTime() + 60 * 60_000 - intervalSeconds * 1000);
    const dbPath = args.db ?? "prisma/backtest-compare.db";
    const top = Number(args.top ?? 12);
    const screeningPreset = args.screening ?? "Momentum Moderate";
    const screenerConfig = applyConfigOverrides(
        SCREENER_PRESETS[screeningPreset] ?? DEFAULT_SCREENER_CONFIG,
        args
    );
    const agentConfig = AGENT_PRESETS[args.agent ?? "Momentum Moderate"] ?? DEFAULT_AGENT_CONFIG;

    assertValidWindow(start, end, intervalSeconds);

    const symbols = args.symbols
        ? parseSymbols(args.symbols)
        : await inferSymbols(network, start, end, Math.max(top, screenerConfig.topN));

    if (symbols.length === 0) {
        throw new Error("No symbols available. Pass --symbols BTC,ETH,SOL or collect live ticks for the window first.");
    }

    if (args.hydrate !== "false") {
        await hydrateArchiveForBacktest({
            start,
            end,
            symbols,
            intervalSeconds,
            dbPath,
            lookbackHours: Number(args["lookback-hours"] ?? 1),
            tmpRoot: args["tmp-root"],
            keepTmp: args["keep-tmp"] === "true"
        });
    }

    const timestamps = buildTimestamps(start, end, intervalSeconds);
    const liveRows = await buildLiveLayerResults(network, symbols, timestamps, screenerConfig);
    const s3Rows = args["s3-no-l2"] === "true"
        ? await buildS3NoL2LayerResults(network, dbPath, symbols, timestamps, screenerConfig)
        : await buildS3LayerResults(network, dbPath, start, end, intervalSeconds, screenerConfig);
    const comparison = compareResults(liveRows, s3Rows, top);

    console.log(JSON.stringify({
        window: {
            start: start.toISOString(),
            end: end.toISOString(),
            intervalSeconds,
            network,
            symbols
        },
        config: {
            screeningPreset,
            topN: screenerConfig.topN,
            agent: agentConfig.preset_name ?? args.agent ?? "Momentum Moderate"
        },
        notes: [
            "live_db liquidity uses MarketTick bookBidPx/bookAskPx only; historical live DB does not contain full L2 depth.",
            "s3_archive liquidity uses backtester MarketFeature rows built from Hyperliquid S3 L2 snapshots."
        ],
        summaries: [
            summarize("live_db", liveRows),
            summarize("s3_archive", s3Rows)
        ],
        comparison
    }, null, 2));
}

async function buildLiveLayerResults(
    network: Network,
    symbols: string[],
    timestamps: Date[],
    config: ScreenerConfig
): Promise<LayerResult[]> {
    const db = network === "testnet" ? marketDbTest : marketDbMain;
    const start = timestamps[0];
    const end = timestamps[timestamps.length - 1];
    const candles = await db.marketCandle.findMany({
        where: {
            symbol: { in: symbols },
            timeframe: "1m",
            openTime: {
                gte: new Date(start.getTime() - 4 * 60 * 60_000),
                lte: end
            }
        },
        orderBy: [{ symbol: "asc" }, { openTime: "asc" }]
    });
    const ticks = await db.marketTick.findMany({
        where: {
            symbol: { in: symbols },
            ts: {
                gte: new Date(start.getTime() - 60 * 60_000),
                lte: end
            }
        },
        orderBy: [{ symbol: "asc" }, { ts: "asc" }]
    });

    const candlesBySymbol = groupBySymbol(candles);
    const ticksBySymbol = groupBySymbol(ticks);
    const screener = new ScreenerService(network === "testnet", { disableLive: true });

    return timestamps.map(timestamp => {
        const candidates = symbols
            .map(symbol => liveCandidateAt(symbol, timestamp, candlesBySymbol.get(symbol) ?? [], ticksBySymbol.get(symbol) ?? [], network === "testnet"))
            .filter((candidate): candidate is EnrichedMarketData => Boolean(candidate));
        return applyLayers(screener, timestamp, candidates, config);
    });
}

async function buildS3LayerResults(
    network: Network,
    dbPath: string,
    start: Date,
    end: Date,
    intervalSeconds: number,
    config: ScreenerConfig
): Promise<LayerResult[]> {
    const store = new FeatureStore({ dbPath });
    const db = createBacktestDbClient(dbPath);
    try {
        await ensureBacktestDbSchema(db);
        const rows = await store.getRows(start, end, intervalSeconds);
        const symbols = Array.from(new Set(rows.map(row => baseSymbol(row.symbol))));
        const ticks = symbols.length
            ? await db.$queryRawUnsafe<TickRow[]>(
                `SELECT * FROM "MarketTick"
                 WHERE "ts" <= ? AND "ts" >= ?
                 AND "symbol" IN (${symbols.map(() => "?").join(",")})
                 ORDER BY "symbol" ASC, "ts" ASC`,
                end,
                new Date(start.getTime() - 60 * 60_000),
                ...symbols
            )
            : [];
        const ticksBySymbol = groupBySymbol(ticks);
        const rowsByTs = new Map<number, MarketFeatureRow[]>();
        for (const row of rows) {
            const bucket = rowsByTs.get(row.ts.getTime()) ?? [];
            bucket.push(row);
            rowsByTs.set(row.ts.getTime(), bucket);
        }

        const screener = new ScreenerService(network === "testnet", { disableLive: true });
        return Array.from(rowsByTs.keys()).sort((a, b) => a - b).map(ts => {
            const timestamp = new Date(ts);
            const candidates = (rowsByTs.get(ts) ?? [])
                .map(row => s3CandidateAt(row, findTickAtOrBefore(ticksBySymbol.get(baseSymbol(row.symbol)) ?? [], timestamp), network === "testnet"))
                .filter((candidate): candidate is EnrichedMarketData => Boolean(candidate));
            return applyLayers(screener, timestamp, candidates, config);
        });
    } finally {
        await store.close();
        await db.$disconnect();
    }
}

async function buildS3NoL2LayerResults(
    network: Network,
    dbPath: string,
    symbols: string[],
    timestamps: Date[],
    config: ScreenerConfig
): Promise<LayerResult[]> {
    const db = createBacktestDbClient(dbPath);
    try {
        await ensureBacktestDbSchema(db);
        const start = timestamps[0];
        const end = timestamps[timestamps.length - 1];
        const candles = symbols.length
            ? await db.$queryRawUnsafe<CandleRow[]>(
                `SELECT "symbol", "openTime", "open", "high", "low", "close", "volume"
                 FROM "MarketCandle"
                 WHERE "symbol" IN (${symbols.map(() => "?").join(",")})
                 AND "timeframe" = '1m'
                 AND "openTime" >= ? AND "openTime" <= ?
                 ORDER BY "symbol" ASC, "openTime" ASC`,
                ...symbols,
                new Date(start.getTime() - 4 * 60 * 60_000),
                end
            )
            : [];
        const ticks = symbols.length
            ? await db.$queryRawUnsafe<TickRow[]>(
                `SELECT *
                 FROM "MarketTick"
                 WHERE "symbol" IN (${symbols.map(() => "?").join(",")})
                 AND "ts" >= ? AND "ts" <= ?
                 ORDER BY "symbol" ASC, "ts" ASC`,
                ...symbols,
                new Date(start.getTime() - 60 * 60_000),
                end
            )
            : [];

        const candlesBySymbol = groupBySymbol(candles);
        const ticksBySymbol = groupBySymbol(ticks);
        const screener = new ScreenerService(network === "testnet", { disableLive: true });
        return timestamps.map(timestamp => {
            const candidates = symbols
                .map(symbol => liveCandidateAt(symbol, timestamp, candlesBySymbol.get(symbol) ?? [], ticksBySymbol.get(symbol) ?? [], network === "testnet"))
                .filter((candidate): candidate is EnrichedMarketData => Boolean(candidate));
            return applyLayers(screener, timestamp, candidates, config);
        });
    } finally {
        await db.$disconnect();
    }
}

function applyLayers(
    screener: ScreenerService,
    timestamp: Date,
    candidates: EnrichedMarketData[],
    config: ScreenerConfig
): LayerResult {
    const heldSymbols: string[] = [];
    const universe = config.layer1Enabled ? screener.filterByUniverse(candidates, heldSymbols, config) : candidates;
    const activity = config.layer3Enabled ? screener.filterByActivity(universe, heldSymbols, config) : universe;
    const liquidity = config.layer2Enabled ? screener.filterByLiquidity(activity, heldSymbols, config) : activity;
    const ranked = screener.scoreAndRank(liquidity, heldSymbols, config);
    return { timestamp, universe, activity, liquidity, ranked };
}

function liveCandidateAt(
    symbol: string,
    timestamp: Date,
    candles: CandleRow[],
    ticks: TickRow[],
    isTestnet: boolean
): EnrichedMarketData | null {
    const tick = findTickAtOrBefore(ticks, timestamp);
    const candleWindow = candles.filter(candle => asDate(candle.openTime) <= timestamp);
    if (!tick || candleWindow.length === 0) return null;
    const metrics = metricsFromCandles(candleWindow);
    const bid = Number(tick.bookBidPx ?? 0);
    const ask = Number(tick.bookAskPx ?? 0);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(tick.markPrice);
    return {
        symbol,
        price: Number(tick.markPrice),
        volume24h: Number(tick.volume24h ?? 0),
        funding: Number(tick.fundingRate ?? 0),
        openInterest: Number(tick.openInterest ?? 0),
        metrics,
        bookMetrics: bookFromBidAsk(bid, ask, mid),
        sentiment: emptySentiment(),
        isTestnet
    };
}

function s3CandidateAt(row: MarketFeatureRow, tick: TickRow | undefined, isTestnet: boolean): EnrichedMarketData | null {
    if (row.best_bid <= 0 || row.best_ask <= 0 || row.mid_price <= 0) return null;
    return {
        symbol: baseSymbol(row.symbol),
        price: row.mid_price,
        volume24h: Number(tick?.volume24h ?? 0),
        funding: Number(tick?.fundingRate ?? 0),
        openInterest: Number(tick?.openInterest ?? 0),
        metrics: {
            returns: {
                m1: row.ret_1m ?? 0,
                m5: row.ret_5m ?? 0,
                m15: row.ret_15m ?? 0,
                h1: row.ret_1h ?? 0,
                h4: row.ret_4h ?? 0
            },
            realized_vol: {
                m1: row.realized_vol_5m ?? 0,
                m5: row.realized_vol_5m ?? 0,
                m15: row.realized_vol_5m ?? 0,
                h1: row.realized_vol_1h ?? 0,
                h4: row.realized_vol_1h ?? 0
            },
            volume_zscores: { v1m_vs_1h: 0, v5m_vs_1h: 0, v15m_vs_1h: 0 },
            vol_zscores: {
                vol_5m_vs_1h: row.vol_ratio_5m_vs_1h ?? 0,
                ret_5m_vs_1h: row.ret_sigma_5m_vs_1h ?? 0
            },
            rsi: { m1: 50, m5: 50, m15: 50 },
            bbands: {
                m1: { upper: 0, middle: 0, lower: 0, width: 0 },
                m5: { upper: 0, middle: 0, lower: 0, width: 0 }
            },
            atr: { m5: 0, h1: 0 },
            atr_pct: {
                m5: Math.max(row.realized_vol_5m ?? 0, Math.abs(row.ret_5m ?? 0)),
                h1: Math.max(row.realized_vol_1h ?? 0, Math.abs(row.ret_1h ?? 0))
            },
            macd: {
                m5: { macd: 0, signal: 0, histogram: 0 },
                h1: { macd: 0, signal: 0, histogram: 0 }
            },
            high_low: { is_new_high_1h: false, is_new_low_1h: false },
            regime_tags: []
        },
        bookMetrics: {
            best_bid: row.best_bid,
            best_ask: row.best_ask,
            mid: row.mid_price,
            spread_bps: row.spread_bps,
            depth_usd: {
                bid_1pct: row.bid_depth_25bps_usd,
                ask_1pct: row.ask_depth_25bps_usd
            },
            imbalance: row.book_pressure_10bps,
            book_pressure: row.book_pressure_10bps,
            cost_bps: row.cost_bps_100 ?? row.spread_bps,
            depth_bands_usd: {
                bid: {
                    "0.05": row.bid_depth_5bps_usd,
                    "0.10": row.bid_depth_10bps_usd,
                    "0.25": row.bid_depth_25bps_usd,
                    "1.00": row.bid_depth_25bps_usd
                },
                ask: {
                    "0.05": row.ask_depth_5bps_usd,
                    "0.10": row.ask_depth_10bps_usd,
                    "0.25": row.ask_depth_25bps_usd,
                    "1.00": row.ask_depth_25bps_usd
                }
            }
        },
        sentiment: emptySentiment(),
        isTestnet
    };
}

function metricsFromCandles(candles: CandleRow[]): EnrichedMarketData["metrics"] {
    const current = candles[candles.length - 1];
    const close = Number(current.close);
    const returns = (minutes: number) => {
        if (candles.length <= minutes) return 0;
        const past = Number(candles[candles.length - 1 - minutes].close);
        return past > 0 ? close / past - 1 : 0;
    };
    const logReturns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = Number(candles[i - 1].close);
        const next = Number(candles[i].close);
        if (prev > 0 && next > 0) logReturns.push(Math.log(next / prev));
    }
    const vol = (window: number) => {
        if (logReturns.length < window) return 0;
        const slice = logReturns.slice(-window);
        const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length;
        const variance = slice.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / slice.length;
        return Math.sqrt(variance);
    };
    const ret5 = returns(5);
    const realizedM1 = vol(5);
    const realizedM5 = vol(15);
    const realizedH1 = vol(60);
    const vol1h = realizedH1 || 0.001;

    return {
        returns: {
            m1: Number(current.open) > 0 ? close / Number(current.open) - 1 : 0,
            m5: ret5,
            m15: returns(15),
            h1: returns(60),
            h4: returns(240)
        },
        realized_vol: {
            m1: realizedM1,
            m5: realizedM5,
            m15: vol(30),
            h1: realizedH1,
            h4: vol(240)
        },
        volume_zscores: { v1m_vs_1h: 0, v5m_vs_1h: 0, v15m_vs_1h: 0 },
        vol_zscores: {
            vol_5m_vs_1h: realizedM1 / vol1h,
            ret_5m_vs_1h: ret5 / vol1h
        },
        rsi: { m1: 50, m5: 50, m15: 50 },
        bbands: {
            m1: { upper: 0, middle: 0, lower: 0, width: 0 },
            m5: { upper: 0, middle: 0, lower: 0, width: 0 }
        },
        atr: { m5: 0, h1: 0 },
        atr_pct: {
            m5: Math.max(realizedM5, Math.abs(ret5)),
            h1: Math.max(realizedH1, Math.abs(returns(60)))
        },
        macd: {
            m5: { macd: 0, signal: 0, histogram: 0 },
            h1: { macd: 0, signal: 0, histogram: 0 }
        },
        high_low: { is_new_high_1h: false, is_new_low_1h: false },
        regime_tags: []
    };
}

function compareResults(liveRows: LayerResult[], s3Rows: LayerResult[], top: number) {
    const liveByTs = new Map(liveRows.map(row => [row.timestamp.getTime(), row]));
    const s3ByTs = new Map(s3Rows.map(row => [row.timestamp.getTime(), row]));
    const sharedTs = Array.from(liveByTs.keys()).filter(ts => s3ByTs.has(ts)).sort((a, b) => a - b);
    const samples = sharedTs.map(ts => {
        const live = liveByTs.get(ts)!;
        const s3 = s3ByTs.get(ts)!;
        const liveTop = live.ranked.slice(0, top).map(row => row.symbol);
        const s3Top = s3.ranked.slice(0, top).map(row => row.symbol);
        return {
            ts: new Date(ts).toISOString(),
            overlap: intersection(liveTop, s3Top).length,
            liveOnly: difference(liveTop, s3Top),
            s3Only: difference(s3Top, liveTop),
            liveTop,
            s3Top
        };
    });

    const overlap = samples.length
        ? samples.reduce((sum, sample) => sum + sample.overlap, 0) / samples.length
        : 0;

    return {
        sharedSnapshots: sharedTs.length,
        avgTopOverlap: round(overlap),
        avgTopOverlapPct: top > 0 ? round(100 * overlap / top) : 0,
        sampleChanges: samples.filter(sample => sample.liveOnly.length || sample.s3Only.length).slice(0, 20)
    };
}

function summarize(source: Summary["source"], rows: LayerResult[]): Summary {
    const selectedCounts = new Map<string, number>();
    const rankSums = new Map<string, number>();
    for (const row of rows) {
        row.ranked.forEach((candidate, index) => {
            selectedCounts.set(candidate.symbol, (selectedCounts.get(candidate.symbol) ?? 0) + 1);
            rankSums.set(candidate.symbol, (rankSums.get(candidate.symbol) ?? 0) + index + 1);
        });
    }
    const counts = Object.fromEntries(Array.from(selectedCounts.entries()).sort((a, b) => b[1] - a[1]));
    const avgRank = Object.fromEntries(Array.from(rankSums.entries())
        .map(([symbol, rankSum]) => [symbol, round(rankSum / (selectedCounts.get(symbol) ?? 1))])
        .sort((a, b) => Number(a[1]) - Number(b[1])));

    return {
        source,
        snapshots: rows.length,
        avgUniverse: average(rows.map(row => row.universe.length)),
        avgActivity: average(rows.map(row => row.activity.length)),
        avgLiquidity: average(rows.map(row => row.liquidity.length)),
        avgRanked: average(rows.map(row => row.ranked.length)),
        selectedCounts: counts,
        avgRank
    };
}

async function inferSymbols(network: Network, start: Date, end: Date, limit: number): Promise<string[]> {
    const db = network === "testnet" ? marketDbTest : marketDbMain;
    const rows = await db.marketTick.groupBy({
        by: ["symbol"],
        where: { ts: { gte: start, lte: end } },
        _max: { volume24h: true },
        orderBy: { _max: { volume24h: "desc" } },
        take: limit
    });
    return rows.map(row => row.symbol);
}

function bookFromBidAsk(bid: number, ask: number, fallbackMid: number): OrderBookMetrics {
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : fallbackMid;
    const spreadBps = bid > 0 && ask > 0 && mid > 0 ? 10000 * (ask - bid) / mid : 9999;
    return {
        best_bid: bid,
        best_ask: ask,
        mid,
        spread_bps: spreadBps,
        depth_usd: { bid_1pct: 0, ask_1pct: 0 },
        imbalance: 0,
        book_pressure: 0,
        cost_bps: spreadBps,
        depth_bands_usd: { bid: {}, ask: {} }
    };
}

function findTickAtOrBefore(ticks: TickRow[], timestamp: Date): TickRow | undefined {
    const ts = timestamp.getTime();
    let best: TickRow | undefined;
    for (const tick of ticks) {
        if (asDate(tick.ts).getTime() > ts) break;
        best = tick;
    }
    return best;
}

function groupBySymbol<T extends { symbol: string }>(rows: T[]): Map<string, T[]> {
    const result = new Map<string, T[]>();
    for (const row of rows) {
        const key = baseSymbol(row.symbol);
        const bucket = result.get(key) ?? [];
        bucket.push(row);
        result.set(key, bucket);
    }
    return result;
}

function buildTimestamps(start: Date, end: Date, intervalSeconds: number): Date[] {
    const intervalMs = intervalSeconds * 1000;
    const timestamps: Date[] = [];
    for (let ts = Math.ceil(start.getTime() / intervalMs) * intervalMs; ts <= end.getTime(); ts += intervalMs) {
        timestamps.push(new Date(ts));
    }
    return timestamps;
}

function previousFullUtcHour(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() - 1));
}

function parseArgs(argv: string[]): Record<string, string> {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        args[token.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
    return args;
}

function applyConfigOverrides(config: ScreenerConfig, args: Record<string, string>): ScreenerConfig {
    const next: ScreenerConfig = {
        ...config,
        quality_weights: { ...config.quality_weights },
        depthBandsPct: [...config.depthBandsPct]
    };

    if (args["disable-liquidity"] === "true") next.layer2Enabled = false;
    if (args["disable-activity"] === "true") next.layer3Enabled = false;
    if (args["disable-universe"] === "true") next.layer1Enabled = false;
    if (args["disable-scoring"] === "true") next.layer4Enabled = false;

    if (args["min-realized-vol"] !== undefined) next.minRealizedVol = Number(args["min-realized-vol"]);
    if (args["min-recent-volume"] !== undefined) next.minRecentVolume = Number(args["min-recent-volume"]);
    if (args["min-volume-24h"] !== undefined) next.minVolume24h = Number(args["min-volume-24h"]);
    if (args["max-spread-bps"] !== undefined) next.maxSpreadBps = Number(args["max-spread-bps"]);
    if (args["min-depth-usd"] !== undefined) next.minDepthUsd = Number(args["min-depth-usd"]);
    if (args["top-n"] !== undefined) next.topN = Number(args["top-n"]);

    return next;
}

function parseSymbols(value: string): string[] {
    return value.split(",").map(symbol => baseSymbol(symbol.trim())).filter(Boolean);
}

function assertValidWindow(start: Date, end: Date, intervalSeconds: number) {
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new Error("Invalid --start/--end");
    if (end <= start) throw new Error("--end must be after --start");
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) throw new Error("--interval-seconds must be positive");
    if (end.getTime() - start.getTime() > 65 * 60_000) throw new Error("This comparison is intentionally limited to about one hour.");
}

function asDate(value: Date | string | number): Date {
    return value instanceof Date ? value : new Date(value);
}

function baseSymbol(symbol: string): string {
    return symbol.replace(/-PERP$/, "");
}

function emptySentiment() {
    return { score: 0, mentionsVsBaseline: 0, disagreement: 0, change2h: 0 };
}

function average(values: number[]): number {
    if (values.length === 0) return 0;
    return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function intersection(a: string[], b: string[]): string[] {
    const bSet = new Set(b);
    return a.filter(value => bSet.has(value));
}

function difference(a: string[], b: string[]): string[] {
    const bSet = new Set(b);
    return a.filter(value => !bSet.has(value));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
