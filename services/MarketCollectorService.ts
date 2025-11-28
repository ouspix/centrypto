import { getMetaAndAssetCtxs, getOHLCV } from "@/lib/hyperliquid";
import { marketDbMain, marketDbTest } from "@/lib/market-db";

export class MarketCollectorService {
    /**
     * Collects a snapshot of the entire market (ticks) and saves it to the DB.
     * @param isTestnet Whether to collect for testnet or mainnet
     */
    public async collectTicks(isTestnet: boolean): Promise<void> {
        try {
            const db = isTestnet ? marketDbTest : marketDbMain;
            const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);

            if (!metaAndCtxs) {
                console.warn(`[MarketCollector] No data received for ${isTestnet ? 'Testnet' : 'Mainnet'}`);
                return;
            }

            const { universe, assetCtxs } = metaAndCtxs;
            const now = new Date();

            const rows = universe.map((asset, i) => {
                const ctx = assetCtxs[i];
                // Safety check for missing data
                if (!ctx) return null;

                return {
                    ts: now,
                    symbol: asset.name,
                    markPrice: parseFloat(ctx.markPx),
                    indexPrice: ctx.indexPx ? parseFloat(ctx.indexPx) : parseFloat(ctx.markPx),
                    openInterest: ctx.openInterest ? parseFloat(ctx.openInterest) * parseFloat(ctx.markPx) : 0,
                    fundingRate: ctx.funding ? parseFloat(ctx.funding) : 0,
                    volume24h: ctx.dayNtlVlm ? parseFloat(ctx.dayNtlVlm) : 0,
                    // Optional book data if available in this context (usually not in metaAndAssetCtxs, requires L2)
                    // We leave them null for now as per "thin row" requirement
                };
            }).filter((row): row is NonNullable<typeof row> => row !== null);

            if (rows.length > 0) {
                await db.marketTick.createMany({
                    data: rows,
                });
                console.log(`[MarketCollector] Saved ${rows.length} ticks for ${isTestnet ? 'Testnet' : 'Mainnet'}`);
            }
        } catch (error) {
            console.error(`[MarketCollector] Error collecting ticks for ${isTestnet ? 'Testnet' : 'Mainnet'}:`, error);
        }
    }

    /**
   * Aggregates ticks into candles for a specific timeframe.
   * @param isTestnet
   * @param timeframe e.g., "1m"
   */
    public async aggregateCandles(isTestnet: boolean, timeframe: string = "1m"): Promise<void> {
        const db = isTestnet ? marketDbTest : marketDbMain;

        // Only support 1m for now
        if (timeframe !== "1m") {
            console.warn(`[MarketCollector] Aggregation for ${timeframe} not supported yet.`);
            return;
        }

        const bucketSizeMs = 60 * 1000;

        try {
            // 1. Get the last candle time for any symbol to know where to start?
            // Or just aggregate everything that hasn't been aggregated?
            // A simple approach: Aggregate the last N minutes, handling duplicates via upsert.

            // Let's aggregate the last 5 minutes to be safe and cover gaps.
            const now = Date.now();
            const fiveMinutesAgo = new Date(now - 5 * 60 * 1000);

            // Get all ticks since 5 minutes ago
            const ticks = await db.marketTick.findMany({
                where: {
                    ts: {
                        gte: fiveMinutesAgo
                    }
                },
                orderBy: {
                    ts: 'asc'
                }
            });

            if (ticks.length === 0) return;

            // Group by symbol and minute bucket
            const candlesMap = new Map<string, {
                symbol: string;
                openTime: Date;
                open: number;
                high: number;
                low: number;
                close: number;
                volume: number;
                firstVol24h: number;
                lastVol24h: number;
            }>();

            for (const tick of ticks) {
                const tickTime = tick.ts.getTime();
                const bucketStart = Math.floor(tickTime / bucketSizeMs) * bucketSizeMs;
                const key = `${tick.symbol}-${bucketStart}`;

                if (!candlesMap.has(key)) {
                    candlesMap.set(key, {
                        symbol: tick.symbol,
                        openTime: new Date(bucketStart),
                        open: tick.markPrice,
                        high: tick.markPrice,
                        low: tick.markPrice,
                        close: tick.markPrice,
                        volume: 0,
                        // Track first and last vol24h for this bucket to estimate volume
                        firstVol24h: tick.volume24h || 0,
                        lastVol24h: tick.volume24h || 0
                    });
                } else {
                    const candle = candlesMap.get(key)!;
                    candle.high = Math.max(candle.high, tick.markPrice);
                    candle.low = Math.min(candle.low, tick.markPrice);
                    candle.close = tick.markPrice;
                    candle.lastVol24h = tick.volume24h || 0;
                }
            }

            // Calculate volume for each candle
            for (const candle of candlesMap.values()) {
                // Estimate quote volume delta
                const quoteVolDelta = Math.max(0, candle.lastVol24h - candle.firstVol24h);

                // Convert to base volume (approximate using close price)
                if (candle.close > 0) {
                    candle.volume = quoteVolDelta / candle.close;
                }
            }

            // Upsert candles
            const candles = Array.from(candlesMap.values());

            // Prisma doesn't support createMany with skipDuplicates for SQLite in all versions, 
            // but we can use upsert in a loop or createMany and ignore errors (if supported).
            // SQLite supports createMany but not skipDuplicates in older Prisma versions? 
            // Actually Prisma 5+ supports it.
            // But `upsert` is safer for updates. However, createMany is faster.
            // Let's try createMany and catch errors, or just loop upsert for safety.

            // Use transaction for upserts to reduce overhead and locking time
            if (candles.length > 0) {
                await db.$transaction(
                    candles.map(candle =>
                        db.marketCandle.upsert({
                            where: {
                                symbol_timeframe_openTime: {
                                    symbol: candle.symbol,
                                    timeframe: timeframe,
                                    openTime: candle.openTime
                                }
                            },
                            update: {
                                high: Math.max(candle.high, candle.high),
                                low: Math.min(candle.low, candle.low),
                                close: candle.close,
                                volume: candle.volume
                            },
                            create: {
                                symbol: candle.symbol,
                                timeframe: timeframe,
                                openTime: candle.openTime,
                                open: candle.open,
                                high: candle.high,
                                low: candle.low,
                                close: candle.close,
                                volume: candle.volume
                            }
                        })
                    )
                );
            }

            console.log(`[MarketCollector] Aggregated ${candles.length} candles for ${isTestnet ? 'Testnet' : 'Mainnet'}`);

        } catch (error) {
            console.error(`[MarketCollector] Error aggregating candles:`, error);
        }
    }

    /**
     * Backfills missing history for all symbols on startup.
     * Limits lookback to ~80 hours as requested.
     */
    public async backfillHistory(isTestnet: boolean): Promise<void> {
        console.log(`[MarketCollector] Starting backfill for ${isTestnet ? 'Testnet' : 'Mainnet'}...`);
        const db = isTestnet ? marketDbTest : marketDbMain;
        const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);

        if (!metaAndCtxs) {
            console.warn("[MarketCollector] Failed to fetch universe for backfill.");
            return;
        }

        const { universe } = metaAndCtxs;
        const BATCH_SIZE = 10;
        const MAX_LOOKBACK_MS = 80 * 60 * 60 * 1000; // 80 hours

        // Process in batches
        // Process sequentially to avoid SQLite database locking/timeouts
        let processedCount = 0;
        for (const asset of universe) {
            try {
                const symbol = asset.name;

                // 1. Check latest candle
                const latestCandle = await db.marketCandle.findFirst({
                    where: { symbol, timeframe: "1m" },
                    orderBy: { openTime: 'desc' }
                });

                // 2. Determine start time
                const now = Date.now();
                let startTime = now - MAX_LOOKBACK_MS;

                if (latestCandle) {
                    startTime = Math.max(startTime, latestCandle.openTime.getTime() + 60000);
                }

                // If gap is small (< 2 mins), skip
                if (now - startTime < 2 * 60000) continue;

                // 3. Fetch missing candles
                // console.log(`[Backfill] Fetching ${symbol} from ${new Date(startTime).toISOString()}`);
                const candles = await getOHLCV(symbol, "1m", isTestnet, startTime);

                if (candles.length === 0) continue;

                // 4. Save to DB
                // Split into smaller chunks to avoid "Transaction too large" or timeouts
                const CHUNK_SIZE = 500;
                for (let i = 0; i < candles.length; i += CHUNK_SIZE) {
                    const chunk = candles.slice(i, i + CHUNK_SIZE);
                    await db.$transaction(
                        chunk.map((c: any) =>
                            db.marketCandle.upsert({
                                where: {
                                    symbol_timeframe_openTime: {
                                        symbol: symbol,
                                        timeframe: "1m",
                                        openTime: new Date(c.t)
                                    }
                                },
                                update: {}, // Don't overwrite existing if we overlap slightly
                                create: {
                                    symbol,
                                    timeframe: "1m",
                                    openTime: new Date(c.t),
                                    open: parseFloat(c.o),
                                    high: parseFloat(c.h),
                                    low: parseFloat(c.l),
                                    close: parseFloat(c.c),
                                    volume: parseFloat(c.v)
                                }
                            })
                        )
                    );
                }
                // console.log(`[Backfill] Filled ${candles.length} candles for ${symbol}`);

            } catch (error) {
                console.error(`[Backfill] Error processing ${asset.name}:`, error);
            }

            processedCount++;
            // Progress log every 10 symbols
            if (processedCount % 10 === 0) {
                console.log(`[Backfill] Processed ${processedCount}/${universe.length} symbols...`);
            }
        }
        console.log(`[MarketCollector] Backfill complete for ${isTestnet ? 'Testnet' : 'Mainnet'}.`);
    }
}
