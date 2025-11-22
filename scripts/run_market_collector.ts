import { MarketDataService } from "../services/MarketDataService";
import { prisma } from "../lib/db";

const INTERVAL_MS = 60 * 1000;

async function runLoop() {
    console.log("🚀 Starting Market Data Collector Service...");
    const collector = new MarketDataService();

    while (true) {
        try {
            console.log(`\n[${new Date().toISOString()}] 📊 Running Collection Cycle...`);

            // Collect from both networks
            const [testnetData, mainnetData] = await Promise.all([
                collector.collectAllMarketData(true),
                collector.collectAllMarketData(false)
            ]);

            // Combine and save
            const allData = [...testnetData, ...mainnetData];

            if (allData.length > 0) {
                await collector.saveSnapshot(allData);
                console.log(`💾 Saved snapshot: ${testnetData.length} testnet + ${mainnetData.length} mainnet symbols.`);
            } else {
                console.warn("⚠️ No market data collected.");
            }
        } catch (error) {
            console.error("❌ Collection cycle failed:", error);
            // Don't exit, just wait for next cycle
        }

        console.log(`💤 Sleeping for ${INTERVAL_MS / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log("🛑 Shutting down Collector Service...");
    await prisma.$disconnect();
    process.exit(0);
});

runLoop();
