import { PrismaClient } from '@prisma/market-client';
import path from 'path';

const SQLITE_BUSY_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000];

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isSqliteBusyError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /database is locked|SQLITE_BUSY|Operations timed out|Code: `5`/i.test(message);
}

async function configureMarketConnection(db: PrismaClient, dbPath: string): Promise<void> {
    for (let attempt = 0; attempt <= SQLITE_BUSY_RETRY_DELAYS_MS.length; attempt++) {
        try {
            await db.$connect();
            await db.$queryRawUnsafe(`PRAGMA busy_timeout = 30000`);
            await db.$queryRawUnsafe(`PRAGMA synchronous = NORMAL`);
            await db.$queryRawUnsafe(`PRAGMA temp_store = MEMORY`);
            await db.$queryRawUnsafe(`PRAGMA cache_size = -200000`);
            await db.$queryRawUnsafe(`PRAGMA wal_autocheckpoint = 1000`);
            await db.$queryRawUnsafe(`PRAGMA journal_mode = WAL`);
            return;
        } catch (error) {
            const delay = SQLITE_BUSY_RETRY_DELAYS_MS[attempt];
            if (!isSqliteBusyError(error) || delay === undefined) {
                console.warn(`[market-db] Failed to apply SQLite pragmas to ${dbPath}:`, error);
                return;
            }
            await sleep(delay);
        }
    }
}

// Helper to create a client for a specific DB file
const createClient = (dbFileName: string) => {
    const dbPath = path.join(process.cwd(), 'prisma', dbFileName);
    return new PrismaClient({
        datasources: {
            db: {
                url: `file:${dbPath}?connection_limit=1&pool_timeout=30`,
            },
        },
        log: ['error', 'warn'],
    });
};

// Global object to prevent multiple instances in dev
const globalForMarketDb = globalThis as unknown as {
    marketDbMain?: PrismaClient;
    marketDbTest?: PrismaClient;
    marketDbMainReady?: Promise<void>;
    marketDbTestReady?: Promise<void>;
};

export const marketDbMain =
    globalForMarketDb.marketDbMain ??
    createClient('md_main.db');

export const marketDbTest =
    globalForMarketDb.marketDbTest ??
    createClient('md_test.db');

const marketDbMainPath = path.join(process.cwd(), 'prisma', 'md_main.db');
const marketDbTestPath = path.join(process.cwd(), 'prisma', 'md_test.db');

export const marketDbMainReady =
    globalForMarketDb.marketDbMainReady ??
    configureMarketConnection(marketDbMain, marketDbMainPath);

export const marketDbTestReady =
    globalForMarketDb.marketDbTestReady ??
    configureMarketConnection(marketDbTest, marketDbTestPath);

if (process.env.NODE_ENV !== 'production') {
    globalForMarketDb.marketDbMain = marketDbMain;
    globalForMarketDb.marketDbTest = marketDbTest;
    globalForMarketDb.marketDbMainReady = marketDbMainReady;
    globalForMarketDb.marketDbTestReady = marketDbTestReady;
}

export async function ensureMarketDbReady(db: PrismaClient): Promise<void> {
    if (db === marketDbMain) {
        await marketDbMainReady;
        return;
    }
    if (db === marketDbTest) {
        await marketDbTestReady;
        return;
    }
}

export async function getMarketDb(isTestnet: boolean): Promise<PrismaClient> {
    const db = isTestnet ? marketDbTest : marketDbMain;
    await ensureMarketDbReady(db);
    return db;
}

export async function withMarketDbRetry<T>(
    db: PrismaClient,
    label: string,
    operation: () => Promise<T>
): Promise<T> {
    await ensureMarketDbReady(db);

    for (let attempt = 0; attempt <= SQLITE_BUSY_RETRY_DELAYS_MS.length; attempt++) {
        try {
            return await operation();
        } catch (error) {
            const delay = SQLITE_BUSY_RETRY_DELAYS_MS[attempt];
            if (!isSqliteBusyError(error) || delay === undefined) {
                throw error;
            }
            if (attempt === 0) {
                console.warn(`[market-db] ${label} waiting for SQLite lock...`);
            }
            await sleep(delay);
        }
    }

    throw new Error(`[market-db] ${label} failed after SQLite lock retries`);
}
