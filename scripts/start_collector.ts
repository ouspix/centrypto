import { MarketCollectorService } from "@/services/MarketCollectorService";

const collector = new MarketCollectorService();
const INTERVAL_MS = 15 * 1000; // 15 seconds

async function runCollection() {
    console.log("🚀 Starting Market Data Collector...");

    // 1. Start Backfill in background (don't await)
    console.log("⏳ Triggering background backfill...");
    Promise.all([
        collector.backfillHistory(true),
        collector.backfillHistory(false)
    ]).then(() => console.log("✅ Background backfill complete."));

    console.log("🚀 Starting live collection loop...");

    // 2. Start Live Loop
    while (true) {
        try {
            await collectBoth();
        } catch (error) {
            console.error("❌ Error in collection cycle:", error);
        }

        // Wait for interval BEFORE starting next cycle
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
    }
}

async function collectBoth() {
    const start = Date.now();

    // Run in parallel
    await Promise.all([
        collector.collectTicks(true).then(() => collector.aggregateCandles(true)),  // Testnet
        collector.collectTicks(false).then(() => collector.aggregateCandles(false))  // Mainnet
    ]);

    const duration = Date.now() - start;
    console.log(`⏱️ Collection cycle finished in ${duration}ms`);
}

// Handle shutdown
process.on('SIGINT', () => {
    console.log("🛑 Stopping collector...");
    process.exit(0);
});

runCollection().catch(console.error);
