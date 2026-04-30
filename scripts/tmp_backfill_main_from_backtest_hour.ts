import { marketDbMain } from "@/lib/market-db";
import { createBacktestDbClient, ensureBacktestDbSchema } from "@/src/backtest/BacktestDb";

type TickRow = {
    ts: Date | string | number;
    symbol: string;
    markPrice: number;
    indexPrice?: number | null;
    openInterest?: number | null;
    fundingRate?: number | null;
    volume24h?: number | null;
};

type FeatureRow = {
    ts: Date | string | number;
    symbol: string;
    midPrice: number;
    bestBid: number;
    bestAsk: number;
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const start = new Date(required(args.start, "--start ISO timestamp is required"));
    const end = new Date(required(args.end, "--end ISO timestamp is required"));
    const symbols = parseSymbols(required(args.symbols, "--symbols BTC,ETH is required"));
    const sourceDbPath = args["source-db"] ?? "prisma/backtest.db";
    const intervalSeconds = Number(args["interval-seconds"] ?? 10);
    const replace = args.replace === "true";

    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
        throw new Error("Invalid --start/--end window");
    }

    const sourceDb = createBacktestDbClient(sourceDbPath);
    try {
        await ensureBacktestDbSchema(sourceDb);

        for (const symbol of symbols) {
            if (replace) {
                await marketDbMain.marketTick.deleteMany({ where: { symbol, ts: { gte: start, lte: end } } });
                await marketDbMain.marketCandle.deleteMany({ where: { symbol, timeframe: "1m", openTime: { gte: start, lte: end } } });
            }

            const ticks = await sourceDb.$queryRawUnsafe<TickRow[]>(
                `SELECT "ts", "symbol", "markPrice", "indexPrice", "openInterest", "fundingRate", "volume24h"
                 FROM "MarketTick"
                 WHERE "symbol" = ? AND "ts" >= ? AND "ts" <= ?
                 ORDER BY "ts" ASC`,
                symbol,
                start,
                end
            );

            for (const tick of ticks) {
                await marketDbMain.marketTick.create({
                    data: {
                        ts: asDate(tick.ts),
                        symbol,
                        markPrice: Number(tick.markPrice),
                        indexPrice: optionalNumber(tick.indexPrice),
                        openInterest: optionalNumber(tick.openInterest),
                        fundingRate: optionalNumber(tick.fundingRate),
                        volume24h: optionalNumber(tick.volume24h)
                    }
                });
            }

            const featureSymbol = `${symbol}-PERP`;
            const features = await sourceDb.$queryRawUnsafe<FeatureRow[]>(
                `SELECT "ts", "symbol", "midPrice", "bestBid", "bestAsk"
                 FROM "MarketFeature"
                 WHERE "symbol" = ? AND "intervalSeconds" = ? AND "ts" >= ? AND "ts" <= ?
                 ORDER BY "ts" ASC`,
                featureSymbol,
                intervalSeconds,
                start,
                end
            );
            const candles = deriveMinuteCandles(symbol, features);

            for (const candle of candles) {
                await marketDbMain.marketCandle.upsert({
                    where: {
                        symbol_timeframe_openTime: {
                            symbol,
                            timeframe: "1m",
                            openTime: candle.openTime
                        }
                    },
                    update: {
                        high: candle.high,
                        low: candle.low,
                        close: candle.close,
                        volume: candle.volume
                    },
                    create: {
                        symbol,
                        timeframe: "1m",
                        openTime: candle.openTime,
                        open: candle.open,
                        high: candle.high,
                        low: candle.low,
                        close: candle.close,
                        volume: candle.volume
                    }
                });
            }

            console.log(`[tmp-main-backfill] ${symbol}: inserted ${ticks.length} ticks, upserted ${candles.length} 1m candles from ${features.length} feature rows`);
        }
    } finally {
        await sourceDb.$disconnect();
        await marketDbMain.$disconnect();
    }
}

function deriveMinuteCandles(symbol: string, rows: FeatureRow[]) {
    const buckets = new Map<number, FeatureRow[]>();
    for (const row of rows) {
        const minute = Math.floor(asDate(row.ts).getTime() / 60_000) * 60_000;
        const bucket = buckets.get(minute) ?? [];
        bucket.push(row);
        buckets.set(minute, bucket);
    }

    return Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]).map(([minute, bucket]) => {
        const sorted = bucket.sort((a, b) => asDate(a.ts).getTime() - asDate(b.ts).getTime());
        const mids = sorted.map(row => Number(row.midPrice)).filter(Number.isFinite);
        const lows = sorted.map(row => Math.min(Number(row.midPrice), Number(row.bestBid))).filter(Number.isFinite);
        const highs = sorted.map(row => Math.max(Number(row.midPrice), Number(row.bestAsk))).filter(Number.isFinite);
        return {
            symbol,
            openTime: new Date(minute),
            open: mids[0] ?? 0,
            high: Math.max(...highs, mids[0] ?? 0),
            low: Math.min(...lows, mids[0] ?? 0),
            close: mids[mids.length - 1] ?? mids[0] ?? 0,
            volume: 0
        };
    }).filter(candle => candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0);
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

function parseSymbols(value: string): string[] {
    return value.split(",").map(symbol => symbol.trim().replace(/-PERP$/, "")).filter(Boolean);
}

function required(value: string | undefined, message: string): string {
    if (!value) throw new Error(message);
    return value;
}

function asDate(value: Date | string | number): Date {
    return value instanceof Date ? value : new Date(value);
}

function optionalNumber(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
