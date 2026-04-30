import { getMetaAndAssetCtxs, getOHLCV } from "@/lib/hyperliquid-info";

async function debugTestnet() {
    console.log("🔍 Testing Testnet Connection...");

    // 1. Metadata
    console.log("Fetching Metadata...");
    const meta = await getMetaAndAssetCtxs(true);
    if (!meta) {
        console.error("❌ Failed to fetch Testnet Metadata!");
    } else {
        console.log(`✅ Metadata received. Universe size: ${meta.universe.length}`);
        console.log("First 5 symbols:", meta.universe.slice(0, 5).map(a => a.name));
    }

    // 2. Candles
    console.log("\nFetching BTC Candles (Testnet)...");
    const candles = await getOHLCV("BTC", "1m", true);
    console.log(`✅ Received ${candles.length} candles for BTC.`);
    if (candles.length > 0) {
        console.log("First candle:", candles[0]);
    }
}

debugTestnet().catch(console.error);
