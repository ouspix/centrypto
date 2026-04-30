import fs from "fs/promises";
import os from "os";
import path from "path";
import { PrismaClient } from "@prisma/market-client";
import { describe, expect, it } from "vitest";
import { AGENT_PRESETS, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { SCREENER_PRESETS } from "@/lib/screener-config";
import { FeatureStore } from "@/src/backtest/FeatureStore";
import { buildMarketFeaturesFromSnapshots, parseHyperliquidL2File } from "@/src/backtest/L2FeatureBuilder";
import { BacktestDataSource, classifyExecutionCandleSource, mapBacktestDepthBands, mapBacktestOnePercentDepth } from "@/src/backtest/BacktestDataSource";
import { BacktestPortfolio } from "@/src/backtest/BacktestPortfolio";
import { BacktestRunner } from "@/src/backtest/BacktestRunner";
import { ExecutionSimulator } from "@/src/backtest/ExecutionSimulator";
import { ExecutionBookStore } from "@/src/backtest/ExecutionBookStore";
import { MetricsReporter } from "@/src/backtest/MetricsReporter";
import { RecordedLLMTrader, buildManagementPolicy, buildTraderPolicy } from "@/src/backtest/TraderPolicies";
import { acceptChallenger, aggregateScoredConfigs, configHash, optimizerRejectionReason, sampleRandomConfig, sampleRandomScreenerConfig, scoreMetrics } from "@/src/backtest/WalkForwardOptimizer";
import { BacktestMetrics, CoverageReport, L2BookSnapshot, MarketFeatureRow, SimPosition, SimTrade } from "@/src/backtest/BacktestTypes";
import { TradeDecision, TraderContext } from "@/types/trading";
import { deriveRealCandlesFromNodeFillsLines, getRealCandleCoverageReport, upsertRealCandles } from "@/src/backtest/RealCandleHydrator";
import { upsertSyntheticCandlesFromFeatures } from "@/src/backtest/ArchiveHydrator";
import { assertOptimizerCandlePreflight, hydrateBacktestDataForRun } from "@/src/backtest/BacktestHydration";
import { ensureBacktestDbSchema } from "@/src/backtest/BacktestDb";

describe("backtest stack", () => {
    it("parses Hyperliquid l2Book JSONL rows with object and tuple levels", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bt-l2-"));
        const file = path.join(dir, "BTC");
        await fs.writeFile(file, [
            JSON.stringify({ time: 1770000000000, levels: [[{ px: "100", sz: "2" }], [{ px: "101", sz: "3" }]] }),
            JSON.stringify({ data: { ts: 1770000001000, levels: [[["99", "1"]], [["102", "2"]]] } }),
            JSON.stringify({ time: 1770000002000, levels: [[], []] })
        ].join("\n"));

        const snapshots = await parseHyperliquidL2File(file, "BTC");

        expect(snapshots).toHaveLength(2);
        expect(snapshots[0].symbol).toBe("BTC");
        expect(snapshots[0].bids[0]).toEqual({ price: 100, size: 2 });
        expect(snapshots[1].asks[0]).toEqual({ price: 102, size: 2 });
    });

    it("computes spread, depth, pressure, slippage, and costs from L2 snapshots", () => {
        const snapshots: L2BookSnapshot[] = [{
            ts: new Date("2026-04-11T10:00:00Z"),
            symbol: "BTC",
            bids: [{ price: 100.4, size: 10 }, { price: 100.3, size: 10 }],
            asks: [{ price: 100.6, size: 10 }, { price: 100.7, size: 10 }]
        }];

        const rows = buildMarketFeaturesFromSnapshots(snapshots, { intervalSeconds: 10, takerFeeBps: 3.5 });

        expect(rows).toHaveLength(1);
        expect(rows[0].symbol).toBe("BTC-PERP");
        expect(rows[0].mid_price).toBe(100.5);
        expect(rows[0].spread_bps).toBeCloseTo(19.9005, 4);
        expect(rows[0].bid_depth_25bps_usd).toBe(2007);
        expect(rows[0].ask_depth_25bps_usd).toBe(2013);
        expect(rows[0].book_pressure_25bps).toBeCloseTo(-0.001493, 5);
        expect(rows[0].cost_bps_100).not.toBeNull();
    });

    it("does not timestamp L2-derived features before the source snapshot was observable", () => {
        const rows = buildMarketFeaturesFromSnapshots([{
            ts: new Date("2026-04-11T10:00:09Z"),
            symbol: "BTC",
            bids: [{ price: 100, size: 10 }],
            asks: [{ price: 101, size: 10 }]
        }], { intervalSeconds: 10 });

        expect(rows).toHaveLength(1);
        expect(rows[0].ts.toISOString()).toBe("2026-04-11T10:00:10.000Z");
    });

    it("does not use future ticks when mapping a historical snapshot", async () => {
        const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bt-db-")), "market.db");
        const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
        const store = new FeatureStore({ db });
        await store.ensureSchema();
        await createMarketTables(db);

        const ts = new Date("2026-04-11T10:00:00Z");
        await store.upsertRows([featureRow(ts, "BTC-PERP")]);
        await db.$executeRawUnsafe(
            `INSERT INTO "MarketTick" ("ts", "symbol", "markPrice", "openInterest", "fundingRate", "volume24h") VALUES (?, ?, ?, ?, ?, ?)`,
            new Date("2026-04-11T09:59:00Z"),
            "BTC",
            100,
            11,
            0.01,
            10_000_000
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "MarketTick" ("ts", "symbol", "markPrice", "openInterest", "fundingRate", "volume24h") VALUES (?, ?, ?, ?, ?, ?)`,
            new Date("2026-04-11T10:00:10Z"),
            "BTC",
            100,
            999,
            0.99,
            9999
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume") VALUES (?, '1m', ?, 100, 101, 99, 100, 1)`,
            "BTC",
            ts
        );

        const source = await BacktestDataSource.create({
            network: "mainnet",
            start: ts,
            end: ts,
            intervalSeconds: 10,
            agentConfig: DEFAULT_AGENT_CONFIG,
            screenerConfig: SCREENER_PRESETS["Testnet Aggressive"],
            featureDbPath: dbPath
        });
        const markets = source.getMarkets(ts);

        expect(markets["BTC-PERP"].funding.current_8h).toBe(0.01);
        expect(markets["BTC-PERP"].open_interest.current).toBe(11);
        await db.$disconnect();
    });

    it("keeps held symbols in historical market snapshots even when screener gates would drop them", async () => {
        const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bt-db-")), "market.db");
        const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
        const store = new FeatureStore({ db });
        await store.ensureSchema();
        await createMarketTables(db);

        const ts = new Date("2026-04-11T10:00:00Z");
        await store.upsertRows([featureRow(ts, "BTC-PERP")]);
        await db.$executeRawUnsafe(
            `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume") VALUES (?, '1m', ?, 100, 101, 99, 100, 1)`,
            "BTC",
            ts
        );

        const source = await BacktestDataSource.create({
            network: "mainnet",
            start: ts,
            end: ts,
            intervalSeconds: 10,
            agentConfig: DEFAULT_AGENT_CONFIG,
            screenerConfig: { ...SCREENER_PRESETS["Momentum Moderate"], minRealizedVol: 1 },
            featureDbPath: dbPath
        });

        expect(source.getMarkets(ts)["BTC-PERP"]).toBeUndefined();
        expect(source.getMarkets(ts, ["BTC-PERP"])["BTC-PERP"]).toBeDefined();
        await db.$disconnect();
    });

    it("overwrites synthetic execution candles with real 1m candles", async () => {
        const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bt-db-")), "market.db");
        const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
        await ensureBacktestDbSchema(db);
        const minute = new Date("2026-04-11T10:00:00Z");
        const tenSeconds = new Date("2026-04-11T10:00:10Z");
        for (const ts of [minute, tenSeconds]) {
            await db.$executeRawUnsafe(
                `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume")
                 VALUES ('BTC', '1m', ?, 100, 101, 99, 100, 0)`,
                ts
            );
        }

        await upsertRealCandles(db, "BTC", [{ t: minute.getTime(), o: 101, h: 105, l: 98, c: 104, v: 42 }]);

        const rows = await db.marketCandle.findMany({ where: { symbol: "BTC" }, orderBy: { openTime: "asc" } });
        expect(rows).toHaveLength(2);
        expect(rows.map(row => row.volume)).toEqual([42, 42]);
        expect(rows.map(row => row.close)).toEqual([104, 104]);
        await db.$disconnect();
    });

    it("derives real candles from node fills without double-counting both trade sides", () => {
        const start = new Date("2026-04-11T10:00:00Z");
        const end = new Date("2026-04-11T10:01:00Z");
        const lines = [
            JSON.stringify({
                block_time: "2026-04-11T10:00:12.000000000",
                events: [
                    ["0x1", { coin: "BTC", px: "100", sz: "2", side: "B", time: start.getTime() + 12_000, tid: 1 }],
                    ["0x2", { coin: "BTC", px: "100", sz: "2", side: "A", time: start.getTime() + 12_000, tid: 1 }],
                    ["0x3", { coin: "BTC", px: "99", sz: "1", side: "B", time: start.getTime() + 45_000, tid: 2 }],
                    ["0x4", { coin: "ETH", px: "2000", sz: "3", side: "B", time: start.getTime() + 45_000, tid: 3 }]
                ]
            }),
            JSON.stringify({
                block_time: "2026-04-11T10:01:05.000000000",
                events: [
                    ["0x5", { coin: "BTC", px: "101", sz: "0.5", side: "B", time: start.getTime() + 65_000, tid: 4 }]
                ]
            })
        ];

        const candles = deriveRealCandlesFromNodeFillsLines(lines, ["BTC"], start, end);

        expect(candles.BTC).toEqual([
            { t: start.getTime(), o: 100, h: 100, l: 99, c: 99, v: 3 },
            { t: start.getTime() + 60_000, o: 101, h: 101, l: 101, c: 101, v: 0.5 }
        ]);
        expect(candles.ETH).toBeUndefined();
    });

    it("counts zero-volume real candles as real coverage", async () => {
        const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bt-db-")), "market.db");
        const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
        await ensureBacktestDbSchema(db);
        const ts = new Date("2026-04-11T10:00:00Z");

        await upsertRealCandles(db, "BTC", [{ t: ts.getTime(), o: 100, h: 100, l: 100, c: 100, v: 0 }]);

        const coverage = await getRealCandleCoverageReport({
            symbols: ["BTC"],
            start: ts,
            end: ts,
            dbPath
        });
        const rows = await db.$queryRawUnsafe<Array<{ source: string | null; volume: number }>>(
            `SELECT "source", "volume" FROM "MarketCandle" WHERE "symbol" = 'BTC'`
        );

        expect(coverage.complete).toBe(true);
        expect(rows).toEqual([{ source: "real_1m", volume: 0 }]);
        await db.$disconnect();
    });

    it("does not let synthetic candles overwrite existing real candles", async () => {
        const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bt-db-")), "market.db");
        const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
        const store = new FeatureStore({ db });
        await store.ensureSchema();
        const ts = new Date("2026-04-11T10:00:00Z");
        await store.upsertRows([featureRow(ts, "BTC-PERP")]);
        await db.$executeRawUnsafe(
            `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume")
             VALUES ('BTC', '1m', ?, 90, 110, 80, 105, 99)`,
            ts
        );

        await upsertSyntheticCandlesFromFeatures({
            start: ts,
            end: ts,
            symbols: ["BTC"],
            intervalSeconds: 10,
            dbPath
        });

        const candle = await db.marketCandle.findFirstOrThrow({ where: { symbol: "BTC", openTime: ts } });
        expect(candle.volume).toBe(99);
        expect(candle.close).toBe(105);
        await store.close();
        await db.$disconnect();
    });

    it("hydrates real candles for the selected archive universe before optimizer runs", async () => {
        const start = new Date("2026-04-11T10:00:00Z");
        const end = new Date("2026-04-11T11:00:00Z");
        let realCandleSymbols: string[] = [];

        await hydrateBacktestDataForRun({
            hydrateArchive: false,
            hydrateRealCandles: true,
            network: "mainnet",
            preferNodeFillArchiveForRealCandles: true,
            archive: {
                start,
                end,
                intervalSeconds: 10,
                universeSize: 15
            }
        }, {
            hydrateArchive: async () => ({
                symbols: ["BTC", "ETH"],
                hydrateStart: start,
                hydrateEnd: end,
                syntheticCandlesInserted: 2
            }),
            hydrateRealCandles: async options => {
                realCandleSymbols = options.symbols;
                expect(options.preferNodeFillArchive).toBe(true);
                return {
                    symbols: options.symbols,
                    candlesFetched: 2,
                    candlesUpserted: 2,
                    coverage: { expectedMinutes: 61, missingBySymbol: {}, complete: true }
                };
            }
        });

        expect(realCandleSymbols).toEqual(["BTC", "ETH"]);
    });

    it("fails optimizer preflight before trials when synthetic candles remain and synthetic candles are disallowed", async () => {
        const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bt-db-")), "market.db");
        const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
        await ensureBacktestDbSchema(db);
        const ts = new Date("2026-04-11T10:00:00Z");
        await db.$executeRawUnsafe(
            `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume")
             VALUES ('BTC', '1m', ?, 100, 101, 99, 100, 0)`,
            ts
        );

        await expect(assertOptimizerCandlePreflight({
            dbPath,
            start: ts,
            end: ts,
            symbols: ["BTC"],
            hydrateRealCandlesRequested: false,
            scoreGates: {
                minTrades: 1,
                maxDrawdownBps: 1000,
                minProfitFactor: 0,
                maxStopHitRate: 1,
                maxSymbolConcentration: 1,
                maxRegimeConcentration: 1,
                allowSyntheticCandles: false
            }
        })).rejects.toThrow(/Synthetic execution candles remain/);
        await db.$disconnect();
    });

    it("includes candles whose open time equals the replay timestamp", async () => {
        const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bt-db-")), "market.db");
        const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
        const store = new FeatureStore({ db });
        await store.ensureSchema();

        const first = new Date("2026-04-11T10:00:00Z");
        const second = new Date("2026-04-11T10:01:00Z");
        await store.upsertRows([featureRow(first, "BTC-PERP"), featureRow(second, "BTC-PERP")]);
        for (const ts of [first, second]) {
            await db.$executeRawUnsafe(
                `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume") VALUES (?, '1m', ?, 100, 101, 99, 100, 0)`,
                "BTC",
                ts
            );
        }

        const source = await BacktestDataSource.create({
            network: "mainnet",
            start: first,
            end: second,
            intervalSeconds: 10,
            agentConfig: DEFAULT_AGENT_CONFIG,
            screenerConfig: SCREENER_PRESETS["Testnet Aggressive"],
            featureDbPath: dbPath
        });

        expect(source.getCandles("BTC-PERP", first, new Date(second.getTime() - 1)).map(c => new Date(c.openTime).toISOString()))
            .toEqual([]);
        expect(source.getCandles("BTC-PERP", first, second).map(c => new Date(c.openTime).toISOString()))
            .toEqual([second.toISOString()]);
        await db.$disconnect();
    });

    it("fires SL/TP when a candle openTime equals the replay timestamp", async () => {
        const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bt-runner-")), "market.db");
        const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
        const store = new FeatureStore({ db });
        await store.ensureSchema();

        const first = new Date("2026-04-11T10:00:00Z");
        const second = new Date("2026-04-11T10:01:00Z");
        const agentConfig = structuredClone(AGENT_PRESETS["Testnet Aggressive"]);
        agentConfig.risk.max_positions = 1;
        agentConfig.risk.max_new_positions_per_cycle = 1;

        const rowOverrides: Partial<MarketFeatureRow> = {
            intervalSeconds: 60,
            book_pressure_5bps: -0.2,
            book_pressure_10bps: -0.2,
            book_pressure_25bps: -0.2,
            ret_sigma_5m_vs_1h: 2,
            vol_ratio_5m_vs_1h: 1.2,
            ret_5m: 0.02,
            ret_15m: 0.10,
            ret_1h: 0.10
        };
        await store.upsertRows([
            featureRow(first, "BTC-PERP", rowOverrides),
            featureRow(second, "BTC-PERP", rowOverrides)
        ]);
        await db.$executeRawUnsafe(
            `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume") VALUES (?, '1m', ?, 100, 101, 99, 100, 1)`,
            "BTC",
            first
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume") VALUES (?, '1m', ?, 100, 100, 80, 90, 1)`,
            "BTC",
            second
        );
        await db.$disconnect();

        const result = await new BacktestRunner().run({
            network: "testnet",
            start: first,
            end: second,
            intervalSeconds: 60,
            initialCapitalUsd: 10000,
            screeningPresetName: "Testnet Aggressive",
            agentPresetName: "Testnet Aggressive",
            screeningConfig: SCREENER_PRESETS["Testnet Aggressive"],
            agentConfig,
            policyName: "take_top_rank",
            managementPolicyName: "never_close",
            seed: 1,
            featureDbPath: dbPath,
            runId: `runner_equal_ts_${Date.now()}`
        });

        expect(result.trades).toHaveLength(1);
        expect(result.trades[0].exit_ts.toISOString()).toBe(second.toISOString());
        expect(result.trades[0].exit_reason).toBe("take_profit");
    });

    it("checks execution coverage at replay feature timestamps instead of minute floors", async () => {
        const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bt-db-")), "market.db");
        const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
        const store = new FeatureStore({ db });
        const bookStore = new ExecutionBookStore({ db });
        await store.ensureSchema();

        const first = new Date("2026-04-11T10:00:10Z");
        const second = new Date("2026-04-11T10:00:20Z");
        await store.upsertRows([featureRow(first, "BTC-PERP"), featureRow(second, "BTC-PERP")]);
        await bookStore.upsertBooks([
            { ts: first, symbol: "BTC-PERP", intervalSeconds: 10, bids: [{ price: 99, size: 1 }], asks: [{ price: 101, size: 1 }] },
            { ts: second, symbol: "BTC-PERP", intervalSeconds: 10, bids: [{ price: 99, size: 1 }], asks: [{ price: 101, size: 1 }] }
        ]);
        for (const ts of [first, second]) {
            await db.$executeRawUnsafe(
                `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume") VALUES (?, '1m', ?, 100, 101, 99, 100, 0)`,
                "BTC",
                ts
            );
        }

        const source = await BacktestDataSource.create({
            network: "mainnet",
            start: new Date("2026-04-11T10:00:05Z"),
            end: new Date("2026-04-11T10:00:25Z"),
            intervalSeconds: 10,
            agentConfig: DEFAULT_AGENT_CONFIG,
            screenerConfig: SCREENER_PRESETS["Testnet Aggressive"],
            featureDbPath: dbPath
        });
        const coverage = source.getCoverageReport();

        expect(coverage.expected_timestamps).toBe(2);
        expect(coverage.missing_feature_rows_by_symbol["BTC-PERP"]).toBe(0);
        expect(coverage.missing_execution_books_by_symbol?.["BTC-PERP"]).toBe(0);
        expect(coverage.missing_candle_intervals).toEqual([]);
        expect(coverage.candle_source).toBe("synthetic_from_features");
        expect(coverage.synthetic_execution_candles).toBe(true);
        await db.$disconnect();
    });

    it("labels the deepest historical depth band as a 1 percent proxy", () => {
        const row = featureRow(new Date("2026-04-11T10:00:00Z"), "BTC-PERP");
        const bands = mapBacktestDepthBands(row);
        const onePercentProxy = mapBacktestOnePercentDepth(row);

        expect(bands.bid["0.25"]).toBe(row.bid_depth_25bps_usd);
        expect(bands.bid["1.00"]).toBeUndefined();
        expect(bands.ask["1.00"]).toBeUndefined();
        expect(onePercentProxy).toEqual({
            bid_1pct: row.bid_depth_25bps_usd,
            ask_1pct: row.ask_depth_25bps_usd,
            proxy_source: "deepest_available_historical_depth_band",
            proxy_band_pct: "0.25"
        });
    });

    it("keeps backtest candidates when layer2 liquidity filtering uses historical depth proxies", async () => {
        const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bt-db-")), "market.db");
        const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
        const store = new FeatureStore({ db });
        await store.ensureSchema();
        await createMarketTables(db);

        const ts = new Date("2026-04-11T10:00:00Z");
        await store.upsertRows([featureRow(ts, "BTC-PERP")]);
        await db.$executeRawUnsafe(
            `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume") VALUES (?, '1m', ?, 100, 101, 99, 100, 1)`,
            "BTC",
            ts
        );

        const source = await BacktestDataSource.create({
            network: "mainnet",
            start: ts,
            end: ts,
            intervalSeconds: 10,
            agentConfig: DEFAULT_AGENT_CONFIG,
            screenerConfig: {
                ...SCREENER_PRESETS["Testnet Aggressive"],
                layer2Enabled: true,
                minDepthUsd: 50_000
            },
            featureDbPath: dbPath
        });

        expect(Object.keys(source.getMarkets(ts))).toContain("BTC-PERP");
        await db.$disconnect();
    });

    it("classifies synthetic and mixed execution candles", () => {
        expect(classifyExecutionCandleSource([{ volume: 0 }])).toBe("synthetic_from_features");
        expect(classifyExecutionCandleSource([{ volume: 0, source: "real_1m" }])).toBe("real_1m");
        expect(classifyExecutionCandleSource([{ volume: 12 }])).toBe("real_1m");
        expect(classifyExecutionCandleSource([{ volume: 0 }, { volume: 12 }])).toBe("mixed");
    });

    it("assumes stop loss before take profit inside the same candle", () => {
        const config = DEFAULT_AGENT_CONFIG;
        const portfolio = new BacktestPortfolio(10000, config);
        const simulator = new ExecutionSimulator(config, "mainnet");
        const position: SimPosition = {
            id: "p1",
            symbol: "BTC-PERP",
            side: "long",
            playbook: "Momentum:long",
            entry_ts: new Date("2026-04-11T10:00:00Z"),
            entry_price: 100,
            size_fraction: 0.1,
            notional_usd: 1000,
            size_coin: 10,
            stop_loss_pct: 0.02,
            take_profit_pct: 0.02,
            entry_regime: "CHOP",
            entry_signal: { ret_sigma_5m_vs_1h: null, vol_ratio_5m_vs_1h: null, book_pressure: null, trend_alignment_score: null, edge_to_cost_mult: null },
            highest_price: 100,
            lowest_price: 100,
            max_favorable_excursion_bps: 0,
            max_adverse_excursion_bps: 0
        };
        portfolio.positions.set(position.symbol, position);

        simulator.advancePositionWithCandles(position, [{
            symbol: "BTC",
            openTime: new Date("2026-04-11T10:01:00Z"),
            open: 100,
            high: 103,
            low: 97,
            close: 101,
            volume: 1
        }], portfolio);

        expect(portfolio.trades).toHaveLength(1);
        expect(portfolio.trades[0].exit_reason).toBe("stop_loss");
        expect(portfolio.trades[0].exit_price).toBe(98 * (1 - 1 / 10000));
    });

    it("supports deterministic take-profit-first same-candle ordering for shorts with slippage", () => {
        const config = DEFAULT_AGENT_CONFIG;
        const portfolio = new BacktestPortfolio(10000, config);
        const simulator = new ExecutionSimulator(config, "mainnet", {
            ordering: "take_profit_first",
            slippageMode: "fallback",
            fallbackSlippageBps: 2
        });
        const position: SimPosition = {
            id: "p2",
            symbol: "ETH-PERP",
            side: "short",
            playbook: "Momentum:short",
            entry_ts: new Date("2026-04-11T10:00:00Z"),
            entry_price: 100,
            size_fraction: 0.1,
            notional_usd: 1000,
            size_coin: 10,
            stop_loss_pct: 0.02,
            take_profit_pct: 0.02,
            entry_regime: "CHOP",
            entry_signal: { ret_sigma_5m_vs_1h: null, vol_ratio_5m_vs_1h: null, book_pressure: null, trend_alignment_score: null, edge_to_cost_mult: null },
            highest_price: 100,
            lowest_price: 100,
            max_favorable_excursion_bps: 0,
            max_adverse_excursion_bps: 0
        };
        portfolio.positions.set(position.symbol, position);

        simulator.advancePositionWithCandles(position, [{
            symbol: "ETH",
            openTime: new Date("2026-04-11T10:01:00Z"),
            open: 100,
            high: 103,
            low: 97,
            close: 99,
            volume: 1
        }], portfolio);

        expect(portfolio.trades).toHaveLength(1);
        expect(portfolio.trades[0].exit_reason).toBe("take_profit");
        expect(portfolio.trades[0].exit_price).toBe(98 * (1 + 2 / 10000));
        expect(portfolio.trades[0].slippage_bps).toBe(2);
    });

    it("walks historical L2 books for simulated entry fills", () => {
        const config = DEFAULT_AGENT_CONFIG;
        const portfolio = new BacktestPortfolio(10000, config);
        const simulator = new ExecutionSimulator(config, "mainnet");
        const ts = new Date("2026-04-11T10:00:00Z");
        const decision: TradeDecision = {
            scope: "candidate",
            candidate_id: "BTC-PERP:long:Momentum",
            action: "OPEN_POSITION",
            symbol: "BTC-PERP",
            side: "long",
            target_side: "long",
            target_size_fraction_of_equity: 0.1,
            size_fraction_of_equity: 0.1,
            risk_plan: { stop_loss_pct: 0.02, take_profit_pct_primary: 0.03 },
            playbook: "Momentum:long",
            confidence: 0.7,
            reason_code: "momentum_edge",
            notes: "test"
        };

        simulator.apply([decision], {
            "BTC-PERP": marketEntry()
        }, portfolio, ts, () => ({
            ts,
            symbol: "BTC-PERP",
            intervalSeconds: 10,
            bids: [{ price: 99, size: 20 }],
            asks: [{ price: 100, size: 5 }, { price: 101, size: 10 }]
        }));

        const position = portfolio.positions.get("BTC-PERP");
        expect(position).toBeDefined();
        expect(position!.entry_price).toBeCloseTo(100.4975, 4);
        expect(position!.confidence).toBe(0.7);

        const trade = portfolio.closePosition("BTC-PERP", 102, new Date("2026-04-11T10:05:00Z"), "test_exit", 1, 0);
        expect(trade?.confidence).toBe(0.7);
        const metrics = MetricsReporter.build(10000, portfolio.equityCurve, portfolio.trades);
        expect(metrics.confidence_buckets["0.60-0.79"].trade_count).toBe(1);
    });

    it("supports path-aware SL/TP ordering and book-or-fallback SL/TP fills", () => {
        const config = DEFAULT_AGENT_CONFIG;
        const portfolio = new BacktestPortfolio(10000, config);
        const simulator = new ExecutionSimulator(config, "mainnet", {
            ordering: "path_aware",
            slippageMode: "book_or_fallback",
            fallbackSlippageBps: 10
        });
        const position: SimPosition = {
            id: "p-book",
            symbol: "BTC-PERP",
            side: "long",
            playbook: "Momentum:long",
            entry_ts: new Date("2026-04-11T10:00:00Z"),
            entry_price: 100,
            size_fraction: 0.1,
            notional_usd: 1000,
            size_coin: 10,
            stop_loss_pct: 0.02,
            take_profit_pct: 0.02,
            entry_regime: "CHOP",
            entry_signal: { ret_sigma_5m_vs_1h: null, vol_ratio_5m_vs_1h: null, book_pressure: null, trend_alignment_score: null, edge_to_cost_mult: null },
            highest_price: 100,
            lowest_price: 100,
            max_favorable_excursion_bps: 0,
            max_adverse_excursion_bps: 0
        };
        portfolio.positions.set(position.symbol, position);

        simulator.advancePositionWithCandles(position, [{
            symbol: "BTC",
            openTime: new Date("2026-04-11T10:01:00Z"),
            open: 101.9,
            high: 103,
            low: 97,
            close: 102,
            volume: 1
        }], portfolio, () => ({
            ts: new Date("2026-04-11T10:01:00Z"),
            symbol: "BTC-PERP",
            intervalSeconds: 60,
            bids: [{ price: 101.5, size: 20 }],
            asks: [{ price: 102.5, size: 20 }]
        }));

        expect(portfolio.trades).toHaveLength(1);
        expect(portfolio.trades[0].exit_reason).toBe("take_profit");
        expect(portfolio.trades[0].exit_price).toBe(101.5);
        expect(portfolio.trades[0].slippage_bps).toBeCloseTo(49.0196, 4);
    });

    it("resets daily PnL accounting at UTC day boundaries", () => {
        const portfolio = new BacktestPortfolio(10000, DEFAULT_AGENT_CONFIG);
        const position: SimPosition = {
            id: "p1",
            symbol: "BTC-PERP",
            side: "long",
            playbook: "Momentum:long",
            entry_ts: new Date("2026-04-11T10:00:00Z"),
            entry_price: 100,
            size_fraction: 0.1,
            notional_usd: 1000,
            size_coin: 10,
            stop_loss_pct: 0.02,
            take_profit_pct: 0.03,
            entry_regime: "CHOP",
            entry_signal: { ret_sigma_5m_vs_1h: null, vol_ratio_5m_vs_1h: null, book_pressure: null, trend_alignment_score: null, edge_to_cost_mult: null },
            highest_price: 100,
            lowest_price: 100,
            max_favorable_excursion_bps: 0,
            max_adverse_excursion_bps: 0
        };

        portfolio.addPosition(position, 0, new Date("2026-04-11T10:00:00Z"));
        portfolio.buildAccountState({}, new Date("2026-04-11T10:00:00Z"));
        portfolio.closePosition("BTC-PERP", 90, new Date("2026-04-11T11:00:00Z"), "test", 0, 0);

        expect(portfolio.buildAccountState({}, new Date("2026-04-11T11:00:00Z")).daily_total_pnl_usd).toBe(-100);
        expect(portfolio.buildAccountState({}, new Date("2026-04-12T00:00:00Z")).daily_total_pnl_usd).toBe(0);
    });

    it("samples optimizer parameters within safe ranges deterministically", () => {
        const a = sampleRandomConfig(DEFAULT_AGENT_CONFIG, 123);
        const b = sampleRandomConfig(DEFAULT_AGENT_CONFIG, 123);
        const screenerA = sampleRandomScreenerConfig(SCREENER_PRESETS["Momentum Moderate"], 123);
        const screenerB = sampleRandomScreenerConfig(SCREENER_PRESETS["Momentum Moderate"], 123);

        expect(a.triggers.momentum.vol_ratio_min).toBe(b.triggers.momentum.vol_ratio_min);
        expect(a.triggers.momentum.vol_ratio_min).toBeGreaterThanOrEqual(0.5);
        expect(a.triggers.momentum.vol_ratio_min).toBeLessThanOrEqual(1.5);
        expect(a.cost_sanity.min_edge_to_cost_mult).toBeGreaterThanOrEqual(3);
        expect(a.cost_sanity.min_edge_to_cost_mult).toBeLessThanOrEqual(8);
        expect(a.gates.edge_to_cost_mult_by_regime).toEqual({
            RISK_ON: a.cost_sanity.min_edge_to_cost_mult,
            RISK_OFF: a.cost_sanity.min_edge_to_cost_mult,
            CHOP: a.cost_sanity.min_edge_to_cost_mult
        });
        expect(a.management_policy.playbook_aware.momentum.opposite_pressure_cycles).toBeGreaterThanOrEqual(2);
        expect(a.management_policy.playbook_aware.momentum.opposite_pressure_cycles).toBeLessThanOrEqual(5);
        expect(screenerA).toEqual(screenerB);
        expect(screenerA.topN).toBe(SCREENER_PRESETS["Momentum Moderate"].topN);
        expect(screenerA.minDepthUsd).toBeGreaterThanOrEqual(0);
    });

    it("uses explicit optimizer gates and keeps coverage penalties from becoming absolute rejections", () => {
        const baseCoverage = coverage({
            missing_feature_rows_by_symbol: { "BTC-PERP": 12 },
            missing_execution_books_by_symbol: { "BTC-PERP": 0 }
        });
        const goodMetrics = metrics({ netPnlBps: 100, maxDrawdownBps: 10, trades: 40, symbolConcentration: 0.2, regimeConcentration: 0.4 });

        expect(optimizerRejectionReason(goodMetrics, baseCoverage, {
            minTrades: 30,
            maxDrawdownBps: 100,
            minProfitFactor: 1,
            maxStopHitRate: 0.7,
            maxSymbolConcentration: 0.5,
            maxRegimeConcentration: 0.8,
            allowSyntheticCandles: false
        }, ["BTC-PERP"])).toBeNull();

        expect(optimizerRejectionReason(goodMetrics, coverage({ synthetic_execution_candles: true, candle_source: "synthetic_from_features" }), undefined, ["BTC-PERP"]))
            .toBe("synthetic_execution_candles");
        expect(optimizerRejectionReason(
            metrics({ netPnlBps: 100, maxDrawdownBps: 10, trades: 3, symbolConcentration: 0.2, regimeConcentration: 0.4 }),
            baseCoverage
        )).toMatch(/^min_trades/);
        expect(optimizerRejectionReason(goodMetrics, coverage({
            missing_candle_intervals: [{ symbol: "BTC-PERP", start: "2026-04-11T10:00:00.000Z", end: "2026-04-11T10:01:00.000Z" }]
        }), undefined, ["BTC-PERP"])).toMatch(/^missing_execution_candles_for_traded_symbols/);
    });

    it("aggregates walk-forward folds by config hash before ranking", () => {
        const agentConfig = sampleRandomConfig(DEFAULT_AGENT_CONFIG, 1);
        const screenerConfig = sampleRandomScreenerConfig(SCREENER_PRESETS["Momentum Moderate"], 1);
        const otherAgentConfig = sampleRandomConfig(DEFAULT_AGENT_CONFIG, 2);
        const otherScreenerConfig = sampleRandomScreenerConfig(SCREENER_PRESETS["Momentum Moderate"], 2);
        const sharedHash = configHash(agentConfig, screenerConfig);

        const results = aggregateScoredConfigs([{
            config_hash: sharedHash,
            agentConfig,
            screenerConfig,
            metrics: metrics({ netPnlBps: 80, maxDrawdownBps: 10, trades: 40, symbolConcentration: 0.2, regimeConcentration: 0.4 }),
            coverage: coverage(),
            score: 80,
            rejected: false
        }, {
            config_hash: sharedHash,
            agentConfig,
            screenerConfig,
            metrics: metrics({ netPnlBps: 60, maxDrawdownBps: 20, trades: 50, symbolConcentration: 0.3, regimeConcentration: 0.5 }),
            coverage: coverage(),
            score: 60,
            rejected: false
        }, {
            config_hash: configHash(otherAgentConfig, otherScreenerConfig),
            agentConfig: otherAgentConfig,
            screenerConfig: otherScreenerConfig,
            metrics: metrics({ netPnlBps: 90, maxDrawdownBps: 15, trades: 35, symbolConcentration: 0.2, regimeConcentration: 0.4 }),
            coverage: coverage(),
            score: 90,
            rejected: false
        }], {
            minTrades: 1,
            maxDrawdownBps: 1000,
            minProfitFactor: 1,
            maxStopHitRate: 1,
            maxSymbolConcentration: 1,
            maxRegimeConcentration: 1,
            allowSyntheticCandles: true
        });

        const aggregate = results.find(result => result.config_hash === sharedHash);
        expect(results).toHaveLength(2);
        expect(aggregate?.fold_count).toBe(2);
        expect(aggregate?.metrics.trade_count).toBe(90);
        expect(aggregate?.metrics.net_pnl_bps).toBe(140);
    });

    it("reports concentration and preset breakdowns for optimizer gates", () => {
        const trades = [
            trade({ symbol: "BTC-PERP", regime: "RISK_ON", pnl: 20 }),
            trade({ symbol: "BTC-PERP", regime: "RISK_ON", pnl: -5 }),
            trade({ symbol: "ETH-PERP", regime: "CHOP", pnl: 10 })
        ];

        const metrics = MetricsReporter.build(10000, [{ ts: new Date("2026-04-11T10:30:00Z"), equity_usd: 10025 }], trades, {
            screeningPresetName: "Momentum Moderate",
            agentPresetName: "Momentum Moderate",
            traderPolicyName: "take_top_rank"
        });

        expect(metrics.one_symbol_concentration).toBeCloseTo(2 / 3, 4);
        expect(metrics.one_regime_concentration).toBeCloseTo(2 / 3, 4);
        expect(metrics.max_consecutive_losses).toBe(1);
        expect(metrics.avg_slippage_bps).toBe(0);
        expect(metrics.avg_fees_usd_per_trade).toBe(1);
        expect(metrics.avg_mfe_bps).toBe(100);
        expect(metrics.expectancy_per_trade_usd).toBeCloseTo(25 / 3, 4);
        expect(metrics.pnl_by_hour_utc["10"]).toBe(25);
        expect(metrics.pnl_by_weekday.sat).toBe(25);
        expect(metrics.confidence_buckets.unknown.trade_count).toBe(3);
        expect(metrics.breakdowns.regime_current.RISK_ON.trade_count).toBe(2);
        expect(metrics.breakdowns.screening_preset["Momentum Moderate"].trade_count).toBe(3);
        expect(metrics.breakdowns.trader_policy.take_top_rank.trade_count).toBe(3);
    });

    it("penalizes concentrated optimizer results and rejects concentrated challengers", () => {
        const champion = metrics({ netPnlBps: 100, maxDrawdownBps: 10, trades: 40, symbolConcentration: 0.25, regimeConcentration: 0.5 });
        const diversified = metrics({ netPnlBps: 150, maxDrawdownBps: 10, trades: 40, symbolConcentration: 0.25, regimeConcentration: 0.5 });
        const concentrated = metrics({ netPnlBps: 150, maxDrawdownBps: 10, trades: 40, symbolConcentration: 0.8, regimeConcentration: 0.8 });

        expect(scoreMetrics(concentrated)).toBeLessThan(scoreMetrics(diversified));
        expect(acceptChallenger(DEFAULT_AGENT_CONFIG, DEFAULT_AGENT_CONFIG, champion, diversified).accepted).toBe(true);
        expect(acceptChallenger(DEFAULT_AGENT_CONFIG, DEFAULT_AGENT_CONFIG, champion, concentrated).accepted).toBe(false);
    });

    it("replays recorded LLM decisions from JSONL by timestamp", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bt-llm-"));
        const decisionsPath = path.join(dir, "llm_decisions.jsonl");
        const timestamp = Math.floor(new Date("2026-04-11T10:00:00Z").getTime() / 1000);
        await fs.writeFile(decisionsPath, `${JSON.stringify({
            timestamp,
            decisions: [{
                scope: "candidate",
                action: "SKIP",
                candidate_id: "BTC-PERP:long:Momentum",
                symbol: "BTC-PERP",
                target_side: "flat",
                target_size_fraction_of_equity: 0,
                playbook: null,
                confidence: 0.4,
                reason_code: "skip",
                notes: "recorded skip"
            }]
        })}\n`);

        const trader = new RecordedLLMTrader({ enabled: true, model: "recorded", decisionsPath });
        const decisions = await trader.decide(traderContext(timestamp));

        expect(decisions).toHaveLength(1);
        expect(decisions[0].action).toBe("SKIP");
        expect(decisions[0].notes).toBe("recorded skip");
    });

    it("requires explicit LLM enablement for LLM policies", () => {
        expect(() => buildTraderPolicy("real_llm", buildManagementPolicy("never_close"), new Map())).toThrow(/llm.enabled/);
        expect(() => buildTraderPolicy("recorded_llm", buildManagementPolicy("never_close"), new Map())).toThrow(/llm.enabled/);
    });
});

function marketEntry() {
    return {
        symbol: "BTC-PERP",
        price: 100,
        spread_bps: 100,
        orderbook: {
            best_bid: 99,
            best_ask: 100,
            mid: 99.5,
            book_pressure: 0,
            bid_liquidity_usd: 100000,
            ask_liquidity_usd: 100000
        },
        returns: { m5: 0.01, m15: 0.02, h1: 0.03 },
        vol_zscores: { vol_5m_vs_1h: 1, ret_5m_vs_1h: 1 },
        funding: { current_8h: 0 },
        open_interest: { current: 0 },
        sentiment: { score: 0, mentionsVsBaseline: 0, disagreement: 0, change2h: 0 },
        volume24h: 10_000_000,
        derived: {
            costs: { fees_bps: 3.5, slippage_bps_est: 0, cost_bps: 10, cost_ok: true },
            edge: { expected_move_bps: 100, edge_bps: 90, edge_ok: true },
            technicals: { high_low: {}, bb_width_m5: 0 },
            triggers: {
                direction_m15: 1,
                direction_h1: 1,
                trend_aligned: true,
                momentum_ok_long: true,
                momentum_ok_short: false,
                mr_ok_long: false,
                mr_ok_short: false,
                breakout_ok: false
            },
            liquidity: { min_depth_usd: 100000, depth_ok: true, tradeable: true },
            normalized: { ret_sigma_5m_vs_1h: 1, vol_ratio_5m_vs_1h: 1 },
            entry: { entry_ok: true, edge_to_cost_mult: 9 },
            risk: { eligible: true, eligible_playbooks: ["Momentum:long"], best_anchor_key: null, best_anchor_value: null },
            rank: 1
        }
    };
}

async function createMarketTables(db: PrismaClient) {
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "MarketTick" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "ts" DATETIME NOT NULL,
        "symbol" TEXT NOT NULL,
        "markPrice" REAL NOT NULL,
        "indexPrice" REAL,
        "openInterest" REAL,
        "fundingRate" REAL,
        "volume24h" REAL
    )`);
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "MarketCandle" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "symbol" TEXT NOT NULL,
        "timeframe" TEXT NOT NULL,
        "openTime" DATETIME NOT NULL,
        "open" REAL NOT NULL,
        "high" REAL NOT NULL,
        "low" REAL NOT NULL,
        "close" REAL NOT NULL,
        "volume" REAL NOT NULL
    )`);
}

function featureRow(ts: Date, symbol: string, overrides: Partial<MarketFeatureRow> = {}): MarketFeatureRow {
    return {
        ts,
        symbol,
        intervalSeconds: 10,
        best_bid: 99,
        best_ask: 101,
        mid_price: 100,
        spread_bps: 200,
        bid_depth_5bps_usd: 100000,
        ask_depth_5bps_usd: 100000,
        bid_depth_10bps_usd: 100000,
        ask_depth_10bps_usd: 100000,
        bid_depth_25bps_usd: 100000,
        ask_depth_25bps_usd: 100000,
        depth_5bps_usd: 100000,
        depth_10bps_usd: 100000,
        depth_25bps_usd: 100000,
        book_pressure_5bps: 0,
        book_pressure_10bps: 0,
        book_pressure_25bps: 0,
        buy_slippage_bps_100: 0,
        sell_slippage_bps_100: 0,
        buy_slippage_bps_500: 0,
        sell_slippage_bps_500: 0,
        cost_bps_100: 207,
        cost_bps_500: 207,
        ret_1m: 0.01,
        ret_5m: 0.02,
        ret_15m: 0.03,
        ret_1h: 0.04,
        ret_4h: 0.05,
        realized_vol_5m: 0.01,
        realized_vol_1h: 0.02,
        vol_ratio_5m_vs_1h: 0.5,
        ret_sigma_5m_vs_1h: 2,
        trend_side: "long",
        trend_alignment_score: 1,
        ...overrides
    };
}

function trade(args: { symbol: string; regime: string; pnl: number }): SimTrade {
    const entry = new Date("2026-04-11T10:00:00Z");
    const exit = new Date("2026-04-11T10:30:00Z");
    return {
        trade_id: `${args.symbol}:${args.regime}:${args.pnl}`,
        entry_ts: entry,
        exit_ts: exit,
        symbol: args.symbol,
        side: "long",
        playbook: "Momentum:long",
        entry_price: 100,
        exit_price: 101,
        size_fraction: 0.1,
        notional_usd: 1000,
        fees_usd: 1,
        slippage_bps: 0,
        gross_pnl_usd: args.pnl + 1,
        net_pnl_usd: args.pnl,
        exit_reason: "take_profit",
        max_favorable_excursion_bps: 100,
        max_adverse_excursion_bps: 0,
        entry_regime: { current: args.regime }
    };
}

function coverage(overrides: Partial<CoverageReport> = {}): CoverageReport {
    return {
        expected_timestamps: 10,
        available_timestamps: 10,
        candle_source: "real_1m" as const,
        synthetic_execution_candles: false,
        missing_feature_rows_by_symbol: {},
        missing_execution_books_by_symbol: {},
        missing_candle_intervals: [],
        symbols_dropped_insufficient_history: [],
        skipped_timestamps: [],
        ...overrides
    };
}

function metrics(args: {
    netPnlBps: number;
    maxDrawdownBps: number;
    trades: number;
    symbolConcentration: number;
    regimeConcentration: number;
}): BacktestMetrics {
    return {
        net_pnl_usd: args.netPnlBps,
        net_pnl_bps: args.netPnlBps,
        max_drawdown_usd: args.maxDrawdownBps,
        max_drawdown_bps: args.maxDrawdownBps,
        trade_count: args.trades,
        win_rate: 0.5,
        profit_factor: 1.5,
        avg_win_usd: 10,
        avg_loss_usd: -5,
        avg_trade_net_bps: 1,
        expectancy_per_trade_usd: 1,
        max_consecutive_losses: 1,
        avg_slippage_bps: 0,
        avg_fees_usd_per_trade: 1,
        avg_mfe_bps: 100,
        avg_mae_bps: 0,
        pnl_by_hour_utc: {},
        pnl_by_weekday: {},
        confidence_buckets: {},
        turnover_usd: 10000,
        turnover_cost_usd: 10,
        stop_hit_rate: 0,
        take_profit_hit_rate: 0,
        time_stop_rate: 0,
        avg_holding_minutes: 30,
        one_symbol_concentration: args.symbolConcentration,
        one_regime_concentration: args.regimeConcentration,
        breakdowns: {}
    };
}

function traderContext(timestamp: number): TraderContext {
    return {
        snapshot_id: 1,
        timestamp,
        global_regime: "CHOP",
        profile: "test",
        portfolio: {
            equity_usd: 10000,
            gross_exposure_fraction: 0,
            remaining_capacity_fraction: 1,
            daily_pnl_pct: 0,
            kill_switch: false
        },
        existing_positions: [],
        eligible_candidates: []
    };
}
