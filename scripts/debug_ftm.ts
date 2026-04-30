import { getOHLCV } from "@/lib/hyperliquid-info";

async function debugFTM() {
    console.log("Fetching OHLCV for FTM...");
    // 12:00 - 13:00
    const time = 1764414000000;
    const candles = await getOHLCV("FTM", "1m", false, time);

    if (candles.length > 0) {
        console.log(`First candle:`, candles[0]);
        const zeroVol = candles.filter((c: any) => parseFloat(c.v) === 0);
        console.log(`Total candles: ${candles.length}, Zero volume: ${zeroVol.length}`);
    } else {
        console.log("No candles returned.");
    }
}

debugFTM().catch(console.error);
