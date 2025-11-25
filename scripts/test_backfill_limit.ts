import { getOHLCV } from "../lib/hyperliquid";

async function testLimit() {
    const now = Date.now();
    const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);

    console.log("Fetching candles from 1 week ago...");
    const candles = await getOHLCV("BTC", "1m", false, oneWeekAgo);

    console.log(`Received ${candles.length} candles.`);
    if (candles.length > 0) {
        const first = candles[0];
        const last = candles[candles.length - 1];
        console.log(`First candle time: ${new Date(first.t).toISOString()}`);
        console.log(`Last candle time: ${new Date(last.t).toISOString()}`);

        const durationHours = (last.t - first.t) / (1000 * 60 * 60);
        console.log(`Covered duration: ${durationHours.toFixed(2)} hours`);
    }
}

testLimit();
