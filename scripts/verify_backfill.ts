import { marketDbMain, marketDbTest } from "@/lib/market-db";

async function verify() {
    const mainCount = await marketDbMain.marketCandle.count();
    const testCount = await marketDbTest.marketCandle.count();
    const mainTicks = await marketDbMain.marketTick.count();
    const testTicks = await marketDbTest.marketTick.count();

    console.log(`Mainnet Candles: ${mainCount}`);
    console.log(`Testnet Candles: ${testCount}`);
    console.log(`Mainnet Ticks: ${mainTicks}`);
    console.log(`Testnet Ticks: ${testTicks}`);
}

verify()
    .catch(console.error)
    .finally(async () => {
        await marketDbMain.$disconnect();
        await marketDbTest.$disconnect();
    });
