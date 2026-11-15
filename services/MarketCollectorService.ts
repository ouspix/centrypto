import { getMetaAndAssetCtxs, getOHLCV } from "@/lib/hyperliquid-info";
import { getMarketDb, marketDbMain, withMarketDbRetry } from "@/lib/market-db";
import { HyperliquidWS } from "@/lib/hyperliquid-ws";
import { ActiveMarket, activeMarketAssets, buildMarketTickRow } from "./MarketUniverse";
import { candleObservation } from "@/lib/market-observations";

type MarketDb = typeof marketDbMain;

export class MarketCollectorService {
    // Backfill 48 hours of history on startup
    private readonly MAX_LOOKBACK_MS = 48 * 60 * 60 * 1000;
    // Space out backfill API calls to avoid HL burst limits (≈1.25 rps by default)
    private readonly BACKFILL_REQUEST_SPACING_MS = 800;
    private readonly books = new Map<string, { at: number; receivedAt: Date; bid: number; bidSize: number; ask: number; askSize: number }>();
    private readonly bookCoins = new Set((process.env.COLLECTOR_BOOK_SYMBOLS || "BTC,ETH,SOL,HYPE,BNB,XRP,DOGE,LINK")
        .split(",").map(s => s.trim()).filter(Boolean).slice(0, 20));

    /**
     * Collects a snapshot of the entire market (ticks) and saves it to the DB.
     * @param isTestnet Whether to collect for testnet or mainnet
     */
    public async collectTicks(isTestnet: boolean): Promise<void> {
        this.assertWorker();
        try {
            const db = await getMarketDb(isTestnet);
            const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);

            if (!metaAndCtxs) {
                console.warn(`[MarketCollector] No data received for ${isTestnet ? 'Testnet' : 'Mainnet'}`);
                return;
            }

            const { universe, assetCtxs } = metaAndCtxs;
            await this.writeTickSnapshot(db, activeMarketAssets(universe, assetCtxs), isTestnet);
        } catch (error) {
            console.error(`[MarketCollector] Error collecting ticks for ${isTestnet ? 'Testnet' : 'Mainnet'}:`, error);
        }
    }

    /**
     * Starts the WebSocket stream to collect live candles.
     * @param isTestnet
     */
    public async startCandleStream(isTestnet: boolean): Promise<void> {
        this.assertWorker();
        const db = await getMarketDb(isTestnet);
        const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);

        if (!metaAndCtxs) {
            console.error("[MarketCollector] Failed to fetch universe for WS subscription.");
            return;
        }

        const { universe } = metaAndCtxs;
        const symbols = activeMarketAssets(universe, metaAndCtxs.assetCtxs).map(({ asset }) => asset.name);

        const ws = new HyperliquidWS(isTestnet);
        const subscribed = new Set<string>();
        const rotateBooks = async () => {
            const snapshot=await getMetaAndAssetCtxs(isTestnet);if(!snapshot)return;
            const active=activeMarketAssets(snapshot.universe,snapshot.assetCtxs);
            const coins=active.map(v=>v.asset.name).sort();
            const offset=coins.length?Math.floor(Date.now()/600000)*10%coins.length:0;
            const rotating=Array.from({length:Math.min(10,coins.length)},(_,i)=>coins[(offset+i)%coins.length]);
            const movers=active.map(v=>({coin:v.asset.name,change:Math.abs(Number(v.ctx?.markPx)/Number(v.ctx?.prevDayPx)-1)})).filter(v=>Number.isFinite(v.change)).sort((a,b)=>b.change-a.change).slice(0,5).map(v=>v.coin);
            const desired=new Set([...this.bookCoins,...movers,...rotating].filter(c=>coins.includes(c)).slice(0,28));
            for(const coin of subscribed)if(!desired.has(coin)){ws.unsubscribeFromL2Book(coin);subscribed.delete(coin);this.books.delete(`${isTestnet}:${coin}`);}
            for(const coin of desired)if(!subscribed.has(coin)){ws.subscribeToL2Book(coin);subscribed.add(coin);}
        };
        ws.on('l2Book', (book: any) => {
            if (!subscribed.has(book?.coin)) return;
            const at = Number(book.time), bid = Number(book.levels?.[0]?.[0]?.px), ask = Number(book.levels?.[1]?.[0]?.px);
            const bidSize = Number(book.levels?.[0]?.[0]?.sz), askSize = Number(book.levels?.[1]?.[0]?.sz);
            if (![at, bid, ask, bidSize, askSize].every(Number.isFinite) || bid <= 0 || ask <= bid || bidSize <= 0 || askSize <= 0) return;
            const key = `${isTestnet}:${book.coin}`;
            if (at < (this.books.get(key)?.at ?? 0)) return;
            this.books.set(key, { at, receivedAt: new Date(), bid, ask, bidSize, askSize });
        });

        // Buffer for batch writing
        const candleBuffer = new Map<string, any>();
        const MAX_BUFFER_CANDLES = 2000;
        const FLUSH_BATCH_SIZE = 200;
        let isFlushing = false;
        const FLUSH_INTERVAL = 1000; // Write to DB every 1 second

        ws.on('candle', (c: any) => {
            // c is { t, T, s, i, o, c, h, l, v, n }
            // Only process 1m candles (though we only subscribe to 1m)
            if (c.i !== '1m') return;

            const key = `${c.s}:${c.t}`;
            candleBuffer.delete(key);
            candleBuffer.set(key, {
                symbol: c.s,
                timeframe: '1m',
                openTime: new Date(c.t),
                open: parseFloat(c.o),
                high: parseFloat(c.h),
                low: parseFloat(c.l),
                close: parseFloat(c.c),
                volume: parseFloat(c.v),
                receivedAt: new Date(), source: "hyperliquid_websocket"
            });
            // Repeated updates replace the same candle. Bound memory even if
            // storage falls behind; startup backfill repairs older gaps.
            if (candleBuffer.size > MAX_BUFFER_CANDLES) {
                candleBuffer.delete(candleBuffer.keys().next().value!);
            }
        });

        ws.on('open', () => {
            console.log(`[MarketCollector] WS Connected. Subscribing to ${symbols.length} symbols...`);
            ws.subscribeToCandles(symbols);
            subscribed.clear();
            void rotateBooks().catch(error=>console.warn("[MarketCollector] Depth rotation unavailable",error?.name));
        });

        ws.connect();
        setInterval(()=>{void rotateBooks().catch(error=>console.warn("[MarketCollector] Depth rotation unavailable",error?.name));},600000);

        // Flush loop
        setInterval(async () => {
            if (isFlushing) return;
            if (candleBuffer.size === 0) return;
            isFlushing = true;

            const entries = Array.from(candleBuffer.entries()).slice(0, FLUSH_BATCH_SIZE);
            const batch = entries.map(([, candle]) => candle);
            for (const [key] of entries) candleBuffer.delete(key);

            try {
                // Use transaction for batch upsert
                await withMarketDbRetry(db, "flush candle stream", () =>
                    db.$transaction(
                        batch.flatMap(candle => [
                            db.marketCandle.upsert({
                                where: {
                                    symbol_timeframe_openTime: {
                                        symbol: candle.symbol,
                                        timeframe: candle.timeframe,
                                        openTime: candle.openTime
                                    }
                                },
                                update: {
                                    open: candle.open,
                                    high: candle.high,
                                    low: candle.low,
                                    close: candle.close,
                                    volume: candle.volume,
                                    receivedAt: candle.receivedAt, source: candle.source
                                },
                                create: candle
                            }),
                            db.marketCandleObservation.create({ data: candleObservation(candle) })
                        ])
                    )
                );
                // console.log(`[MarketCollector] Flushed ${batch.length} candle updates.`);
            } catch (error) {
                console.error(`[MarketCollector] Error flushing candle buffer:`, error);
                // Preserve newer in-flight updates, retry failed rows and keep memory bounded.
                for(const [key,candle] of entries)if(!candleBuffer.has(key))candleBuffer.set(key,candle);
                while(candleBuffer.size>MAX_BUFFER_CANDLES)candleBuffer.delete(candleBuffer.keys().next().value!);
            } finally {
                isFlushing = false;
            }
        }, FLUSH_INTERVAL);
    }

    /**
     * Backfills missing history for all symbols on startup.
     * Limits lookback to ~80 hours as requested.
     */
    public async backfillHistory(isTestnet: boolean, force: boolean = false): Promise<void> {
        this.assertWorker();
        console.log(`[MarketCollector] Starting backfill for ${isTestnet ? 'Testnet' : 'Mainnet'}...`);
        const db = await getMarketDb(isTestnet);
        const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);

        if (!metaAndCtxs) {
            console.warn("[MarketCollector] Failed to fetch universe for backfill.");
            return;
        }

        const { universe, assetCtxs } = metaAndCtxs;
        const activeMarkets = activeMarketAssets(universe, assetCtxs);
        const skippedCount = universe.length - activeMarkets.length;
        if (skippedCount > 0) {
            console.log(`[MarketCollector] Backfill universe: ${activeMarkets.length} active symbols, skipped ${skippedCount} delisted symbols.`);
        }

        // A purged market DB needs ticks as well as candles; screeners and regime selection use ticks as the live universe.
        await this.writeTickSnapshot(db, activeMarkets, isTestnet);

        // Process strictly sequentially to avoid API burst 429s and SQLite writer contention
        let processedCount = 0;
        for (const { asset } of activeMarkets) {
            const symbol = asset.name;
            let didFetch = false;
            try {
                // Smart Check: Do we need to backfill?
                const latestCandle = await withMarketDbRetry(db, `read latest candle for ${symbol}`, () =>
                    db.marketCandle.findFirst({
                        where: { symbol: asset.name, timeframe: "1m" },
                        orderBy: { openTime: 'desc' }
                    })
                );

                const now = Date.now();
                let startTime = now - this.MAX_LOOKBACK_MS;

                if (latestCandle && !force) {
                    const candleCount = await withMarketDbRetry(db, `count candles for ${symbol}`, () =>
                        db.marketCandle.count({
                            where: {
                                symbol: asset.name,
                                timeframe: "1m",
                                openTime: { gte: new Date(now - this.MAX_LOOKBACK_MS) }
                            }
                        })
                    );

                    const expectedCount = (this.MAX_LOOKBACK_MS / 60000);
                    const missingDataThreshold = expectedCount * 0.95;

                    if (candleCount >= missingDataThreshold) {
                        startTime = Math.max(startTime, latestCandle.openTime.getTime() + 60000);
                        if (now - startTime < 2 * 60000) {
                            // Up-to-date within 2 minutes; skip
                            continue;
                        }
                    }
                }

                // 3. Fetch History
                didFetch = true;
                const candles = await getOHLCV(symbol, "1m", isTestnet, startTime);
                const receivedAt = new Date();

                if (candles && candles.length > 0) {
                    // Split into smaller chunks to avoid "Transaction too large" or timeouts
                    const UPSERT_BATCH_SIZE = 500;
                    for (let j = 0; j < candles.length; j += UPSERT_BATCH_SIZE) {
                        const candleBatch = candles.slice(j, j + UPSERT_BATCH_SIZE);

                        await withMarketDbRetry(db, `backfill candles for ${symbol}`, () =>
                            db.$transaction(
                                candleBatch.flatMap((c: any) => [
                                    db.marketCandle.upsert({
                                        where: {
                                            symbol_timeframe_openTime: {
                                                symbol,
                                                timeframe: "1m",
                                                openTime: new Date(c.t)
                                            }
                                        },
                                        update: {
                                            open: parseFloat(c.o),
                                            high: parseFloat(c.h),
                                            low: parseFloat(c.l),
                                            close: parseFloat(c.c),
                                            volume: parseFloat(c.v),
                                            receivedAt, source: "hyperliquid_backfill"
                                        },
                                        create: {
                                            symbol,
                                            timeframe: "1m",
                                            openTime: new Date(c.t),
                                            open: parseFloat(c.o),
                                            high: parseFloat(c.h),
                                            low: parseFloat(c.l),
                                            close: parseFloat(c.c),
                                            volume: parseFloat(c.v),
                                            receivedAt, source: "hyperliquid_backfill"
                                        }
                                    }),
                                    db.marketCandleObservation.create({ data: candleObservation({
                                        symbol, timeframe: "1m", openTime: new Date(c.t), receivedAt,
                                        source: "hyperliquid_backfill", open: parseFloat(c.o), high: parseFloat(c.h),
                                        low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v)
                                    }) })
                                ])
                            )
                        );
                    }
                    console.log(`[Backfill] Inserted ${candles.length} candles for ${symbol}`);
                }
            } catch (error) {
                console.error(`[Backfill] Error processing ${symbol}:`, error);
            } finally {
                processedCount++;
                if (processedCount % 5 === 0 || processedCount === activeMarkets.length) {
                    console.log(`[Backfill] Processed ${processedCount}/${activeMarkets.length} symbols...`);
                }

                // Space out successive API requests to stay below burst limits
                if (didFetch && this.BACKFILL_REQUEST_SPACING_MS > 0) {
                    await this.sleep(this.BACKFILL_REQUEST_SPACING_MS);
                } else {
                    // Still yield so other tasks (e.g., WS flush) can run
                    await this.sleep(25);
                }
            }
        }
        // Leave manual backfills immediately usable even when the DB was empty at the start.
        await this.collectTicks(isTestnet);
        console.log(`[MarketCollector] Backfill complete for ${isTestnet ? 'Testnet' : 'Mainnet'}.`);
    }

    private async writeTickSnapshot(db: MarketDb, activeMarkets: ActiveMarket[], isTestnet: boolean): Promise<void> {
        const now = new Date();
        const rows = activeMarkets
            .map(({ asset, ctx }) => {
                const row = buildMarketTickRow(asset.name, ctx, now);
                if (!row) return null;
                const book = this.books.get(`${isTestnet}:${asset.name}`);
                // Timestamp is the observation time. Never carry disconnected or future quotes into history.
                const observed = { ...row, receivedAt: now, source: "hyperliquid_live" };
                if (!book || book.at > +now || +now - book.at > 2000) return observed;
                return { ...observed, bookBidPx: book.bid, bookBidSz: book.bidSize, bookAskPx: book.ask, bookAskSz: book.askSize,
                    bookEventAt: new Date(book.at), bookReceivedAt: book.receivedAt };
            })
            .filter((row): row is NonNullable<typeof row> => row !== null);

        if (rows.length === 0) return;

        await withMarketDbRetry(db, "write tick snapshot", () => db.marketTick.createMany({ data: rows }));
        console.log(`[MarketCollector] Saved ${rows.length} ticks for ${isTestnet ? 'Testnet' : 'Mainnet'}`);
    }

    private sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private assertWorker() {
        if (process.env.MARKET_COLLECTOR_ROLE !== "worker") throw new Error("Run market ingestion on the dedicated VPS worker");
    }
}
