import { getMetaAndAssetCtxs, getOHLCV } from "@/lib/hyperliquid";
import { marketDbTest } from "@/lib/market-db";

async function runTestnetBackfill() {
    console.log("⚠️ STARTING TESTNET BACKFILL (48H) ⚠️");

    const db = marketDbTest;
    const metaAndCtxs = await getMetaAndAssetCtxs(true);

    if (!metaAndCtxs) {
        console.error("❌ Failed to fetch universe for Testnet");
        return;
    }

    const { universe } = metaAndCtxs;
    const BATCH_SIZE = 1; // Sequential
    const LOOKBACK_MS = 48 * 60 * 60 * 1000; // 48 hours
    const startTime = Date.now() - LOOKBACK_MS;

    let processed = 0;

    for (let i = 0; i < universe.length; i += BATCH_SIZE) {
        const batch = universe.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (asset) => {
            try {
                const symbol = asset.name;
                const candles = await getOHLCV(symbol, "1m", true, startTime);

                if (candles.length > 0) {
                    await db.$transaction(
                        candles.map((c: any) =>
                            db.marketCandle.upsert({
                                where: {
                                    symbol_timeframe_openTime: {
                                        symbol: symbol,
                                        timeframe: "1m",
                                        openTime: new Date(c.t)
                                    }
                                },
                                update: {},
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
                    // console.log(`✅ Saved ${candles.length} candles for ${symbol}`);
                }
            } catch (error) {
                console.error(`❌ Error processing ${asset.name}:`, error);
            }
        }));

        processed += batch.length;
        if (processed % 10 === 0) {
            console.log(`[Testnet] Processed ${processed}/${universe.length} symbols...`);
        }
    }
    console.log("✅ Testnet backfill complete.");
}

runTestnetBackfill()
    .catch(console.error)
    .finally(async () => {
        await marketDbTest.$disconnect();
    });
