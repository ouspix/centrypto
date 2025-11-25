import { PrismaClient } from '@prisma/market-client';
import path from 'path';

// Helper to create a client for a specific DB file
const createClient = (dbFileName: string) => {
    const dbPath = path.join(process.cwd(), 'prisma', dbFileName);
    return new PrismaClient({
        datasources: {
            db: {
                url: `file:${dbPath}`,
            },
        },
        log: ['error', 'warn'],
    });
};

// Global object to prevent multiple instances in dev
const globalForMarketDb = globalThis as unknown as {
    marketDbMain?: PrismaClient;
    marketDbTest?: PrismaClient;
};

export const marketDbMain =
    globalForMarketDb.marketDbMain ??
    createClient('md_main.db');

export const marketDbTest =
    globalForMarketDb.marketDbTest ??
    createClient('md_test.db');

if (process.env.NODE_ENV !== 'production') {
    globalForMarketDb.marketDbMain = marketDbMain;
    globalForMarketDb.marketDbTest = marketDbTest;
}
