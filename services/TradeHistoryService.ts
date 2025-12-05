import { getUserFills } from "@/lib/hyperliquid";

export type TradeStatus = 'open' | 'closed';
export type TradeSide = 'long' | 'short';

export type Trade = {
    id: string;
    symbol: string;
    side: TradeSide;
    entryPrice: number;
    exitPrice?: number;
    size: number;
    leverage: number;
    realizedPnl?: number;
    fees: number;
    status: TradeStatus;
    openedAt: Date;
    closedAt?: Date;
    userAddress: string;
    strategyName?: string;
    type: string; // 'Open Long', 'Close Short', etc.
};

export type TradeAnalytics = {
    totalTrades: number;
    openTrades: number;
    closedTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    avgWin: number;
    avgLoss: number;
    largestWin: number;
    largestLoss: number;
    profitFactor: number;
    avgHoldTime: number; // in hours
};

export class TradeHistoryService {
    /**
     * Get all trades (fills) for a user from Hyperliquid
     */
    async getTrades(userAddress: string, isTestnet: boolean = false, limit: number = 100, sinceMs?: number): Promise<Trade[]> {
        try {
            const fills = await getUserFills(userAddress, isTestnet);

            // Map fills to Trade objects
            const mapped = fills.map((fill: any) => {
                const isBuy = fill.side === 'B';
                const size = parseFloat(fill.sz);
                const price = parseFloat(fill.px);
                const pnl = parseFloat(fill.closedPnl || '0');
                const fee = parseFloat(fill.fee || '0');
                const timestamp = new Date(fill.time).getTime();

                // Determine side based on direction if available, otherwise guess
                // dir examples: "Open Long", "Close Long", "Open Short", "Close Short"
                let side: TradeSide = 'long';
                if (fill.dir) {
                    side = fill.dir.includes('Short') ? 'short' : 'long';
                } else {
                    side = isBuy ? 'long' : 'short'; // Fallback
                }

                const isClose = fill.dir ? fill.dir.includes('Close') : false;

                return {
                    id: `${fill.hash}-${fill.oid}`,
                    symbol: fill.coin,
                    side: side,
                    entryPrice: price,
                    exitPrice: isClose ? price : undefined,
                    size: size,
                    leverage: 0, // API doesn't return leverage for fills
                    realizedPnl: pnl,
                    fees: fee,
                    status: isClose ? 'closed' : 'open',
                    openedAt: new Date(fill.time),
                    closedAt: isClose ? new Date(fill.time) : undefined,
                    userAddress: userAddress,
                    type: fill.dir || (isBuy ? 'Buy' : 'Sell'),
                    __timestamp: timestamp // internal: helps filter by time
                };
            });

            const filtered = sinceMs
                ? mapped.filter((trade: any) => Number.isFinite(trade.__timestamp) && trade.__timestamp >= sinceMs)
                : mapped;

            return filtered
                .slice(0, limit)
                .map((trade: any) => {
                    const { __timestamp, ...rest } = trade;
                    return rest;
                });
        } catch (error) {
            console.error("Failed to get trades:", error);
            return [];
        }
    }

    /**
     * Get trade analytics for a user based on fills
     */
    async getAnalytics(userAddress: string, isTestnet: boolean = false): Promise<TradeAnalytics> {
        try {
            const trades = await this.getTrades(userAddress, isTestnet, 1000); // Fetch more for analytics

            let totalTrades = 0;
            let openTrades = 0;
            let closedTrades = 0;
            let winningTrades = 0;
            let losingTrades = 0;
            let totalPnl = 0;
            let totalWinPnl = 0;
            let totalLossPnl = 0;
            let maxWin = 0;
            let maxLoss = 0;

            trades.forEach(trade => {
                totalTrades++;
                if (trade.status === 'closed') {
                    closedTrades++;
                    const pnl = trade.realizedPnl || 0;
                    totalPnl += pnl;

                    if (pnl > 0) {
                        winningTrades++;
                        totalWinPnl += pnl;
                        if (pnl > maxWin) maxWin = pnl;
                    } else if (pnl < 0) {
                        losingTrades++;
                        totalLossPnl += Math.abs(pnl);
                        if (pnl < maxLoss) maxLoss = pnl;
                    }
                } else {
                    openTrades++;
                }
            });

            // Calculate average hold time using FIFO matching
            const holdTimes: number[] = [];
            // Separate queues for Long and Short opens
            const openLongs: Record<string, { time: number, size: number }[]> = {};
            const openShorts: Record<string, { time: number, size: number }[]> = {};

            // Sort trades by time ascending for FIFO matching
            const sortedTrades = [...trades].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());

            sortedTrades.forEach(trade => {
                const isLong = trade.side === 'long';
                const isOpen = trade.type.includes('Open');
                const isClose = trade.type.includes('Close') || trade.type.includes('Liquidation');

                // Initialize queues
                if (!openLongs[trade.symbol]) openLongs[trade.symbol] = [];
                if (!openShorts[trade.symbol]) openShorts[trade.symbol] = [];

                if (isOpen) {
                    if (isLong) {
                        openLongs[trade.symbol].push({ time: trade.openedAt.getTime(), size: trade.size });
                    } else {
                        openShorts[trade.symbol].push({ time: trade.openedAt.getTime(), size: trade.size });
                    }
                } else if (isClose) {
                    let remainingCloseSize = trade.size;
                    // If closing a Long, match with Open Longs. If closing a Short, match with Open Shorts.
                    // Note: trade.side for a "Close Long" is usually "sell" (short), but our Trade mapping logic
                    // might have mapped it to 'long' based on 'dir'.
                    // Let's rely on the 'type' field which comes from 'dir' (e.g. "Close Long").

                    const isClosingLong = trade.type.includes('Long');
                    const symbolOpens = isClosingLong ? openLongs[trade.symbol] : openShorts[trade.symbol];

                    while (remainingCloseSize > 0 && symbolOpens.length > 0) {
                        const openFill = symbolOpens[0]; // FIFO
                        const matchSize = Math.min(remainingCloseSize, openFill.size);

                        const holdTime = trade.openedAt.getTime() - openFill.time;
                        // Filter out unreasonable hold times (e.g. negative or > 1 year) which indicate data issues
                        if (holdTime > 0 && holdTime < 365 * 24 * 60 * 60 * 1000) {
                            holdTimes.push(holdTime);
                        }

                        openFill.size -= matchSize;
                        remainingCloseSize -= matchSize;

                        if (openFill.size <= 0.000001) {
                            symbolOpens.shift();
                        }
                    }
                }
            });

            const totalHoldTime = holdTimes.reduce((a, b) => a + b, 0);
            const avgHoldTimeMs = holdTimes.length > 0 ? totalHoldTime / holdTimes.length : 0;
            const avgHoldTimeHours = avgHoldTimeMs / (1000 * 60 * 60);

            const winRate = closedTrades > 0 ? (winningTrades / closedTrades) * 100 : 0;
            const avgWin = winningTrades > 0 ? totalWinPnl / winningTrades : 0;
            const avgLoss = losingTrades > 0 ? totalLossPnl / losingTrades : 0;
            const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? Infinity : 0;

            return {
                totalTrades,
                openTrades,
                closedTrades,
                winningTrades,
                losingTrades,
                winRate,
                totalPnl,
                avgWin,
                avgLoss,
                largestWin: maxWin,
                largestLoss: maxLoss,
                profitFactor,
                avgHoldTime: avgHoldTimeHours
            };
        } catch (error) {
            console.error("Failed to get analytics:", error);
            return {
                totalTrades: 0,
                openTrades: 0,
                closedTrades: 0,
                winningTrades: 0,
                losingTrades: 0,
                winRate: 0,
                totalPnl: 0,
                avgWin: 0,
                avgLoss: 0,
                largestWin: 0,
                largestLoss: 0,
                profitFactor: 0,
                avgHoldTime: 0
            };
        }
    }

    // Legacy methods kept for compatibility but unused
    async createTrade(params: any): Promise<any> { return null; }
    async closeTrade(params: any): Promise<any> { return null; }
    async deleteTrade(tradeId: string, userAddress: string): Promise<boolean> { return true; }
}
