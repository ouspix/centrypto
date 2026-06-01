import path from "path";
import { PrismaClient } from "@prisma/market-client";
import { AgentConfig } from "@/lib/agent-config";
import { ScreenerConfig } from "@/lib/screener-config";
import { AccountState, MarketEntry, StateSnapshot } from "@/types/snapshot";
import { EnrichedMarketData, ScreenerService } from "@/services/ScreenerService";
import { BacktestSnapshot, CoverageReport, ExecutionBookSnapshot, ForwardOutcome, MarketFeatureRow } from "./BacktestTypes";
import { ExecutionBookStore } from "./ExecutionBookStore";
import { FeatureStore } from "./FeatureStore";
import { createBacktestDbClient, ensureBacktestDbSchema } from "./BacktestDb";

type DbClient = Pick<PrismaClient, "$queryRawUnsafe">;

type TickRow = {
    ts: Date | string;
    symbol: string;
    markPrice: number;
    indexPrice?: number | null;
    openInterest?: number | null;
    fundingRate?: number | null;
    volume24h?: number | null;
};

export type BacktestCandle = {
    symbol: string;
    openTime: Date | string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    source?: string | null;
};

export type BacktestDataSourceOptions = {
    network: "mainnet" | "testnet";
    start: Date;
    end: Date;
    intervalSeconds: number;
    agentConfig: AgentConfig;
    screenerConfig: ScreenerConfig;
    featureDbPath?: string;
    cache?: boolean;
    universeSymbols?: string[];
    loadExecutionBooks?: boolean;
};

type BacktestDataSourceDataset = {
    rowsByTimestamp: Map<number, MarketFeatureRow[]>;
    outcomeRowsBySymbol: Map<string, MarketFeatureRow[]>;
    booksBySymbol: Map<string, ExecutionBookSnapshot[]>;
    ticksBySymbol: Map<string, TickRow[]>;
    candlesBySymbol: Map<string, BacktestCandle[]>;
    timestamps: Date[];
    coverage: CoverageReport;
};

const datasetCache = new Map<string, Promise<BacktestDataSourceDataset>>();
const DATASET_CACHE_MAX_ENTRIES = positiveInt(Number(process.env.BACKTEST_DATA_SOURCE_CACHE_MAX_ENTRIES), 1);
const DATA_SOURCE_QUERY_CHUNK_MS = positiveInt(Number(process.env.BACKTEST_DATA_SOURCE_QUERY_CHUNK_MINUTES), 60) * 60_000;
const DATA_SOURCE_QUERY_ROW_LIMIT = positiveInt(Number(process.env.BACKTEST_DATA_SOURCE_QUERY_ROW_LIMIT), 10000);

export class BacktestDataSource {
    private readonly rowsByTimestamp: Map<number, MarketFeatureRow[]>;
    private readonly outcomeRowsBySymbol: Map<string, MarketFeatureRow[]>;
    private readonly booksBySymbol: Map<string, ExecutionBookSnapshot[]>;
    private readonly ticksBySymbol: Map<string, TickRow[]>;
    private readonly candlesBySymbol: Map<string, BacktestCandle[]>;
    private readonly timestamps: Date[];
    private readonly coverage: CoverageReport;
    private snapshotId = 0;
    private readonly screener: ScreenerService;

    private constructor(
        private readonly options: BacktestDataSourceOptions,
        dataset: BacktestDataSourceDataset
    ) {
        this.screener = new ScreenerService(options.network === "testnet", { disableLive: true });
        this.rowsByTimestamp = dataset.rowsByTimestamp;
        this.outcomeRowsBySymbol = dataset.outcomeRowsBySymbol;
        this.booksBySymbol = dataset.booksBySymbol;
        this.ticksBySymbol = dataset.ticksBySymbol;
        this.candlesBySymbol = dataset.candlesBySymbol;
        this.timestamps = dataset.timestamps;
        this.coverage = dataset.coverage;
    }

    public static async create(options: BacktestDataSourceOptions): Promise<BacktestDataSource> {
        const dataset = options.cache
            ? await cachedDataset(options)
            : await loadDataset(options);
        return new BacktestDataSource(options, dataset);
    }

    public getTimestamps(): Date[] {
        return [...this.timestamps];
    }

    public getCoverageReport(): CoverageReport {
        return this.coverage;
    }

    public getSnapshot(ts: Date, account: AccountState, markets: Record<string, MarketEntry> = this.getMarkets(ts)): BacktestSnapshot {
        const state: StateSnapshot = {
            timestamp: Math.floor(ts.getTime() / 1000),
            account,
            markets,
            constraints: {
                max_position_pct_equity: this.options.agentConfig.risk.max_position_fraction,
                max_position_pct_equity_per_symbol: this.options.agentConfig.risk.max_position_fraction_per_symbol,
                max_total_exposure_pct_equity: this.options.agentConfig.risk.max_total_exposure_fraction,
                min_trade_notional_usd: Math.max(
                    this.options.agentConfig.risk.min_trade_notional_usd,
                    this.options.agentConfig.network_profiles[this.options.network].min_notional_usd
                ),
                kill_switch: account.daily_total_pnl_usd !== undefined &&
                    account.daily_total_pnl_usd <= -(account.equity_usd * this.options.agentConfig.risk.daily_loss_kill_switch_fraction),
                no_flip_same_tick: this.options.agentConfig.risk.no_flip_same_tick,
                max_new_positions_per_cycle: this.options.agentConfig.risk.max_new_positions_per_cycle,
                daily_loss_kill_switch_fraction: this.options.agentConfig.risk.daily_loss_kill_switch_fraction,
                max_new_trades_allowed: Math.min(
                    account.derived_portfolio?.slots_remaining ?? this.options.agentConfig.risk.max_new_positions_per_cycle,
                    this.options.agentConfig.risk.max_new_positions_per_cycle
                )
            },
            allowed_actions: ["OPEN_POSITION", "REDUCE_POSITION", "CLOSE_POSITION", "HOLD_POSITION", "SKIP"],
            meta: {
                note: "Generated by BacktestDataSource",
                snapshot_id: ++this.snapshotId,
                regime_markets: Object.keys(markets)
            },
            presets: {
                screening: this.options.screenerConfig,
                agent: this.options.agentConfig
            },
            global_regime: { current: "CHOP", score: 0, reason: "not inferred yet" }
        };

        return {
            snapshot_id: this.snapshotId,
            timestamp: state.timestamp,
            markets,
            state
        };
    }

    public getMarkets(ts: Date, heldSymbols: string[] = []): Record<string, MarketEntry> {
        const rows = this.rowsByTimestamp.get(ts.getTime()) ?? [];
        const markets: Record<string, MarketEntry> = {};
        const enriched: EnrichedMarketData[] = [];
        const rowBySymbol = new Map<string, MarketFeatureRow>();

        for (const row of rows) {
            if (!hasMinimumHistory(row)) continue;
            const tick = this.findTick(row.symbol, ts);
            const candidate = mapFeatureToEnriched(row, tick, this.options.network === "testnet");
            if (!candidate) continue;
            enriched.push(candidate);
            rowBySymbol.set(toPerpSymbol(candidate.symbol), row);
        }

        const cfg = this.options.screenerConfig;
        const screenerHeldSymbols = heldSymbols.map(baseSymbol);
        const screened = this.screener.discoverAndRank(
            enriched,
            screenerHeldSymbols,
            cfg,
            this.options.agentConfig
        );

        for (const candidate of screened) {
            const row = rowBySymbol.get(toPerpSymbol(candidate.symbol));
            if (!row) continue;
            const market = mapFeatureToMarketEntry(row, this.findTick(row.symbol, ts));
            if (market) {
                market.discovery = {
                    reasons: candidate.discoveryReasons,
                    metrics: candidate.discoveryMetrics
                };
                market.execution = candidate.execution;
                markets[market.symbol] = market;
            }
        }
        return markets;
    }

    public getCandles(symbol: string, startExclusive: Date, endInclusive: Date): BacktestCandle[] {
        const rows = this.candlesBySymbol.get(toPerpSymbol(symbol)) ?? [];
        const startMs = startExclusive.getTime();
        const endMs = endInclusive.getTime();
        const realMinutes = realCandleMinutes(rows);
        const realCloseTimes = realCandleCloseTimes(rows);
        const selected = rows.filter(row => {
            const openTs = asDate(row.openTime).getTime();
            if (isRealMinuteCandle(row)) {
                const closeTs = openTs + 60_000;
                return closeTs > startMs && closeTs <= endMs;
            }
            if (isRealCandle(row)) return false;

            if (realMinutes.has(floorMinute(openTs)) || realCloseTimes.has(openTs)) return false;
            return openTs > startMs && openTs <= endMs;
        });

        return selected
            .map(row => isRealMinuteCandle(row)
                ? { ...row, openTime: new Date(asDate(row.openTime).getTime() + 60_000) }
                : row
            )
            .sort((a, b) => asDate(a.openTime).getTime() - asDate(b.openTime).getTime());
    }

    public getForwardOutcome(symbol: string, ts: Date, side: "long" | "short" | null = null): ForwardOutcome {
        const rows = this.outcomeRowsBySymbol.get(toPerpSymbol(symbol)) ?? [];
        const current = findFeatureAtOrBefore(rows, ts);
        if (!current || current.mid_price <= 0) return emptyForwardOutcome();

        const outcomeAt = (minutes: number) => {
            const future = findFeatureAtOrAfter(rows, new Date(ts.getTime() + minutes * 60_000));
            return future ? signedReturnBps(current.mid_price, future.mid_price, side) : null;
        };

        const windowEnd = ts.getTime() + 15 * 60_000;
        const window = rows.filter(row => row.ts.getTime() > ts.getTime() && row.ts.getTime() <= windowEnd);
        if (window.length === 0) {
            return {
                outcome_5m_bps: outcomeAt(5),
                outcome_15m_bps: outcomeAt(15),
                outcome_1h_bps: outcomeAt(60),
                mfe_15m_bps: null,
                mae_15m_bps: null
            };
        }

        const high = Math.max(...window.map(row => row.mid_price));
        const low = Math.min(...window.map(row => row.mid_price));
        const longMfe = 10000 * (high / current.mid_price - 1);
        const longMae = 10000 * (low / current.mid_price - 1);
        const shortMfe = 10000 * (1 - low / current.mid_price);
        const shortMae = 10000 * (1 - high / current.mid_price);

        return {
            outcome_5m_bps: outcomeAt(5),
            outcome_15m_bps: outcomeAt(15),
            outcome_1h_bps: outcomeAt(60),
            mfe_15m_bps: side === "short" ? shortMfe : longMfe,
            mae_15m_bps: side === "short" ? shortMae : longMae
        };
    }

    public getExecutionBook(symbol: string, ts: Date): ExecutionBookSnapshot | null {
        const rows = this.booksBySymbol.get(toPerpSymbol(symbol)) ?? [];
        return findExecutionBookAtOrBefore(rows, ts, this.options.intervalSeconds * 1000 * 2);
    }

    private findTick(symbol: string, ts: Date): TickRow | undefined {
        const ticks = this.ticksBySymbol.get(toPerpSymbol(symbol)) ?? [];
        const tsMs = ts.getTime();
        let best: TickRow | undefined;
        for (const tick of ticks) {
            if (asDate(tick.ts).getTime() > tsMs) break;
            best = tick;
        }
        return best;
    }
}

function indexDataset(
    coverage: CoverageReport,
    rows: MarketFeatureRow[],
    ticks: TickRow[],
    candles: BacktestCandle[],
    outcomeRows: MarketFeatureRow[],
    books: ExecutionBookSnapshot[]
): BacktestDataSourceDataset {
    const rowsByTimestamp = new Map<number, MarketFeatureRow[]>();
    const outcomeRowsBySymbol = new Map<string, MarketFeatureRow[]>();
    const booksBySymbol = new Map<string, ExecutionBookSnapshot[]>();
    const ticksBySymbol = new Map<string, TickRow[]>();
    const candlesBySymbol = new Map<string, BacktestCandle[]>();

    for (const row of rows) {
        const key = row.ts.getTime();
        const bucket = rowsByTimestamp.get(key) ?? [];
        bucket.push(row);
        rowsByTimestamp.set(key, bucket);
    }
    for (const row of outcomeRows) {
        const key = toPerpSymbol(row.symbol);
        const bucket = outcomeRowsBySymbol.get(key) ?? [];
        bucket.push(row);
        outcomeRowsBySymbol.set(key, bucket);
    }
    for (const [symbol, bucket] of outcomeRowsBySymbol) {
        bucket.sort((a, b) => a.ts.getTime() - b.ts.getTime());
        outcomeRowsBySymbol.set(symbol, bucket);
    }
    for (const book of books) {
        const key = toPerpSymbol(book.symbol);
        const bucket = booksBySymbol.get(key) ?? [];
        bucket.push(book);
        booksBySymbol.set(key, bucket);
    }
    for (const [symbol, bucket] of booksBySymbol) {
        bucket.sort((a, b) => a.ts.getTime() - b.ts.getTime());
        booksBySymbol.set(symbol, bucket);
    }
    for (const tick of ticks) {
        const key = toPerpSymbol(tick.symbol);
        const bucket = ticksBySymbol.get(key) ?? [];
        bucket.push(tick);
        ticksBySymbol.set(key, bucket);
    }
    for (const [symbol, bucket] of ticksBySymbol) {
        bucket.sort((a, b) => asDate(a.ts).getTime() - asDate(b.ts).getTime());
        ticksBySymbol.set(symbol, bucket);
    }
    for (const candle of candles) {
        const key = toPerpSymbol(candle.symbol);
        const bucket = candlesBySymbol.get(key) ?? [];
        bucket.push(candle);
        candlesBySymbol.set(key, bucket);
    }
    for (const [symbol, bucket] of candlesBySymbol) {
        bucket.sort((a, b) => asDate(a.openTime).getTime() - asDate(b.openTime).getTime());
        candlesBySymbol.set(symbol, bucket);
    }

    return {
        rowsByTimestamp,
        outcomeRowsBySymbol,
        booksBySymbol,
        ticksBySymbol,
        candlesBySymbol,
        timestamps: Array.from(rowsByTimestamp.keys()).sort((a, b) => a - b).map(ts => new Date(ts)),
        coverage
    };
}

async function cachedDataset(options: BacktestDataSourceOptions): Promise<BacktestDataSourceDataset> {
    const key = datasetCacheKey(options);
    const cached = datasetCache.get(key);
    if (cached) return cached;

    const pending = loadDataset(options).catch(error => {
        datasetCache.delete(key);
        throw error;
    });
    datasetCache.set(key, pending);
    trimDatasetCache(key);
    return pending;
}

function trimDatasetCache(protectedKey: string): void {
    while (datasetCache.size > DATASET_CACHE_MAX_ENTRIES) {
        const oldestKey = datasetCache.keys().next().value as string | undefined;
        if (!oldestKey) return;
        if (oldestKey === protectedKey) return;
        datasetCache.delete(oldestKey);
    }
}

async function loadDataset(options: BacktestDataSourceOptions): Promise<BacktestDataSourceDataset> {
    const featureStore = new FeatureStore({
        dbPath: options.featureDbPath
    });
    const bookStore = new ExecutionBookStore({
        dbPath: options.featureDbPath
    });
    const db = createDb(options);
    try {
        await ensureBacktestDbSchema(db as PrismaClient);
        const featureSymbols = normalizeFeatureSymbols(options.universeSymbols);
        const outcomeRows = await featureStore.getRows(
            options.start,
            new Date(options.end.getTime() + 60 * 60_000),
            options.intervalSeconds,
            featureSymbols
        );
        const rows = outcomeRows.filter(row => row.ts >= options.start && row.ts <= options.end);

        const symbols = featureSymbols?.length
            ? featureSymbols.map(baseSymbol)
            : Array.from(new Set(rows.map(row => baseSymbol(row.symbol))));
        const loadExecutionBooks = options.loadExecutionBooks !== false;
        const books = loadExecutionBooks
            ? await bookStore.getBooks(options.start, options.end, options.intervalSeconds, featureSymbols)
            : [];
        const bookTimesBySymbol = loadExecutionBooks
            ? bookTimeSetsFromBooks(books)
            : await bookStore.getBookTimeSets(options.start, options.end, options.intervalSeconds, featureSymbols);
        const ticks = await loadTicks(db, options.start, options.end, symbols);
        const candles = await loadCandles(db, options.start, options.end, symbols);
        const coverage = buildCoverage(options, rows, candles, bookTimesBySymbol, symbols);

        return indexDataset(coverage, rows, ticks, candles, outcomeRows, books);
    } finally {
        await featureStore.close();
        await bookStore.close();
        await (db as PrismaClient).$disconnect?.();
    }
}

function datasetCacheKey(options: BacktestDataSourceOptions): string {
    const dbPath = options.featureDbPath
        ? path.resolve(process.cwd(), options.featureDbPath)
        : path.resolve(process.cwd(), "prisma/backtest.db");
    const symbols = normalizeFeatureSymbols(options.universeSymbols)?.join(",") ?? "*";
    return [
        dbPath,
        options.network,
        options.start.getTime(),
        options.end.getTime(),
        options.intervalSeconds,
        symbols,
        options.loadExecutionBooks === false ? "books:metadata" : "books:full"
    ].join("|");
}

function normalizeFeatureSymbols(symbols?: string[]): string[] | undefined {
    if (!symbols?.length) return undefined;
    return Array.from(new Set(symbols.map(toPerpSymbol))).sort();
}

function emptyForwardOutcome(): ForwardOutcome {
    return {
        outcome_5m_bps: null,
        outcome_15m_bps: null,
        outcome_1h_bps: null,
        mfe_15m_bps: null,
        mae_15m_bps: null
    };
}

function findFeatureAtOrBefore(rows: MarketFeatureRow[], ts: Date): MarketFeatureRow | null {
    const tsMs = ts.getTime();
    let best: MarketFeatureRow | null = null;
    for (const row of rows) {
        if (row.ts.getTime() > tsMs) break;
        best = row;
    }
    return best;
}

function findFeatureAtOrAfter(rows: MarketFeatureRow[], ts: Date): MarketFeatureRow | null {
    const tsMs = ts.getTime();
    for (const row of rows) {
        if (row.ts.getTime() >= tsMs) return row;
    }
    return null;
}

function signedReturnBps(current: number, future: number, side: "long" | "short" | null): number {
    if (side === "short") return 10000 * (1 - future / current);
    return 10000 * (future / current - 1);
}

function createDb(options: BacktestDataSourceOptions): DbClient {
    if (options.featureDbPath) {
        const dbPath = path.isAbsolute(options.featureDbPath)
            ? options.featureDbPath
            : path.join(process.cwd(), options.featureDbPath);
        return createBacktestDbClient(dbPath);
    }
    return createBacktestDbClient();
}

async function loadTicks(db: DbClient, start: Date, end: Date, symbols: string[]): Promise<TickRow[]> {
    if (symbols.length === 0) return [];
    const rows: TickRow[] = [];
    for (const chunk of dataSourceQueryChunks(new Date(start.getTime() - 60 * 60_000), end)) {
        const endOperator = chunk.final ? "<=" : "<";
        let afterTs: Date | null = null;
        let afterSymbol = "";
        while (true) {
            const cursorFilter = afterTs
                ? `AND ("ts" > ? OR ("ts" = ? AND "symbol" > ?))`
                : "";
            const page = await db.$queryRawUnsafe<TickRow[]>(
                `SELECT * FROM "MarketTick"
                 WHERE "ts" >= ? AND "ts" ${endOperator} ?
                 AND "symbol" IN (${symbols.map(() => "?").join(",")})
                 ${cursorFilter}
                 ORDER BY "ts" ASC, "symbol" ASC
                 LIMIT ?`,
                chunk.start,
                chunk.end,
                ...symbols,
                ...(afterTs ? [afterTs, afterTs, afterSymbol] : []),
                DATA_SOURCE_QUERY_ROW_LIMIT
            );
            if (page.length === 0) break;
            rows.push(...page);
            const last = page[page.length - 1];
            afterTs = asDate(last.ts);
            afterSymbol = String(last.symbol);
            if (page.length < DATA_SOURCE_QUERY_ROW_LIMIT) break;
        }
    }
    return rows;
}

async function loadCandles(db: DbClient, start: Date, end: Date, symbols: string[]): Promise<BacktestCandle[]> {
    if (symbols.length === 0) return [];
    const rows: BacktestCandle[] = [];
    for (const chunk of dataSourceQueryChunks(start, end)) {
        const endOperator = chunk.final ? "<=" : "<";
        let afterOpenTime: Date | null = null;
        let afterSymbol = "";
        while (true) {
            const cursorFilter = afterOpenTime
                ? `AND ("openTime" > ? OR ("openTime" = ? AND "symbol" > ?))`
                : "";
            const page = await db.$queryRawUnsafe<BacktestCandle[]>(
                `SELECT "symbol", "openTime", "open", "high", "low", "close", "volume", "source" FROM "MarketCandle"
                 WHERE "timeframe" = '1m' AND "openTime" >= ? AND "openTime" ${endOperator} ?
                 AND "symbol" IN (${symbols.map(() => "?").join(",")})
                 ${cursorFilter}
                 ORDER BY "openTime" ASC, "symbol" ASC
                 LIMIT ?`,
                chunk.start,
                chunk.end,
                ...symbols,
                ...(afterOpenTime ? [afterOpenTime, afterOpenTime, afterSymbol] : []),
                DATA_SOURCE_QUERY_ROW_LIMIT
            );
            if (page.length === 0) break;
            rows.push(...page);
            const last = page[page.length - 1];
            afterOpenTime = asDate(last.openTime);
            afterSymbol = String(last.symbol);
            if (page.length < DATA_SOURCE_QUERY_ROW_LIMIT) break;
        }
    }
    return rows;
}

function dataSourceQueryChunks(start: Date, end: Date): Array<{ start: Date; end: Date; final: boolean }> {
    const chunks: Array<{ start: Date; end: Date; final: boolean }> = [];
    let cursorMs = start.getTime();
    const endMs = end.getTime();
    while (cursorMs <= endMs) {
        const chunkEndMs = Math.min(cursorMs + DATA_SOURCE_QUERY_CHUNK_MS, endMs);
        chunks.push({
            start: new Date(cursorMs),
            end: new Date(chunkEndMs),
            final: chunkEndMs >= endMs
        });
        if (chunkEndMs >= endMs) break;
        cursorMs = chunkEndMs;
    }
    return chunks;
}

function positiveInt(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value as number));
}

function buildCoverage(
    options: BacktestDataSourceOptions,
    rows: MarketFeatureRow[],
    candles: BacktestCandle[],
    bookTimesBySymbol: Map<string, Set<number>>,
    symbols: string[]
): CoverageReport {
    const expectedTimestamps = expectedReplayTimestamps(options.start, options.end, options.intervalSeconds);
    const timestamps = new Set(rows.map(row => row.ts.getTime()));
    const expectedSet = new Set(expectedTimestamps);
    const rowsBySymbol = new Map<string, Set<number>>();
    const dropped = new Set<string>();

    for (const row of rows) {
        const symbol = toPerpSymbol(row.symbol);
        const bucket = rowsBySymbol.get(symbol) ?? new Set<number>();
        bucket.add(row.ts.getTime());
        rowsBySymbol.set(symbol, bucket);
        if (!hasMinimumHistory(row)) dropped.add(row.symbol);
    }

    const missingFeatureRows: Record<string, number> = {};
    const missingExecutionBooks: Record<string, number> = {};
    for (const symbol of symbols) {
        const normalized = toPerpSymbol(symbol);
        const rowTimes = rowsBySymbol.get(normalized) ?? new Set<number>();
        missingFeatureRows[normalized] = expectedTimestamps.reduce((missing, ts) => missing + (rowTimes.has(ts) ? 0 : 1), 0);
    }

    for (const symbol of symbols) {
        const normalized = toPerpSymbol(symbol);
        const rowTimes = rowsBySymbol.get(normalized) ?? new Set<number>();
        const bookTimes = bookTimesBySymbol.get(normalized) ?? new Set<number>();
        missingExecutionBooks[normalized] = Array.from(rowTimes).reduce((missing, ts) => missing + (bookTimes.has(ts) ? 0 : 1), 0);
    }

    const candleCoverageBySymbol = buildCandleCoverageBySymbol(candles);
    let syntheticCandles = 0;
    let realCandles = 0;
    const missingCandleIntervals: CoverageReport["missing_candle_intervals"] = [];
    for (const symbol of symbols) {
        const normalized = toPerpSymbol(symbol);
        const rowTimes = rowsBySymbol.get(normalized) ?? new Set<number>();
        const candleCoverage = candleCoverageBySymbol.get(normalized) ?? {
            realMinutes: new Set<number>(),
            realCloseTimes: new Set<number>(),
            syntheticTimes: new Set<number>()
        };
        for (const ts of Array.from(rowTimes).sort((a, b) => a - b)) {
            if (!expectedSet.has(ts)) continue;
            const source = executionCandleSourceForTimestamp(candleCoverage, ts);
            if (source === "real_1m") {
                realCandles++;
            } else if (source === "synthetic_from_features") {
                syntheticCandles++;
            } else {
                missingCandleIntervals.push({
                    symbol: normalized,
                    start: new Date(ts).toISOString(),
                    end: new Date(ts + options.intervalSeconds * 1000).toISOString()
                });
            }
        }
    }

    const candleSource = classifyExecutionCandleSourceFromCounts(realCandles, syntheticCandles);

    return {
        expected_timestamps: expectedTimestamps.length,
        available_timestamps: timestamps.size,
        candle_source: candleSource,
        synthetic_execution_candles: syntheticCandles > 0,
        missing_feature_rows_by_symbol: missingFeatureRows,
        missing_execution_books_by_symbol: missingExecutionBooks,
        missing_candle_intervals: missingCandleIntervals.slice(0, 1000),
        symbols_dropped_insufficient_history: Array.from(dropped).sort(),
        skipped_timestamps: []
    };
}

function bookTimeSetsFromBooks(books: ExecutionBookSnapshot[]): Map<string, Set<number>> {
    const booksBySymbol = new Map<string, Set<number>>();
    for (const book of books) {
        const symbol = toPerpSymbol(book.symbol);
        const bucket = booksBySymbol.get(symbol) ?? new Set<number>();
        bucket.add(book.ts.getTime());
        booksBySymbol.set(symbol, bucket);
    }
    return booksBySymbol;
}

export function classifyExecutionCandleSource(candles: Array<Pick<BacktestCandle, "volume"> & { source?: string | null }>): CoverageReport["candle_source"] {
    let syntheticCandles = 0;
    let realCandles = 0;
    for (const candle of candles) {
        if (isSyntheticCandle(candle)) syntheticCandles++;
        else realCandles++;
    }
    return classifyExecutionCandleSourceFromCounts(realCandles, syntheticCandles);
}

function isRealCandle(candle: Pick<BacktestCandle, "volume"> & { source?: string | null }): boolean {
    if (candle.source === "real_1m") return true;
    if (candle.source === "synthetic_from_features") return false;
    return Number(candle.volume) !== 0;
}

function isSyntheticCandle(candle: Pick<BacktestCandle, "volume"> & { source?: string | null }): boolean {
    if (candle.source === "synthetic_from_features") return true;
    if (candle.source === "real_1m") return false;
    return Number(candle.volume) === 0;
}

function buildCandleCoverageBySymbol(candles: BacktestCandle[]): Map<string, { realMinutes: Set<number>; realCloseTimes: Set<number>; syntheticTimes: Set<number> }> {
    const bySymbol = new Map<string, { realMinutes: Set<number>; realCloseTimes: Set<number>; syntheticTimes: Set<number> }>();
    for (const candle of candles) {
        const symbol = toPerpSymbol(candle.symbol);
        const bucket = bySymbol.get(symbol) ?? { realMinutes: new Set<number>(), realCloseTimes: new Set<number>(), syntheticTimes: new Set<number>() };
        const openTs = asDate(candle.openTime).getTime();
        if (isRealMinuteCandle(candle)) {
            bucket.realMinutes.add(floorMinute(openTs));
            bucket.realCloseTimes.add(openTs + 60_000);
        } else if (isSyntheticCandle(candle)) {
            bucket.syntheticTimes.add(openTs);
        }
        bySymbol.set(symbol, bucket);
    }
    return bySymbol;
}

function executionCandleSourceForTimestamp(
    coverage: { realMinutes: Set<number>; realCloseTimes: Set<number>; syntheticTimes: Set<number> },
    ts: number
): CoverageReport["candle_source"] | null {
    if (coverage.realCloseTimes.has(ts) || coverage.realMinutes.has(floorMinute(ts))) return "real_1m";
    if (coverage.syntheticTimes.has(ts)) return "synthetic_from_features";
    return null;
}

function realCandleMinutes(candles: BacktestCandle[]): Set<number> {
    const minutes = new Set<number>();
    for (const candle of candles) {
        if (isRealMinuteCandle(candle)) minutes.add(floorMinute(asDate(candle.openTime).getTime()));
    }
    return minutes;
}

function realCandleCloseTimes(candles: BacktestCandle[]): Set<number> {
    const closeTimes = new Set<number>();
    for (const candle of candles) {
        if (isRealMinuteCandle(candle)) closeTimes.add(asDate(candle.openTime).getTime() + 60_000);
    }
    return closeTimes;
}

function isRealMinuteCandle(candle: BacktestCandle): boolean {
    const openTs = asDate(candle.openTime).getTime();
    return isRealCandle(candle) && openTs % 60_000 === 0;
}

function floorMinute(ts: number): number {
    return Math.floor(ts / 60_000) * 60_000;
}

function classifyExecutionCandleSourceFromCounts(realCandles: number, syntheticCandles: number): CoverageReport["candle_source"] {
    if (syntheticCandles > 0 && realCandles > 0) return "mixed";
    if (syntheticCandles > 0) return "synthetic_from_features";
    return "real_1m";
}

function expectedReplayTimestamps(start: Date, end: Date, intervalSeconds: number): number[] {
    const intervalMs = intervalSeconds * 1000;
    const first = Math.ceil(start.getTime() / intervalMs) * intervalMs;
    const last = Math.floor(end.getTime() / intervalMs) * intervalMs;
    const timestamps: number[] = [];
    for (let ts = first; ts <= last; ts += intervalMs) {
        timestamps.push(ts);
    }
    return timestamps;
}

function findExecutionBookAtOrBefore(rows: ExecutionBookSnapshot[], ts: Date, maxAgeMs: number): ExecutionBookSnapshot | null {
    const tsMs = ts.getTime();
    let best: ExecutionBookSnapshot | null = null;
    for (const row of rows) {
        if (row.ts.getTime() > tsMs) break;
        best = row;
    }
    if (!best || tsMs - best.ts.getTime() > maxAgeMs) return null;
    return best;
}

function hasMinimumHistory(row: MarketFeatureRow): boolean {
    return row.ret_15m !== null &&
        row.ret_1h !== null &&
        row.vol_ratio_5m_vs_1h !== null &&
        row.ret_sigma_5m_vs_1h !== null;
}

function mapFeatureToMarketEntry(row: MarketFeatureRow, tick?: TickRow): MarketEntry | null {
    if (row.best_bid <= 0 || row.best_ask <= 0 || row.mid_price <= 0) return null;
    const ret5 = row.ret_5m ?? 0;
    const ret15 = row.ret_15m ?? 0;
    const ret1h = row.ret_1h ?? 0;
    const ret4h = row.ret_4h ?? ret1h;
    const realized5m = row.realized_vol_5m ?? 0;
    const realized1h = row.realized_vol_1h ?? 0;

    return {
        symbol: row.symbol,
        price: row.mid_price,
        spread_bps: row.spread_bps,
        orderbook: {
            best_bid: row.best_bid,
            best_ask: row.best_ask,
            mid: row.mid_price,
            book_pressure: row.book_pressure_10bps,
            bid_liquidity_usd: row.bid_depth_10bps_usd,
            ask_liquidity_usd: row.ask_depth_10bps_usd,
            depth_bands_usd: mapBacktestDepthBands(row)
        },
        returns: {
            m5: ret5,
            m15: ret15,
            h1: ret1h,
            h4: ret4h
        },
        realized_vol: {
            m1: realized5m,
            m5: realized5m,
            m15: realized5m,
            h1: realized1h,
            h4: realized1h
        },
        atr_pct: {
            m5: Math.max(realized5m, Math.abs(ret5)),
            h1: Math.max(realized1h, Math.abs(ret1h))
        },
        volume_zscores: {
            v1m_vs_1h: 0,
            v5m_vs_1h: 0,
            v15m_vs_1h: 0
        },
        vol_zscores: {
            vol_5m_vs_1h: row.vol_ratio_5m_vs_1h ?? 0,
            ret_5m_vs_1h: row.ret_sigma_5m_vs_1h ?? 0
        },
        funding: {
            current_8h: tick?.fundingRate ?? 0
        },
        open_interest: {
            current: tick?.openInterest ?? 0
        },
        sentiment: {
            score: 0,
            mentionsVsBaseline: 0,
            disagreement: 0,
            change2h: 0
        },
        high_low: {
            is_new_high_1h: false,
            is_new_low_1h: false
        },
        bbands: {
            m5: { width: 0 }
        },
        volume24h: tick?.volume24h ?? 0,
        data_source: "backtest_market_feature"
    };
}

function mapFeatureToEnriched(row: MarketFeatureRow, tick: TickRow | undefined, isTestnet: boolean): EnrichedMarketData | null {
    if (row.best_bid <= 0 || row.best_ask <= 0 || row.mid_price <= 0) return null;
    return {
        symbol: baseSymbol(row.symbol),
        price: row.mid_price,
        volume24h: tick?.volume24h ?? 0,
        funding: tick?.fundingRate ?? 0,
        openInterest: tick?.openInterest ?? 0,
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
            depth_usd: mapBacktestOnePercentDepth(row),
            imbalance: row.book_pressure_10bps,
            book_pressure: row.book_pressure_10bps,
            cost_bps: row.cost_bps_100 ?? row.spread_bps,
            depth_bands_usd: mapBacktestDepthBands(row)
        },
        sentiment: { score: 0, mentions_vs_baseline: 0, disagreement: 0, change_2h: 0 },
        isTestnet,
        score: 0
    } as EnrichedMarketData;
}

export function mapBacktestDepthBands(row: Pick<MarketFeatureRow,
    "bid_depth_5bps_usd" |
    "ask_depth_5bps_usd" |
    "bid_depth_10bps_usd" |
    "ask_depth_10bps_usd" |
    "bid_depth_25bps_usd" |
    "ask_depth_25bps_usd"
>): { bid: Record<string, number>; ask: Record<string, number> } {
    return {
        bid: {
            "0.05": row.bid_depth_5bps_usd,
            "0.10": row.bid_depth_10bps_usd,
            "0.25": row.bid_depth_25bps_usd
        },
        ask: {
            "0.05": row.ask_depth_5bps_usd,
            "0.10": row.ask_depth_10bps_usd,
            "0.25": row.ask_depth_25bps_usd
        }
    };
}

export function mapBacktestOnePercentDepth(row: Pick<MarketFeatureRow,
    "bid_depth_25bps_usd" |
    "ask_depth_25bps_usd" |
    "bid_depth_10bps_usd" |
    "ask_depth_10bps_usd" |
    "bid_depth_5bps_usd" |
    "ask_depth_5bps_usd"
>): {
    bid_1pct: number;
    ask_1pct: number;
    proxy_source: "deepest_available_historical_depth_band";
    proxy_band_pct: string;
} {
    const bands: Array<{ pct: string; bid: number; ask: number }> = [
        { pct: "0.25", bid: row.bid_depth_25bps_usd, ask: row.ask_depth_25bps_usd },
        { pct: "0.10", bid: row.bid_depth_10bps_usd, ask: row.ask_depth_10bps_usd },
        { pct: "0.05", bid: row.bid_depth_5bps_usd, ask: row.ask_depth_5bps_usd }
    ];
    const deepest = bands.find(band => band.bid > 0 && band.ask > 0) ??
        bands.find(band => band.bid > 0 || band.ask > 0) ??
        bands[0];
    return {
        bid_1pct: deepest.bid,
        ask_1pct: deepest.ask,
        proxy_source: "deepest_available_historical_depth_band",
        proxy_band_pct: deepest.pct
    };
}

function asDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}

function toPerpSymbol(symbol: string): string {
    return symbol.endsWith("-PERP") ? symbol : `${symbol}-PERP`;
}

function baseSymbol(symbol: string): string {
    return symbol.replace(/-PERP$/, "");
}
