import { marketDbMain, marketDbTest } from "@/lib/market-db";

async function purge() {
    console.log("🗑️ Purging database...");

    // Purge Mainnet
    console.log("Cleaning Mainnet DB...");
    await marketDbMain.marketTick.deleteMany({});
    await marketDbMain.marketCandle.deleteMany({});

    // Purge Testnet
    console.log("Cleaning Testnet DB...");
    await marketDbTest.marketTick.deleteMany({});
    await marketDbTest.marketCandle.deleteMany({});

    console.log("✅ Database purged.");
}

purge().catch(console.error);
