import path from "path";
import { PrismaClient } from "@prisma/market-client";

export const DEFAULT_BACKTEST_DB_PATH = "prisma/backtest.db";

type RawDbClient = Pick<PrismaClient, "$executeRawUnsafe" | "$queryRawUnsafe">;

export function createBacktestDbClient(dbPath: string = DEFAULT_BACKTEST_DB_PATH): PrismaClient {
    assertNotMarketDb(dbPath);
    const resolved = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
    return new PrismaClient({
        datasources: {
            db: { url: `file:${resolved}` }
        }
    });
}

export async function ensureBacktestDbSchema(db: RawDbClient): Promise<void> {
    await configureBacktestDbConnection(db);
    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "MarketTick" (
            "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "symbol" TEXT NOT NULL,
            "markPrice" REAL NOT NULL,
            "indexPrice" REAL,
            "openInterest" REAL,
            "fundingRate" REAL,
            "volume24h" REAL,
            "bookBidPx" REAL,
            "bookBidSz" REAL,
            "bookAskPx" REAL,
            "bookAskSz" REAL
        )
    `);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "MarketTick_ts_idx" ON "MarketTick"("ts")`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "MarketTick_symbol_ts_idx" ON "MarketTick"("symbol", "ts")`);

    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "MarketCandle" (
            "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            "symbol" TEXT NOT NULL,
            "timeframe" TEXT NOT NULL,
            "openTime" DATETIME NOT NULL,
            "open" REAL NOT NULL,
            "high" REAL NOT NULL,
            "low" REAL NOT NULL,
            "close" REAL NOT NULL,
            "volume" REAL NOT NULL,
            "source" TEXT
        )
    `);
    await addColumnIfMissing(db, `"MarketCandle"`, `"source" TEXT`);
    await db.$executeRawUnsafe(`
        UPDATE "MarketCandle"
        SET "source" = CASE WHEN "volume" = 0 THEN 'synthetic_from_features' ELSE 'real_1m' END
        WHERE "source" IS NULL
    `);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "MarketCandle_symbol_timeframe_openTime_key" ON "MarketCandle"("symbol", "timeframe", "openTime")`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "MarketCandle_symbol_timeframe_openTime_idx" ON "MarketCandle"("symbol", "timeframe", "openTime")`);

    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "MarketFeature" (
            "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            "ts" DATETIME NOT NULL,
            "symbol" TEXT NOT NULL,
            "intervalSeconds" INTEGER NOT NULL,
            "bestBid" REAL NOT NULL,
            "bestAsk" REAL NOT NULL,
            "midPrice" REAL NOT NULL,
            "spreadBps" REAL NOT NULL,
            "bidDepth5BpsUsd" REAL NOT NULL,
            "askDepth5BpsUsd" REAL NOT NULL,
            "bidDepth10BpsUsd" REAL NOT NULL,
            "askDepth10BpsUsd" REAL NOT NULL,
            "bidDepth25BpsUsd" REAL NOT NULL,
            "askDepth25BpsUsd" REAL NOT NULL,
            "depth5BpsUsd" REAL NOT NULL,
            "depth10BpsUsd" REAL NOT NULL,
            "depth25BpsUsd" REAL NOT NULL,
            "bookPressure5Bps" REAL NOT NULL,
            "bookPressure10Bps" REAL NOT NULL,
            "bookPressure25Bps" REAL NOT NULL,
            "buySlippageBps100" REAL,
            "sellSlippageBps100" REAL,
            "buySlippageBps500" REAL,
            "sellSlippageBps500" REAL,
            "costBps100" REAL,
            "costBps500" REAL,
            "ret1m" REAL,
            "ret5m" REAL,
            "ret15m" REAL,
            "ret1h" REAL,
            "ret4h" REAL,
            "realizedVol5m" REAL,
            "realizedVol1h" REAL,
            "volRatio5mVs1h" REAL,
            "retSigma5mVs1h" REAL,
            "trendSide" TEXT,
            "trendAlignmentScore" REAL,
            "sourceDate" TEXT,
            "sourceHour" INTEGER,
            "sourceFile" TEXT,
            "ingestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "MarketFeature_symbol_intervalSeconds_ts_key" ON "MarketFeature"("symbol", "intervalSeconds", "ts")`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "MarketFeature_ts_idx" ON "MarketFeature"("ts")`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "MarketFeature_symbol_ts_idx" ON "MarketFeature"("symbol", "ts")`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "MarketFeature_sourceDate_sourceHour_idx" ON "MarketFeature"("sourceDate", "sourceHour")`);

    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "MarketBook" (
            "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            "ts" DATETIME NOT NULL,
            "symbol" TEXT NOT NULL,
            "intervalSeconds" INTEGER NOT NULL,
            "bidsJson" TEXT NOT NULL,
            "asksJson" TEXT NOT NULL,
            "sourceFile" TEXT,
            "ingestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "MarketBook_symbol_intervalSeconds_ts_key" ON "MarketBook"("symbol", "intervalSeconds", "ts")`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "MarketBook_ts_idx" ON "MarketBook"("ts")`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "MarketBook_symbol_ts_idx" ON "MarketBook"("symbol", "ts")`);

    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "BacktestArchiveIngest" (
            "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            "dataType" TEXT NOT NULL,
            "symbol" TEXT NOT NULL,
            "sourceDate" TEXT NOT NULL,
            "sourceHour" INTEGER NOT NULL,
            "intervalSeconds" INTEGER NOT NULL,
            "rowCount" INTEGER NOT NULL,
            "bookCount" INTEGER NOT NULL DEFAULT 0,
            "completedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "BacktestArchiveIngest_unique_key" ON "BacktestArchiveIngest"("dataType", "symbol", "sourceDate", "sourceHour", "intervalSeconds")`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BacktestArchiveIngest_source_idx" ON "BacktestArchiveIngest"("sourceDate", "sourceHour")`);
}

async function configureBacktestDbConnection(db: RawDbClient): Promise<void> {
    await db.$queryRawUnsafe(`PRAGMA busy_timeout = 30000`);
    await db.$queryRawUnsafe(`PRAGMA synchronous = NORMAL`);
    await db.$queryRawUnsafe(`PRAGMA temp_store = MEMORY`);
    await db.$queryRawUnsafe(`PRAGMA cache_size = -200000`);
    await db.$queryRawUnsafe(`PRAGMA journal_mode = WAL`);
}

async function addColumnIfMissing(db: RawDbClient, table: string, columnDefinition: string): Promise<void> {
    try {
        await db.$executeRawUnsafe(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`);
    } catch (error) {
        if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
        throw error;
    }
}

export function assertNotMarketDb(dbPath: string): void {
    const normalized = path.normalize(dbPath);
    const base = path.basename(normalized);
    if (base === "md_main.db" || base === "md_test.db") {
        throw new Error("Backtest scripts must not write to md_main.db or md_test.db. Use prisma/backtest.db or another scratch DB.");
    }
}
