
async function debugHyperliquid() {
    const coin = "ETH"; // Testing with ETH as in the screenshot
    console.log(`Fetching l2Book for ${coin}...`);

    try {
        const response = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: "l2Book",
                coin: coin
            })
        });

        if (!response.ok) {
            console.error(`API Error: ${response.status} ${response.statusText}`);
            const text = await response.text();
            console.error("Response body:", text);
            return;
        }

        const data = await response.json();
        console.log("Raw API Response:");
        console.log(JSON.stringify(data, null, 2));

        // Verify new parsing logic
        const bidsRaw = data.levels[0] || [];
        const asksRaw = data.levels[1] || [];

        const bids = bidsRaw.map((l: any) => [parseFloat(l.px), parseFloat(l.sz)] as [number, number]);
        const asks = asksRaw.map((l: any) => [parseFloat(l.px), parseFloat(l.sz)] as [number, number]);

        console.log(`\nParsed Bids: ${bids.length}`);
        console.log(`Parsed Asks: ${asks.length}`);

        if (bids.length > 0) console.log("Top Bid:", bids[0]);
        if (asks.length > 0) console.log("Top Ask:", asks[0]);

        const bestBid = bids.length > 0 ? bids[0][0] : 0;
        const bestAsk = asks.length > 0 ? asks[0][0] : 0;
        const midPrice = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk || 0);

        console.log(`Calculated Mid Price: ${midPrice}`);

    } catch (error) {
        console.error("Fetch failed:", error);
    }
}

debugHyperliquid();
