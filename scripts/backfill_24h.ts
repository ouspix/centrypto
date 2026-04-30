import { getMetaAndAssetCtxs, getOHLCV } from "@/lib/hyperliquid-info";
import { marketDbMain, marketDbTest } from "@/lib/market-db";

async function backfill24h(isTestnet: boolean) {
    console.log(`[Backfill] Starting 24h backfill for ${isTestnet ? 'Testnet' : 'Mainnet'}...`);
    const db = isTestnet ? marketDbTest : marketDbMain;
    const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);

    if (!metaAndCtxs) {
        console.warn("[Backfill] Failed to fetch universe.");
        return;
    }

    const { universe } = metaAndCtxs;
    const now = Date.now();
    const startTime = now - 24 * 60 * 60 * 1000; // 24 hours ago

    let processedCount = 0;
    for (const asset of universe) {
        try {
            const symbol = asset.name;

            // Fetch candles
            const candles = await getOHLCV(symbol, "1m", isTestnet, startTime);

            if (candles.length === 0) continue;

            // Save to DB in chunks
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
            }
        } catch (error) {
            console.error(`[Backfill] Error processing ${asset.name}:`, error);
        }

        processedCount++;
        if (processedCount % 10 === 0) {
            console.log(`[Backfill] Processed ${processedCount}/${universe.length} symbols...`);
        }

        // Rate limit delay
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log(`[Backfill] Complete for ${isTestnet ? 'Testnet' : 'Mainnet'}.`);
}

async function main() {
    // Run for both networks
    await backfill24h(true); // Testnet
    await backfill24h(false); // Mainnet
}

main().catch(console.error);
