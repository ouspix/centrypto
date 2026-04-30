import { getMetaAndAssetCtxs, getOHLCV } from "@/lib/hyperliquid-info";
import { marketDbMain, marketDbTest } from "@/lib/market-db";

async function runAdhocBackfill() {
    console.log("⚠️ STARTING AD-HOC BACKFILL (48H) ⚠️");
    console.log("This will PURGE all existing market data.");

    // 1. Purge Databases
    console.log("🗑️ Purging databases...");
    await Promise.all([
        marketDbMain.marketTick.deleteMany({}),
        marketDbMain.marketCandle.deleteMany({}),
        marketDbTest.marketTick.deleteMany({}),
        marketDbTest.marketCandle.deleteMany({})
    ]);
    console.log("✅ Databases purged.");

    // 2. Backfill Function
    const backfillNetwork = async (isTestnet: boolean) => {
        const networkName = isTestnet ? "Testnet" : "Mainnet";
        console.log(`⏳ Starting backfill for ${networkName}...`);

        const db = isTestnet ? marketDbTest : marketDbMain;
        const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);

        if (!metaAndCtxs) {
            console.error(`❌ Failed to fetch universe for ${networkName}`);
            return;
        }

        const { universe } = metaAndCtxs;
        const BATCH_SIZE = 1; // Sequential to avoid rate limits
        const LOOKBACK_MS = 48 * 60 * 60 * 1000; // 48 hours
        const startTime = Date.now() - LOOKBACK_MS;

        let processed = 0;

        for (let i = 0; i < universe.length; i += BATCH_SIZE) {
            const batch = universe.slice(i, i + BATCH_SIZE);

            await Promise.all(batch.map(async (asset) => {
                try {
                    const symbol = asset.name;
                    const candles = await getOHLCV(symbol, "1m", isTestnet, startTime);

                    if (candles.length > 0) {
                        await db.$transaction(
                            candles.map((c: any) =>
                                db.marketCandle.create({
                                    data: {
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
                } catch (error) {
                    console.error(`❌ Error processing ${asset.name}:`, error);
                }
            }));

            processed += batch.length;
            console.log(`[${networkName}] Processed ${processed}/${universe.length} symbols...`);
        }
        console.log(`✅ ${networkName} backfill complete.`);
    };

    // 3. Run sequentially to be safe
    await backfillNetwork(true);
    await backfillNetwork(false);

    console.log("🎉 All done! You can now restart the collector.");
}

runAdhocBackfill()
    .catch(console.error)
    .finally(async () => {
        await marketDbMain.$disconnect();
        await marketDbTest.$disconnect();
    });
