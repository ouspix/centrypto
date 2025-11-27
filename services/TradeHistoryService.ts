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
    async getTrades(userAddress: string, isTestnet: boolean = false, limit: number = 100): Promise<Trade[]> {
        try {
            const fills = await getUserFills(userAddress, isTestnet);

            // Map fills to Trade objects
            return fills.map((fill: any) => {
                const isBuy = fill.side === 'B';
                const size = parseFloat(fill.sz);
                const price = parseFloat(fill.px);
                const pnl = parseFloat(fill.closedPnl || '0');
                const fee = parseFloat(fill.fee || '0');

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
                    type: fill.dir || (isBuy ? 'Buy' : 'Sell')
                };
            }).slice(0, limit);
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
                avgHoldTime: 0 // Hard to calculate from individual fills without linking them
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
