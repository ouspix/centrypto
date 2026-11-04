import { PrismaClient } from "@prisma/market-client";

// Both clients connect directly to the VPS. There is no local market replica.
const globalForMarketDb = globalThis as unknown as { marketDbMain?: PrismaClient; marketDbTest?: PrismaClient };
const unconfigured = "postgresql://unconfigured:unconfigured@127.0.0.1:1/unconfigured?connect_timeout=2&connection_limit=1";
function createClient(variable: "MARKET_DATABASE_URL" | "MARKET_TEST_DATABASE_URL") {
    const url = process.env[variable] || unconfigured;
    if (!/^postgres(?:ql)?:\/\//.test(url)) throw new Error(`${variable} must point to VPS PostgreSQL, not a local SQLite file`);
    return new PrismaClient({ datasources: { db: { url } }, log: ["error", "warn"] });
}
export const marketDbMain = globalForMarketDb.marketDbMain ?? createClient("MARKET_DATABASE_URL");
export const marketDbTest = globalForMarketDb.marketDbTest ?? createClient("MARKET_TEST_DATABASE_URL");
if (process.env.NODE_ENV !== "production") { globalForMarketDb.marketDbMain = marketDbMain; globalForMarketDb.marketDbTest = marketDbTest; }
export async function ensureMarketDbReady(db: PrismaClient) { await db.$connect(); }
export async function getMarketDb(isTestnet: boolean) { const db = isTestnet ? marketDbTest : marketDbMain; await ensureMarketDbReady(db); return db; }
export async function withMarketDbRetry<T>(db: PrismaClient, _label: string, operation: () => Promise<T>): Promise<T> {
    await ensureMarketDbReady(db);
    for (let attempt = 0; ; attempt++) {
        try { return await operation(); }
        catch (error) {
            // Retry rolled-back transactions, never ambiguous connection failures on writes.
            if (attempt >= 3 || (error as { code?: string }).code !== "P2034") throw error;
            await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
        }
    }
}
