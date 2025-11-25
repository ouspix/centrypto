import { marketDbMain, marketDbTest } from "@/lib/market-db";

async function verify() {
    const mainCount = await marketDbMain.marketTick.count();
    const testCount = await marketDbTest.marketTick.count();

    console.log(`Mainnet Ticks: ${mainCount}`);
    console.log(`Testnet Ticks: ${testCount}`);

    if (mainCount > 0 && testCount > 0) {
        console.log("✅ Verification Successful: Both databases have data.");
    } else {
        console.error("❌ Verification Failed: Missing data in one or both databases.");
    }
}

verify()
    .catch(console.error)
    .finally(async () => {
        await marketDbMain.$disconnect();
        await marketDbTest.$disconnect();
    });
