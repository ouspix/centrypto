import { waitForHyperliquidSlot } from "@/lib/hyperliquid-info";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { createBacktestDbClient, ensureBacktestDbSchema } from "@/src/backtest/BacktestDb";

type Network = "mainnet" | "testnet";

type Candle = {
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
};

type TickRow = {
    ts: Date | string | number;
    symbol: string;
    markPrice: number;
    indexPrice?: number | null;
    openInterest?: number | null;
    fundingRate?: number | null;
    volume24h?: number | null;
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const symbols = parseSymbols(required(args.symbols, "--symbols BTC,ETH is required"));
    const start = new Date(required(args.start, "--start ISO timestamp is required"));
    const end = new Date(required(args.end, "--end ISO timestamp is required"));
    const network = (args.network ?? "mainnet") as Network;
    const sourceDbPath = args["source-db"] ?? "prisma/backtest.db";
    const copyTicks = args["copy-ticks"] !== "false";
    const fetchCandlesEnabled = args["fetch-candles"] !== "false";
    const db = network === "testnet" ? marketDbTest : marketDbMain;

    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
        throw new Error("Invalid --start/--end window");
    }

    for (const symbol of symbols) {
        if (fetchCandlesEnabled) {
            const candles = await fetchCandles(symbol, network, start, end);
            for (const candle of candles) {
                await db.marketCandle.upsert({
                    where: {
                        symbol_timeframe_openTime: {
                            symbol,
                            timeframe: "1m",
                            openTime: new Date(candle.t)
                        }
                    },
                    update: {
                        high: Number(candle.h),
                        low: Number(candle.l),
                        close: Number(candle.c),
                        volume: Number(candle.v)
                    },
                    create: {
                        symbol,
                        timeframe: "1m",
                        openTime: new Date(candle.t),
                        open: Number(candle.o),
                        high: Number(candle.h),
                        low: Number(candle.l),
                        close: Number(candle.c),
                        volume: Number(candle.v)
                    }
                });
            }
            console.log(`[live-window] ${network} ${symbol}: upserted ${candles.length} 1m candles`);
        }

        if (copyTicks) {
            const rows = await loadSourceTicks(sourceDbPath, symbol, start, end);
            if (rows.length === 0) {
                console.warn(`[live-window] ${symbol}: no source ticks found in ${sourceDbPath}`);
            }
            for (const row of rows) {
                await db.marketTick.create({
                    data: {
                        ts: asDate(row.ts),
                        symbol,
                        markPrice: Number(row.markPrice),
                        indexPrice: row.indexPrice === null || row.indexPrice === undefined ? undefined : Number(row.indexPrice),
                        openInterest: row.openInterest === null || row.openInterest === undefined ? undefined : Number(row.openInterest),
                        fundingRate: row.fundingRate === null || row.fundingRate === undefined ? undefined : Number(row.fundingRate),
                        volume24h: row.volume24h === null || row.volume24h === undefined ? undefined : Number(row.volume24h)
                    }
                });
            }
            console.log(`[live-window] ${network} ${symbol}: inserted ${rows.length} non-L2 tick rows`);
        }
    }
}

async function fetchCandles(symbol: string, network: Network, start: Date, end: Date): Promise<Candle[]> {
    const apiUrl = network === "testnet"
        ? "https://api.hyperliquid-testnet.xyz/info"
        : "https://api.hyperliquid.xyz/info";
    await waitForHyperliquidSlot();
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            type: "candleSnapshot",
            req: {
                coin: symbol,
                interval: "1m",
                startTime: start.getTime(),
                endTime: end.getTime()
            }
        })
    });
    if (!res.ok) throw new Error(`candleSnapshot failed for ${symbol}: ${res.status} ${await res.text()}`);
    const payload = await res.json();
    return Array.isArray(payload)
        ? payload.filter((c: Candle) => c.t >= start.getTime() && c.t <= end.getTime())
        : [];
}

async function loadSourceTicks(dbPath: string, symbol: string, start: Date, end: Date): Promise<TickRow[]> {
    const db = createBacktestDbClient(dbPath);
    try {
        await ensureBacktestDbSchema(db);
        return await db.$queryRawUnsafe<TickRow[]>(
            `SELECT "ts", "symbol", "markPrice", "indexPrice", "openInterest", "fundingRate", "volume24h"
             FROM "MarketTick"
             WHERE "symbol" = ? AND "ts" >= ? AND "ts" <= ?
             ORDER BY "ts" ASC`,
            symbol,
            start,
            end
        );
    } finally {
        await db.$disconnect();
    }
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

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await marketDbMain.$disconnect();
        await marketDbTest.$disconnect();
    });
