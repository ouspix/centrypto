import { getOHLCV, getL2Book } from "@/lib/hyperliquid";
import { prisma } from "@/lib/db";

export type MarketMetrics = {
    returns: {
        m1: number;
        m5: number;
        m15: number;
        h1: number;
        h4: number;
    };
    realized_vol: {
        m1: number;
        m5: number;
        m15: number;
        h1: number;
        h4: number;
    };
    vol_zscores: {
        vol_5m_vs_1h: number;
        ret_5m_vs_1h: number;
    };
    regime_tags: string[];
};

export type OrderBookMetrics = {
    spread_bps: number;
    depth_usd: {
        bid_1pct: number;
        ask_1pct: number;
    };
    imbalance: number; // bid/ask ratio
};

type Candle = {
    t: number; // timestamp
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
};

export class MarketAnalysisService {
    // In-memory cache: symbol -> candles[]
    private candleCache: Record<string, Candle[]> = {};

    public async getMetricsForSymbol(symbol: string, isTestnet: boolean): Promise<MarketMetrics> {
        // 1. Fetch 1m candles with caching
        const candles = await this.fetchCandlesWithCache(symbol, isTestnet);

        // Initialize defaults
        const metrics: MarketMetrics = {
            returns: { m1: 0, m5: 0, m15: 0, h1: 0, h4: 0 },
            realized_vol: { m1: 0, m5: 0, m15: 0, h1: 0, h4: 0 },
            vol_zscores: { vol_5m_vs_1h: 0, ret_5m_vs_1h: 0 },
            regime_tags: []
        };

        if (!candles || candles.length === 0) return metrics;

        const current = candles[candles.length - 1];
        const close = parseFloat(current.c);

        // 2. Calculate Returns (using 1m candles)
        // Helper to get return over N minutes
        const getReturn = (minutes: number) => {
            if (candles.length <= minutes) return 0;
            const past = parseFloat(candles[candles.length - 1 - minutes].c); // Use close-to-close for simplicity or open of N mins ago
            // Standard is close - open of N mins ago, or close - close of N mins ago. 
            // Let's use (Current Close - Close N mins ago) / Close N mins ago
            const pastClose = parseFloat(candles[candles.length - 1 - minutes].c);
            return (close - pastClose) / pastClose;
        };

        // Special case for m1: use current candle's open vs close (intraday) or last closed candle?
        // If we want "current market state", we use latest candle.
        const open1m = parseFloat(current.o);
        metrics.returns.m1 = (close - open1m) / open1m; // Current minute return

        metrics.returns.m5 = getReturn(5);
        metrics.returns.m15 = getReturn(15);
        metrics.returns.h1 = getReturn(60);
        metrics.returns.h4 = getReturn(240);

        // 3. Calculate Realized Volatility (Std Dev of 1m log returns over window)
        // We need log returns array first
        const logReturns: number[] = [];
        for (let i = 1; i < candles.length; i++) {
            const p1 = parseFloat(candles[i].c);
            const p0 = parseFloat(candles[i - 1].c);
            logReturns.push(Math.log(p1 / p0));
        }

        const calcVol = (windowMinutes: number) => {
            if (logReturns.length < windowMinutes) return 0;
            const slice = logReturns.slice(-windowMinutes);
            const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
            const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length;
            return Math.sqrt(variance);
        };

        metrics.realized_vol.m1 = calcVol(5);   // 5 min window
        metrics.realized_vol.m5 = calcVol(15);  // 15 min window
        metrics.realized_vol.m15 = calcVol(30); // 30 min window
        metrics.realized_vol.h1 = calcVol(60);  // 1h window
        metrics.realized_vol.h4 = calcVol(240); // 4h window

        // 4. Calculate Z-Scores
        // ret_5m_z = ret_5m / realized_vol_1h
        // vol_5m_z = realized_vol_5m / realized_vol_1h

        // Avoid division by zero
        const vol1h = metrics.realized_vol.h1 || 0.001;

        metrics.vol_zscores.ret_5m_vs_1h = metrics.returns.m5 / vol1h;

        // For vol z-score, we compare current 5m vol (short window) vs 1h vol (long window)
        // User said: vol_5m_z = realized_vol_5m / realized_vol_1h
        // Here realized_vol_5m is likely "volatility calculated over 5m window"
        metrics.vol_zscores.vol_5m_vs_1h = metrics.realized_vol.m1 / vol1h; // Using 5m window vol (m1 metric above) vs 1h window

        // 5. Regime Tags
        if (metrics.vol_zscores.vol_5m_vs_1h > 2.0) metrics.regime_tags.push("high_intraday_vol");
        if (metrics.vol_zscores.vol_5m_vs_1h < 0.5) metrics.regime_tags.push("low_vol_compression");

        if (metrics.vol_zscores.ret_5m_vs_1h > 2.0) metrics.regime_tags.push("fast_move_up");
        if (metrics.vol_zscores.ret_5m_vs_1h < -2.0) metrics.regime_tags.push("fast_move_down");

        return metrics;
    }

    public async getOrderBookMetrics(symbol: string, isTestnet: boolean): Promise<OrderBookMetrics> {
        const book = await getL2Book(symbol, isTestnet);

        const metrics: OrderBookMetrics = {
            spread_bps: 0,
            depth_usd: { bid_1pct: 0, ask_1pct: 0 },
            imbalance: 1
        };

        if (!book || !book.levels) return metrics;

        const bids = book.levels[0]; // Array of {px, sz, n}
        const asks = book.levels[1];

        if (bids.length > 0 && asks.length > 0) {
            const bestBid = parseFloat(bids[0].px);
            const bestAsk = parseFloat(asks[0].px);
            const midPrice = (bestBid + bestAsk) / 2;

            // Spread
            const spread = bestAsk - bestBid;
            metrics.spread_bps = (spread / midPrice) * 10000;

            // Depth within 1%
            const calculateDepth = (levels: any[], isBid: boolean) => {
                let depth = 0;
                for (const level of levels) {
                    const px = parseFloat(level.px);
                    const sz = parseFloat(level.sz);
                    const dist = Math.abs(px - midPrice) / midPrice;
                    if (dist <= 0.01) {
                        depth += px * sz;
                    } else {
                        break; // Sorted by price, so we can stop
                    }
                }
                return depth;
            };

            metrics.depth_usd.bid_1pct = calculateDepth(bids, true);
            metrics.depth_usd.ask_1pct = calculateDepth(asks, false);

            // Imbalance
            if (metrics.depth_usd.ask_1pct > 0) {
                metrics.imbalance = metrics.depth_usd.bid_1pct / metrics.depth_usd.ask_1pct;
            }
        }

        return metrics;
    }

    private async fetchCandlesWithCache(symbol: string, isTestnet: boolean): Promise<Candle[]> {
        // 1. Get latest candle from DB
        const latestCandle = await prisma.candle.findFirst({
            where: { symbol, interval: "1m" },
            orderBy: { t: 'desc' }
        });

        // 2. Determine start time
        // If no data, fetch last 4.5 hours (approx 270 mins)
        // If data, fetch from last candle time + 1ms
        let startTime = Date.now() - (4.5 * 60 * 60 * 1000);
        if (latestCandle) {
            startTime = Number(latestCandle.t) + 1;
        }

        // 3. Fetch new candles from API (with retry logic handled in getOHLCV)
        let newCandles: Candle[] = [];
        try {
            newCandles = await getOHLCV(symbol, "1m", isTestnet, startTime);
        } catch (err) {
            console.error(`[MarketAnalysis] Failed to fetch new candles for ${symbol}, using cached only.`);
        }

        // 4. Save new candles to DB
        if (newCandles && newCandles.length > 0) {
            // console.log(`[MarketAnalysis] Saving ${newCandles.length} new candles for ${symbol}`);

            // Filter out any that might overlap or be invalid
            const validCandles = newCandles.filter(c => c.t > (latestCandle ? Number(latestCandle.t) : 0));

            if (validCandles.length > 0) {
                // SQLite doesn't support skipDuplicates in createMany.
                // We use a transaction of upserts to handle duplicates safely.
                await prisma.$transaction(
                    validCandles.map((c: Candle) =>
                        prisma.candle.upsert({
                            where: {
                                symbol_interval_t: {
                                    symbol: symbol,
                                    interval: "1m",
                                    t: BigInt(c.t)
                                }
                            },
                            update: {}, // No-op if exists
                            create: {
                                symbol,
                                interval: "1m",
                                t: BigInt(c.t),
                                o: parseFloat(c.o),
                                h: parseFloat(c.h),
                                l: parseFloat(c.l),
                                c: parseFloat(c.c),
                                v: parseFloat(c.v)
                            }
                        })
                    )
                );
            }
        }

        // 5. Return combined data (last 4.5h is enough for metrics)
        // We query the DB for the last 4.5h to ensure we have a consistent view
        const lookbackWindow = Date.now() - (4.5 * 60 * 60 * 1000);
        const dbCandles = await prisma.candle.findMany({
            where: {
                symbol,
                interval: "1m",
                t: { gte: lookbackWindow }
            },
            orderBy: { t: 'asc' }
        });

        return dbCandles.map(c => ({
            t: Number(c.t),
            o: c.o.toString(),
            h: c.h.toString(),
            l: c.l.toString(),
            c: c.c.toString(),
            v: c.v.toString()
        }));
    }
}
