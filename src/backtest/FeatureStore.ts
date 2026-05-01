import path from "path";
import { PrismaClient } from "@prisma/market-client";
import { MarketFeatureRow } from "./BacktestTypes";
import { createBacktestDbClient, ensureBacktestDbSchema } from "./BacktestDb";

type DbClient = Pick<PrismaClient, "$executeRawUnsafe" | "$queryRawUnsafe">;

const FEATURE_UPSERT_BATCH_SIZE = 1000;
const WRITE_TRANSACTION_TIMEOUT_MS = 600_000;

export type FeatureStoreOptions = {
    network?: "mainnet" | "testnet";
    db?: DbClient;
    dbPath?: string;
};

export class FeatureStore {
    private readonly db: DbClient;
    private readonly ownedClient: PrismaClient | null;
    private schemaReady = false;

    constructor(options: FeatureStoreOptions = {}) {
        if (options.db) {
            this.db = options.db;
            this.ownedClient = null;
            return;
        }

        if (options.dbPath) {
            const dbPath = path.isAbsolute(options.dbPath)
                ? options.dbPath
                : path.join(process.cwd(), options.dbPath);
            this.ownedClient = createBacktestDbClient(dbPath);
            this.db = this.ownedClient;
            return;
        }

        this.ownedClient = createBacktestDbClient();
        this.db = this.ownedClient;
    }

    public async close(): Promise<void> {
        await this.ownedClient?.$disconnect();
    }

    public async ensureSchema(): Promise<void> {
        if (this.schemaReady) return;
        await ensureBacktestDbSchema(this.db as PrismaClient);
        this.schemaReady = true;
    }

    public async upsertRows(rows: MarketFeatureRow[]): Promise<number> {
        if (rows.length === 0) return 0;
        await this.ensureSchema();

        await this.withWriteClient(async db => {
            for (let i = 0; i < rows.length; i += FEATURE_UPSERT_BATCH_SIZE) {
                const batch = rows.slice(i, i + FEATURE_UPSERT_BATCH_SIZE);
                const placeholders = batch.map(() =>
                    "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                ).join(",");
                await db.$executeRawUnsafe(
                    `INSERT INTO "MarketFeature" (
                        "ts", "symbol", "intervalSeconds",
                        "bestBid", "bestAsk", "midPrice", "spreadBps",
                        "bidDepth5BpsUsd", "askDepth5BpsUsd", "bidDepth10BpsUsd", "askDepth10BpsUsd", "bidDepth25BpsUsd", "askDepth25BpsUsd",
                        "depth5BpsUsd", "depth10BpsUsd", "depth25BpsUsd",
                        "bookPressure5Bps", "bookPressure10Bps", "bookPressure25Bps",
                        "buySlippageBps100", "sellSlippageBps100", "buySlippageBps500", "sellSlippageBps500",
                        "costBps100", "costBps500",
                        "ret1m", "ret5m", "ret15m", "ret1h", "ret4h",
                        "realizedVol5m", "realizedVol1h", "volRatio5mVs1h", "retSigma5mVs1h",
                        "trendSide", "trendAlignmentScore", "sourceDate", "sourceHour", "sourceFile"
                    ) VALUES ${placeholders}
                    ON CONFLICT("symbol", "intervalSeconds", "ts") DO UPDATE SET
                        "bestBid"=excluded."bestBid",
                        "bestAsk"=excluded."bestAsk",
                        "midPrice"=excluded."midPrice",
                        "spreadBps"=excluded."spreadBps",
                        "bidDepth5BpsUsd"=excluded."bidDepth5BpsUsd",
                        "askDepth5BpsUsd"=excluded."askDepth5BpsUsd",
                        "bidDepth10BpsUsd"=excluded."bidDepth10BpsUsd",
                        "askDepth10BpsUsd"=excluded."askDepth10BpsUsd",
                        "bidDepth25BpsUsd"=excluded."bidDepth25BpsUsd",
                        "askDepth25BpsUsd"=excluded."askDepth25BpsUsd",
                        "depth5BpsUsd"=excluded."depth5BpsUsd",
                        "depth10BpsUsd"=excluded."depth10BpsUsd",
                        "depth25BpsUsd"=excluded."depth25BpsUsd",
                        "bookPressure5Bps"=excluded."bookPressure5Bps",
                        "bookPressure10Bps"=excluded."bookPressure10Bps",
                        "bookPressure25Bps"=excluded."bookPressure25Bps",
                        "buySlippageBps100"=excluded."buySlippageBps100",
                        "sellSlippageBps100"=excluded."sellSlippageBps100",
                        "buySlippageBps500"=excluded."buySlippageBps500",
                        "sellSlippageBps500"=excluded."sellSlippageBps500",
                        "costBps100"=excluded."costBps100",
                        "costBps500"=excluded."costBps500",
                        "ret1m"=excluded."ret1m",
                        "ret5m"=excluded."ret5m",
                        "ret15m"=excluded."ret15m",
                        "ret1h"=excluded."ret1h",
                        "ret4h"=excluded."ret4h",
                        "realizedVol5m"=excluded."realizedVol5m",
                        "realizedVol1h"=excluded."realizedVol1h",
                        "volRatio5mVs1h"=excluded."volRatio5mVs1h",
                        "retSigma5mVs1h"=excluded."retSigma5mVs1h",
                        "trendSide"=excluded."trendSide",
                        "trendAlignmentScore"=excluded."trendAlignmentScore",
                        "sourceDate"=excluded."sourceDate",
                        "sourceHour"=excluded."sourceHour",
                        "sourceFile"=excluded."sourceFile",
                        "ingestedAt"=CURRENT_TIMESTAMP`,
                    ...batch.flatMap(featureRowParams)
                );
            }
        });

        return rows.length;
    }

    private async withWriteClient<T>(callback: (db: DbClient) => Promise<T>): Promise<T> {
        if (!this.ownedClient) return callback(this.db);
        return this.ownedClient.$transaction(
            tx => callback(tx as unknown as DbClient),
            { maxWait: 60_000, timeout: WRITE_TRANSACTION_TIMEOUT_MS }
        );
    }

    public async getRows(start: Date, end: Date, intervalSeconds: number, symbols?: string[]): Promise<MarketFeatureRow[]> {
        await this.ensureSchema();
        const symbolFilter = symbols?.length
            ? `AND "symbol" IN (${symbols.map(() => "?").join(",")})`
            : "";
        const params = symbols?.length
            ? [start, end, intervalSeconds, ...symbols]
            : [start, end, intervalSeconds];
        const rows = await this.db.$queryRawUnsafe<any[]>(
            `SELECT * FROM "MarketFeature"
             WHERE "ts" >= ? AND "ts" <= ? AND "intervalSeconds" = ? ${symbolFilter}
             ORDER BY "ts" ASC, "symbol" ASC`,
            ...params
        );
        return rows.map(mapDbRow);
    }

    public async getTimestamps(start: Date, end: Date, intervalSeconds: number): Promise<Date[]> {
        await this.ensureSchema();
        const rows = await this.db.$queryRawUnsafe<Array<{ ts: Date | string }>>(
            `SELECT DISTINCT "ts" FROM "MarketFeature"
             WHERE "ts" >= ? AND "ts" <= ? AND "intervalSeconds" = ?
             ORDER BY "ts" ASC`,
            start,
            end,
            intervalSeconds
        );
        return rows.map(row => asDate(row.ts));
    }
}

function featureRowParams(row: MarketFeatureRow): unknown[] {
    return [
        row.ts,
        row.symbol,
        row.intervalSeconds,
        row.best_bid,
        row.best_ask,
        row.mid_price,
        row.spread_bps,
        row.bid_depth_5bps_usd,
        row.ask_depth_5bps_usd,
        row.bid_depth_10bps_usd,
        row.ask_depth_10bps_usd,
        row.bid_depth_25bps_usd,
        row.ask_depth_25bps_usd,
        row.depth_5bps_usd,
        row.depth_10bps_usd,
        row.depth_25bps_usd,
        row.book_pressure_5bps,
        row.book_pressure_10bps,
        row.book_pressure_25bps,
        row.buy_slippage_bps_100,
        row.sell_slippage_bps_100,
        row.buy_slippage_bps_500,
        row.sell_slippage_bps_500,
        row.cost_bps_100,
        row.cost_bps_500,
        row.ret_1m,
        row.ret_5m,
        row.ret_15m,
        row.ret_1h,
        row.ret_4h,
        row.realized_vol_5m,
        row.realized_vol_1h,
        row.vol_ratio_5m_vs_1h,
        row.ret_sigma_5m_vs_1h,
        row.trend_side,
        row.trend_alignment_score,
        row.source_date ?? null,
        row.source_hour ?? null,
        row.source_file ?? null
    ];
}

function asDate(value: Date | string | number): Date {
    return value instanceof Date ? value : new Date(value);
}

function n(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function required(value: unknown): number {
    return n(value) ?? 0;
}

function mapDbRow(row: any): MarketFeatureRow {
    return {
        ts: asDate(row.ts),
        symbol: row.symbol,
        intervalSeconds: required(row.intervalSeconds),
        best_bid: required(row.bestBid),
        best_ask: required(row.bestAsk),
        mid_price: required(row.midPrice),
        spread_bps: required(row.spreadBps),
        bid_depth_5bps_usd: required(row.bidDepth5BpsUsd),
        ask_depth_5bps_usd: required(row.askDepth5BpsUsd),
        bid_depth_10bps_usd: required(row.bidDepth10BpsUsd),
        ask_depth_10bps_usd: required(row.askDepth10BpsUsd),
        bid_depth_25bps_usd: required(row.bidDepth25BpsUsd),
        ask_depth_25bps_usd: required(row.askDepth25BpsUsd),
        depth_5bps_usd: required(row.depth5BpsUsd),
        depth_10bps_usd: required(row.depth10BpsUsd),
        depth_25bps_usd: required(row.depth25BpsUsd),
        book_pressure_5bps: required(row.bookPressure5Bps),
        book_pressure_10bps: required(row.bookPressure10Bps),
        book_pressure_25bps: required(row.bookPressure25Bps),
        buy_slippage_bps_100: n(row.buySlippageBps100),
        sell_slippage_bps_100: n(row.sellSlippageBps100),
        buy_slippage_bps_500: n(row.buySlippageBps500),
        sell_slippage_bps_500: n(row.sellSlippageBps500),
        cost_bps_100: n(row.costBps100),
        cost_bps_500: n(row.costBps500),
        ret_1m: n(row.ret1m),
        ret_5m: n(row.ret5m),
        ret_15m: n(row.ret15m),
        ret_1h: n(row.ret1h),
        ret_4h: n(row.ret4h),
        realized_vol_5m: n(row.realizedVol5m),
        realized_vol_1h: n(row.realizedVol1h),
        vol_ratio_5m_vs_1h: n(row.volRatio5mVs1h),
        ret_sigma_5m_vs_1h: n(row.retSigma5mVs1h),
        trend_side: row.trendSide === "long" || row.trendSide === "short" || row.trendSide === "neutral" ? row.trendSide : null,
        trend_alignment_score: n(row.trendAlignmentScore),
        source_date: row.sourceDate ?? null,
        source_hour: n(row.sourceHour),
        source_file: row.sourceFile ?? null
    };
}
