import { MarketCollectorService } from "@/services/MarketCollectorService";

async function debugBackfill() {
    const collector = new MarketCollectorService();
    console.log("Debugging backfill for BTC...");

    // Hack: We can't easily call backfill for one symbol because it iterates universe.
    // But we can instantiate the service and call a modified version or just check getOHLCV directly.

    const { getOHLCV } = await import("@/lib/hyperliquid-info");
    const startTime = Date.now() - (48 * 60 * 60 * 1000);

    console.log(`Fetching BTC candles since ${new Date(startTime).toISOString()}...`);
    const candles = await getOHLCV("BTC", "1m", false, startTime);

    console.log(`Fetched ${candles.length} candles.`);
    if (candles.length > 0) {
        console.log("First candle:", candles[0]);
        console.log("Last candle:", candles[candles.length - 1]);
    }
}

debugBackfill().catch(console.error);
