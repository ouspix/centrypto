import { getOHLCV } from "@/lib/hyperliquid-info";

async function debugOHLCV() {
    console.log("Fetching OHLCV for BTC...");
    // Fetch for a time known to have 0 volume in DB (e.g. 12:30 today)
    const time = new Date("2025-11-29T12:30:00+01:00").getTime();
    const candles = await getOHLCV("BTC", "1m", false, time);

    if (candles.length > 0) {
        console.log("First candle:", candles[0]);
    } else {
        console.log("No candles returned.");
    }
}

debugOHLCV().catch(console.error);
