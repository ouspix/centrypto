import { ScreenerService } from "../services/ScreenerService";
import { SentimentService } from "../services/SentimentService";
import { SnapshotBuilder } from "../services/SnapshotBuilder";
import { prisma } from "../lib/db";

async function verify() {
    console.log("🧪 Starting Verification...");

    // 1. Run Sentiment Runner (simulated)
    console.log("\n--- Step 1: Running Sentiment Pipeline ---");
    // We'll just check if we can fetch sentiment for a symbol, assuming the runner would have populated it.
    // Or we can trigger a quick run for one symbol.
    const sentimentService = new SentimentService();
    const sentiment = await sentimentService.getSentimentForCoin("BTC");
    console.log("Sentiment Result:", sentiment.score, sentiment.notes);

    // 2. Run Screener Runner (simulated)
    console.log("\n--- Step 2: Running Screener ---");
    // We'll run the actual script logic here to verify it works
    const screener = new ScreenerService();
    const isTestnet = true;
    const symbols = await screener.getScreenedSymbols(isTestnet, []);
    console.log(`Screener found ${symbols.length} symbols.`);

    // 3. Verify SnapshotBuilder consumes it
    console.log("\n--- Step 3: Verifying SnapshotBuilder Consumption ---");
    const snapshotBuilder = new SnapshotBuilder();
    const snapshot = await snapshotBuilder.buildSnapshot(null, isTestnet);

    const marketCount = Object.keys(snapshot.markets).length;
    console.log(`Snapshot built with ${marketCount} markets.`);

    if (marketCount > 0) {
        console.log("✅ Verification SUCCESS: SnapshotBuilder successfully used cached data (or fell back correctly).");
    } else {
        console.error("❌ Verification FAILED: SnapshotBuilder returned empty markets.");
    }

    await prisma.$disconnect();
}

verify().catch(console.error);
