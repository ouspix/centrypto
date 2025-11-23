import { prisma } from "@/lib/db";

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

export type CreateTradeParams = {
    symbol: string;
    side: TradeSide;
    entryPrice: number;
    size: number;
    leverage?: number;
    userAddress: string;
    strategyName?: string;
};

export type CloseTradeParams = {
    tradeId: string;
    exitPrice: number;
    fees?: number;
};

export class TradeHistoryService {
    /**
     * Record a new trade
     */
    async createTrade(params: CreateTradeParams): Promise<Trade> {
        const trade = await prisma.trade.create({
            data: {
                symbol: params.symbol,
                side: params.side,
                entryPrice: params.entryPrice,
                size: params.size,
                leverage: params.leverage || 1,
                userAddress: params.userAddress,
                strategyName: params.strategyName,
                status: 'open'
            }
        });

        return this.mapToTrade(trade);
    }

    /**
     * Close an existing trade
     */
    async closeTrade(params: CloseTradeParams): Promise<Trade | null> {
        try {
            const trade = await prisma.trade.findUnique({
                where: { id: params.tradeId }
            });

            if (!trade || trade.status === 'closed') {
                return null;
            }

            // Calculate realized P&L
            const priceDiff = params.exitPrice - trade.entryPrice;
            const multiplier = trade.side === 'long' ? 1 : -1;
            const realizedPnl = (priceDiff * multiplier * trade.size * trade.leverage) - (params.fees || 0);

            const updated = await prisma.trade.update({
                where: { id: params.tradeId },
                data: {
                    exitPrice: params.exitPrice,
                    realizedPnl,
                    fees: params.fees || 0,
                    status: 'closed',
                    closedAt: new Date()
                }
            });

            return this.mapToTrade(updated);
        } catch (err) {
            console.error('[TradeHistory] Failed to close trade:', err);
            return null;
        }
    }

    /**
     * Get all trades for a user
     */
    async getTrades(userAddress: string, status?: TradeStatus, limit: number = 100): Promise<Trade[]> {
        const trades = await prisma.trade.findMany({
            where: {
                userAddress,
                ...(status && { status })
            },
            orderBy: { openedAt: 'desc' },
            take: limit
        });

        return trades.map(this.mapToTrade);
    }

    /**
     * Get trade analytics for a user
     */
    async getAnalytics(userAddress: string, timeframe?: { start: Date; end: Date }): Promise<TradeAnalytics> {
        const where: any = { userAddress };

        if (timeframe) {
            where.openedAt = {
                gte: timeframe.start,
                lte: timeframe.end
            };
        }

        const allTrades = await prisma.trade.findMany({ where });
        const closedTrades = allTrades.filter(t => t.status === 'closed');
        const openTrades = allTrades.filter(t => t.status === 'open');

        const winningTrades = closedTrades.filter(t => (t.realizedPnl || 0) > 0);
        const losingTrades = closedTrades.filter(t => (t.realizedPnl || 0) < 0);

        const totalPnl = closedTrades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
        const totalWins = winningTrades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
        const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0));

        const avgWin = winningTrades.length > 0 ? totalWins / winningTrades.length : 0;
        const avgLoss = losingTrades.length > 0 ? totalLosses / losingTrades.length : 0;

        const largestWin = winningTrades.length > 0
            ? Math.max(...winningTrades.map(t => t.realizedPnl || 0))
            : 0;
        const largestLoss = losingTrades.length > 0
            ? Math.min(...losingTrades.map(t => t.realizedPnl || 0))
            : 0;

        const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

        // Calculate average hold time for closed trades
        const holdTimes = closedTrades
            .filter(t => t.closedAt)
            .map(t => {
                const opened = new Date(t.openedAt).getTime();
                const closed = new Date(t.closedAt!).getTime();
                return (closed - opened) / (1000 * 60 * 60); // hours
            });

        const avgHoldTime = holdTimes.length > 0
            ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length
            : 0;

        return {
            totalTrades: allTrades.length,
            openTrades: openTrades.length,
            closedTrades: closedTrades.length,
            winningTrades: winningTrades.length,
            losingTrades: losingTrades.length,
            winRate: closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : 0,
            totalPnl,
            avgWin,
            avgLoss,
            largestWin,
            largestLoss,
            profitFactor,
            avgHoldTime
        };
    }

    /**
     * Get trades for a specific symbol
     */
    async getTradesForSymbol(symbol: string, userAddress: string): Promise<Trade[]> {
        const trades = await prisma.trade.findMany({
            where: {
                symbol,
                userAddress
            },
            orderBy: { openedAt: 'desc' }
        });

        return trades.map(this.mapToTrade);
    }

    /**
     * Delete a trade (admin function)
     */
    async deleteTrade(tradeId: string, userAddress: string): Promise<boolean> {
        try {
            await prisma.trade.delete({
                where: {
                    id: tradeId,
                    userAddress
                }
            });
            return true;
        } catch (err) {
            console.error('[TradeHistory] Failed to delete trade:', err);
            return false;
        }
    }

    private mapToTrade(dbTrade: any): Trade {
        return {
            id: dbTrade.id,
            symbol: dbTrade.symbol,
            side: dbTrade.side as TradeSide,
            entryPrice: dbTrade.entryPrice,
            exitPrice: dbTrade.exitPrice,
            size: dbTrade.size,
            leverage: dbTrade.leverage,
            realizedPnl: dbTrade.realizedPnl,
            fees: dbTrade.fees,
            status: dbTrade.status as TradeStatus,
            openedAt: dbTrade.openedAt,
            closedAt: dbTrade.closedAt,
            userAddress: dbTrade.userAddress,
            strategyName: dbTrade.strategyName
        };
    }
}
