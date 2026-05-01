import { FeatureStore } from "@/src/backtest/FeatureStore";
import { MarketFeatureRow } from "@/src/backtest/BacktestTypes";
import { PrismaClient } from "@prisma/market-client";
import { createBacktestDbClient, ensureBacktestDbSchema } from "@/src/backtest/BacktestDb";
import { hydrateRealCandlesForBacktest } from "@/src/backtest/RealCandleHydrator";

type Candle = {
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const symbols = required(args.symbols, "--symbols BTC,ETH,SOL is required").split(",").map(s => s.trim()).filter(Boolean);
    const start = new Date(required(args.start, "--start ISO timestamp is required"));
    const end = new Date(required(args.end, "--end ISO timestamp is required"));
    const network = (args.network ?? "mainnet") as "mainnet" | "testnet";
    const fromFeatures = args["from-features"] === "true";
    const db = createDb(args.db);
    await ensureBacktestDbSchema(db);
    const batchSize = Number(args["batch-size"] ?? 500);

    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
        throw new Error("Invalid --start/--end window");
    }

    if (!fromFeatures) {
        await hydrateRealCandlesForBacktest({
            symbols,
            network,
            start,
            end,
            dbPath: args.db,
            concurrency: Number(args.concurrency ?? 4)
        });
        await db.$disconnect();
        return;
    }

    for (const symbol of symbols) {
        const candles = await deriveCandlesFromFeatures(symbol, network, start, end, Number(args["interval-seconds"] ?? 10), args.db);
        for (let i = 0; i < candles.length; i += batchSize) {
            const batch = candles.slice(i, i + batchSize);
            await db.$transaction(batch.map(candle => insertSyntheticCandleIfAbsent(db, symbol, candle)));
        }
        console.log(`[backtest:candles] ${symbol}: upserted ${candles.length} 1m candles from features`);
    }
}

function createDb(dbPath?: string): PrismaClient {
    return createBacktestDbClient(dbPath);
}

function insertSyntheticCandleIfAbsent(db: PrismaClient, symbol: string, candle: Candle) {
    return db.$executeRawUnsafe(
        `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume", "source")
         VALUES (?, '1m', ?, ?, ?, ?, ?, ?, 'synthetic_from_features')
         ON CONFLICT("symbol", "timeframe", "openTime") DO NOTHING`,
        symbol,
        new Date(candle.t),
        Number(candle.o),
        Number(candle.h),
        Number(candle.l),
        Number(candle.c),
        Number(candle.v)
    );
}

async function deriveCandlesFromFeatures(
    symbol: string,
    network: "mainnet" | "testnet",
    start: Date,
    end: Date,
    intervalSeconds: number,
    dbPath?: string
): Promise<Candle[]> {
    const store = new FeatureStore({ network, dbPath });
    const rows = await store.getRows(start, end, intervalSeconds, [`${symbol}-PERP`]);
    await store.close();

    return rows
        .slice()
        .sort((a, b) => a.ts.getTime() - b.ts.getTime())
        .map(row => ({
            t: row.ts.getTime(),
            o: String(row.mid_price),
            h: String(Math.max(row.mid_price, row.best_ask)),
            l: String(Math.min(row.mid_price, row.best_bid)),
            c: String(row.mid_price),
            v: "0"
        }));
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

function required(value: string | undefined, message: string): string {
    if (!value) throw new Error(message);
    return value;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
