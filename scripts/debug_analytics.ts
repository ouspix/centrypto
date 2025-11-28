
import { TradeHistoryService } from "../services/TradeHistoryService";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function main() {
    const service = new TradeHistoryService();
    // Try to get address from args or env
    const userAddress = process.argv[2] || process.env.USER_ADDRESS;

    if (!userAddress) {
        console.error("Please provide user address as argument: npx tsx scripts/debug_analytics.ts <ADDRESS>");
        process.exit(1);
    }

    console.log(`Fetching trades for ${userAddress}...`);
    const trades = await service.getTrades(userAddress, false, 1000);
    console.log(`Fetched ${trades.length} trades.`);

    // Analyze Types
    const types = new Set(trades.map(t => t.type));
    console.log("Unique Trade Types found:", Array.from(types));

    // Run Analytics Logic locally to debug
    const holdTimes: number[] = [];
    const openLongs: Record<string, { time: number, size: number }[]> = {};
    const openShorts: Record<string, { time: number, size: number }[]> = {};

    const sortedTrades = [...trades].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());

    sortedTrades.forEach(trade => {
        const isLong = trade.side === 'long';
        const isOpen = trade.type.includes('Open');
        const isClose = trade.type.includes('Close') || trade.type.includes('Liquidation'); // Speculative fix

        if (isOpen) {
            const queue = isLong ? openLongs : openShorts;
            if (!queue[trade.symbol]) queue[trade.symbol] = [];
            queue[trade.symbol].push({ time: trade.openedAt.getTime(), size: trade.size });
        } else if (isClose) {
            let remainingCloseSize = trade.size;
            const isClosingLong = trade.type.includes('Long');
            const queue = isClosingLong ? openLongs : openShorts;
            const symbolOpens = queue[trade.symbol] || [];

            while (remainingCloseSize > 0 && symbolOpens.length > 0) {
                const openFill = symbolOpens[0];
                const matchSize = Math.min(remainingCloseSize, openFill.size);

                const holdTime = trade.openedAt.getTime() - openFill.time;
                const holdTimeHours = holdTime / (1000 * 60 * 60);

                console.log(`Matched ${trade.symbol} ${trade.type} (${matchSize}) with Open from ${new Date(openFill.time).toISOString()}. Hold Time: ${holdTimeHours.toFixed(2)}h`);

                if (holdTime > 0 && holdTime < 365 * 24 * 60 * 60 * 1000) {
                    holdTimes.push(holdTime);
                }

                openFill.size -= matchSize;
                remainingCloseSize -= matchSize;

                if (openFill.size <= 0.000001) {
                    symbolOpens.shift();
                }
            }

            if (remainingCloseSize > 0.000001) {
                console.log(`WARNING: Could not fully match ${trade.type} for ${trade.symbol}. Remaining: ${remainingCloseSize}`);
            }
        }
    });

    const totalHoldTime = holdTimes.reduce((a, b) => a + b, 0);
    const avgHoldTimeMs = holdTimes.length > 0 ? totalHoldTime / holdTimes.length : 0;
    const avgHoldTimeHours = avgHoldTimeMs / (1000 * 60 * 60);

    console.log(`\nAverage Hold Time: ${avgHoldTimeHours.toFixed(2)} hours`);
}

main();
