import { marketDbMain, marketDbTest } from "@/lib/market-db";

async function checkCounts() {
    const mainCount = await marketDbMain.marketCandle.count();
    const testCount = await marketDbTest.marketCandle.count();

    console.log(`Mainnet Candles: ${mainCount}`);
    console.log(`Testnet Candles: ${testCount}`);

    // Check a sample candle
    if (mainCount > 0) {
        const sample = await marketDbMain.marketCandle.findFirst({ orderBy: { openTime: 'desc' } });
        console.log("Latest Mainnet Candle:", sample);
    }
}

checkCounts().catch(console.error);
