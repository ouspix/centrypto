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

    // 2. Start WebSocket Streams (Live Candles)
    console.log("🚀 Starting WebSocket streams...");
    collector.startCandleStream(true); // Testnet
    collector.startCandleStream(false); // Mainnet

    console.log("🚀 Starting tick snapshot loop...");

    // 3. Start Tick Snapshot Loop (Polling)
    while (true) {
        try {
            await collectTicksOnly();
        } catch (error) {
            console.error("❌ Error in tick collection cycle:", error);
        }

        // Wait for interval BEFORE starting next cycle
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
    }
}

async function collectTicksOnly() {
    const start = Date.now();

    // Run in parallel
    await Promise.all([
        collector.collectTicks(true),
        collector.collectTicks(false)
    ]);

    const duration = Date.now() - start;
    console.log(`⏱️ Tick snapshot finished in ${duration}ms`);
}

// Handle shutdown
process.on('SIGINT', () => {
    console.log("🛑 Stopping collector...");
    process.exit(0);
});

runCollection().catch(console.error);
