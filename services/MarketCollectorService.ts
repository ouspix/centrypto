import { getMetaAndAssetCtxs, getOHLCV } from "@/lib/hyperliquid";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { HyperliquidWS } from "@/lib/hyperliquid-ws";

export class MarketCollectorService {
    // Backfill 48 hours of history on startup
    private readonly MAX_LOOKBACK_MS = 48 * 60 * 60 * 1000;

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
     * Starts the WebSocket stream to collect live candles.
     * @param isTestnet
     */
    public async startCandleStream(isTestnet: boolean): Promise<void> {
        const db = isTestnet ? marketDbTest : marketDbMain;
        const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);

        if (!metaAndCtxs) {
            console.error("[MarketCollector] Failed to fetch universe for WS subscription.");
            return;
        }

        const { universe } = metaAndCtxs;
        const symbols = universe.map(u => u.name);

        const ws = new HyperliquidWS(isTestnet);

        // Buffer for batch writing
        let candleBuffer: any[] = [];
        const FLUSH_INTERVAL = 1000; // Write to DB every 1 second

        ws.on('candle', (c: any) => {
            // c is { t, T, s, i, o, c, h, l, v, n }
            // Only process 1m candles (though we only subscribe to 1m)
            if (c.i !== '1m') return;

            candleBuffer.push({
                symbol: c.s,
                timeframe: '1m',
                openTime: new Date(c.t),
                open: parseFloat(c.o),
                high: parseFloat(c.h),
                low: parseFloat(c.l),
                close: parseFloat(c.c),
                volume: parseFloat(c.v)
            });
        });

        ws.on('open', () => {
            console.log(`[MarketCollector] WS Connected. Subscribing to ${symbols.length} symbols...`);
            ws.subscribeToCandles(symbols);
        });

        ws.connect();

        // Flush loop
        setInterval(async () => {
            if (candleBuffer.length === 0) return;

            const batch = [...candleBuffer];
            candleBuffer = []; // Clear buffer

            try {
                // Use transaction for batch upsert
                await db.$transaction(
                    batch.map(candle =>
                        db.marketCandle.upsert({
                            where: {
                                symbol_timeframe_openTime: {
                                    symbol: candle.symbol,
                                    timeframe: candle.timeframe,
                                    openTime: candle.openTime
                                }
                            },
                            update: {
                                high: candle.high,
                                low: candle.low,
                                close: candle.close,
                                volume: candle.volume
                            },
                            create: candle
                        })
                    )
                );
                // console.log(`[MarketCollector] Flushed ${batch.length} candle updates.`);
            } catch (error) {
                console.error(`[MarketCollector] Error flushing candle buffer:`, error);
                // Optionally re-add to buffer? No, live data moves fast, better to skip than clog.
            }
        }, FLUSH_INTERVAL);
    }

    /**
     * Backfills missing history for all symbols on startup.
     * Limits lookback to ~80 hours as requested.
     */
    public async backfillHistory(isTestnet: boolean, force: boolean = false): Promise<void> {
        console.log(`[MarketCollector] Starting backfill for ${isTestnet ? 'Testnet' : 'Mainnet'}...`);
        const db = isTestnet ? marketDbTest : marketDbMain;
        const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);

        if (!metaAndCtxs) {
            console.warn("[MarketCollector] Failed to fetch universe for backfill.");
            return;
        }

        const { universe } = metaAndCtxs;
        // Process in batches to balance speed and rate limits
        // Batch size of 50 with 1s delay = ~3000 requests/min (too fast? No, 50 * 1 = 50 req/batch)
        // Actually, we want to be safe.
        const CHUNK_SIZE = 50;

        // Process sequentially to avoid SQLite database locking/timeouts
        let processedCount = 0;
        for (let i = 0; i < universe.length; i += CHUNK_SIZE) {
            const batch = universe.slice(i, i + CHUNK_SIZE);

            await Promise.all(batch.map(async (asset) => {
                try {
                    const symbol = asset.name;

                    // Smart Check: Do we need to backfill?
                    const latestCandle = await db.marketCandle.findFirst({
                        where: { symbol: asset.name, timeframe: "1m" },
                        orderBy: { openTime: 'desc' }
                    });

                    const now = Date.now();
                    let startTime = now - this.MAX_LOOKBACK_MS;

                    if (latestCandle && !force) {
                        const candleCount = await db.marketCandle.count({
                            where: {
                                symbol: asset.name,
                                timeframe: "1m",
                                openTime: { gte: new Date(now - this.MAX_LOOKBACK_MS) }
                            }
                        });

                        const expectedCount = (this.MAX_LOOKBACK_MS / 60000);
                        const missingDataThreshold = expectedCount * 0.95;

                        if (candleCount >= missingDataThreshold) {
                            startTime = Math.max(startTime, latestCandle.openTime.getTime() + 60000);
                            if (now - startTime < 2 * 60000) {
                                // console.log(`[Backfill] ${symbol} is up-to-date or within 2 minutes. Skipping.`);
                                return;
                            }
                        } else {
                            if (candleCount < missingDataThreshold) {
                                // console.log(`[Backfill] Detected gap for ${symbol}`);
                            }
                        }

                        // 3. Fetch History
                        const candles = await getOHLCV(symbol, "1m", isTestnet, startTime);

                        if (candles && candles.length > 0) {
                            // Upsert candles in a transaction
                            await db.$transaction(
                                candles.map((c: any) =>
                                    db.marketCandle.upsert({
                                        where: {
                                            symbol_timeframe_openTime: {
                                                symbol,
                                                timeframe: "1m",
                                                openTime: new Date(c.t)
                                            }
                                        },
                                        update: {
                                            high: parseFloat(c.h),
                                            low: parseFloat(c.l),
                                            close: parseFloat(c.c),
                                            volume: parseFloat(c.v)
                                        },
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
                            console.log(`[Backfill] Inserted ${candles.length} candles for ${symbol}`);
                        }
                    }
                } catch (error) {
                    console.error(`[Backfill] Error processing ${asset.name}:`, error);
                }
            }));

            processedCount += batch.length;
            console.log(`[Backfill] Processed ${processedCount}/${universe.length} symbols...`);

            // Rate limit delay between batches
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.log(`[MarketCollector] Backfill complete for ${isTestnet ? 'Testnet' : 'Mainnet'}.`);
    }
}
