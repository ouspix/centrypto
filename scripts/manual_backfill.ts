import { MarketCollectorService } from "@/services/MarketCollectorService";

const collector = new MarketCollectorService();

async function runBackfill() {
    console.log("🚀 Starting Manual Backfill...");
    const start = Date.now();

    await Promise.all([
        collector.backfillHistory(true, true),
        collector.backfillHistory(false, true)
    ]);

    const duration = (Date.now() - start) / 1000;
    console.log(`✅ Manual Backfill complete in ${duration}s.`);
    process.exit(0);
}

runBackfill().catch(console.error);
