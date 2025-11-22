import { ScreenerService } from "../services/ScreenerService";
import { prisma } from "../lib/db";

async function main() {
    console.log("🕵️ Verifying Refactored Architecture...");

    // 1. Check DB for MarketStateSnapshot
    const snapshot = await prisma.marketStateSnapshot.findFirst({
        orderBy: { createdAt: 'desc' }
    });

    if (!snapshot) {
        console.error("❌ No MarketStateSnapshot found! Collector might not be running or hasn't finished yet.");
        process.exit(1);
    }

    const data = JSON.parse(snapshot.data);
    console.log(`✅ Found MarketStateSnapshot with ${data.length} symbols. Created at: ${snapshot.createdAt.toISOString()}`);

    // 2. Run Screener (On-Demand)
    console.log("\n🧪 Testing ScreenerService (On-Demand)...");
    const screener = new ScreenerService();
    const isTestnet = process.env.NEXT_PUBLIC_IS_TESTNET === 'true';

    try {
        const results = await screener.getScreenedSymbols(isTestnet, ["BTC", "ETH"]); // Mock held symbols
        console.log(`✅ Screener returned ${results.length} symbols.`);

        if (results.length > 0) {
            console.log("Top 3:");
            results.slice(0, 3).forEach(s => {
                console.log(`- ${s.symbol}: Score=${s.score.toFixed(2)} Vol=${s.volume24h}`);
                console.log(`  Sentiment: Score=${s.sentiment.score}, Mentions=${s.sentiment.mentions}, Notes=${s.sentiment.notes}`);
            });
        }
    } catch (error) {
        console.error("❌ Screener failed:", error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

main();
