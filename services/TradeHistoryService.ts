import { getClearinghouseState, getUserFills } from "@/lib/hyperliquid-info";
import { prisma } from "@/lib/db";
import { safeWarn } from "@/lib/log/safeLogger";

type VenueFill = {
    coin: string;
    side: 'B' | 'A';
    dir?: string;
    sz: string;
    px: string;
    startPosition?: string;
    closedPnl?: string;
    fee?: string;
    feeToken?: string;
    leverage?: number | string | { value: number | string };
    hash: string;
    oid: number;
    cloid?: string | null;
    tid?: number;
    time: number;
};

export type TradeStatus = 'open' | 'closed';
export type TradeSide = 'long' | 'short';
export type TradeAction = 'buy' | 'sell';

export type Trade = {
    id: string;
    symbol: string;
    side: TradeSide;
    entryPrice: number | null;
    exitPrice?: number;
    size: number;
    leverage: number | null;
    leverageSource?: 'fill' | 'order' | 'current';
    leverageObservedAt?: Date;
    marginMode?: 'cross' | 'isolated';
    realizedPnl?: number;
    fees: number;
    feeToken?: string;
    status: TradeStatus;
    openedAt: Date;
    closedAt?: Date;
    userAddress: string;
    strategyName?: string;
    action: TradeAction;
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
    totalFees: number;
    largestWin: number;
    largestLoss: number;
    profitFactor: number;
    avgHoldTime: number; // in hours
};

function numberFrom(value: unknown): number | null {
    const parsed = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? parseFloat(value)
            : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildCurrentLeverageMap(clearinghouseState: any): Record<string, number> {
    const leverageMap: Record<string, number> = {};
    const assetPositions = Array.isArray(clearinghouseState?.assetPositions)
        ? clearinghouseState.assetPositions
        : [];

    for (const assetPosition of assetPositions) {
        const coin = assetPosition?.position?.coin;
        const leverage = numberFrom(assetPosition?.position?.leverage?.value);
        if (typeof coin === 'string' && leverage) {
            leverageMap[coin] = leverage;
        }
    }

    return leverageMap;
}

async function getLeverageSnapshots(userAddress: string, isTestnet: boolean, fills: VenueFill[]) {
    if (!fills.length) return [];
    const cloids = [...new Set(fills.flatMap(fill => fill.cloid ? [fill.cloid.toLowerCase()] : []))];
    const oids = [...new Set(fills.map(fill => String(fill.oid)))];
    try {
        return await prisma.orderLeverageSnapshot.findMany({
            where: {
                accountAddress: userAddress.toLowerCase(),
                isTestnet,
                OR: [{ cloid: { in: cloids } }, { oid: { in: oids } }],
            },
        });
    } catch (error) {
        safeWarn("Could not read recorded order leverage", error);
        return [];
    }
}

export class TradeHistoryService {
    /**
     * Get all trades (fills) for a user from Hyperliquid
     */
    async getTrades(userAddress: string, isTestnet: boolean = false, limit: number = 100, sinceMs?: number): Promise<Trade[]> {
        try {
            const [fills, clearinghouseState]: [VenueFill[], unknown] = await Promise.all([
                getUserFills(userAddress, isTestnet),
                getClearinghouseState(userAddress, isTestnet)
            ]);
            const currentLeverageBySymbol = buildCurrentLeverageMap(clearinghouseState);
            const snapshots = await getLeverageSnapshots(userAddress, isTestnet, fills);
            const leverageByCloid = new Map(snapshots.map(row => [row.cloid, row]));
            const leverageByOid = new Map(snapshots.flatMap(row => row.oid ? [[`${row.coin}:${row.oid}`, row] as const] : []));

            const positions = new Map<string, { quantity: number; entryPrice: number | null }>();
            // Hyperliquid returns the newest fills first, including fills in the same block.
            // Keep their execution order when replaying cost basis before applying the UI range.
            const chronological = [...fills].reverse().sort((a, b) => a.time - b.time);
            const mapped: Trade[] = chronological.map((fill) => {
                const isBuy = fill.side === 'B';
                const size = parseFloat(fill.sz);
                const price = parseFloat(fill.px);
                const action: TradeAction = isBuy ? 'buy' : 'sell';
                const type: string = fill.dir || (isBuy ? 'Buy' : 'Sell');
                const isSpot = fill.coin.startsWith('@') || fill.coin.includes('/');
                const start = parseFloat(fill.startPosition ?? '');
                const delta = isBuy ? size : -size;
                const canReplay = !isSpot && Number.isFinite(start);
                const isClose = canReplay ? start * delta < 0 : type.includes('Close');
                const isShort = canReplay && isClose ? start < 0 : fill.dir ? type.includes('Short') : !isBuy;
                const side: TradeSide = isShort ? 'short' : 'long';

                let previousEntry: number | null = null;
                if (canReplay && Number.isFinite(delta) && Number.isFinite(price)) {
                    const previous = positions.get(fill.coin);
                    if (previous && Math.abs(previous.quantity - start) < 1e-9) {
                        previousEntry = previous.entryPrice;
                    }
                    const end = start + delta;
                    if (Math.abs(end) < 1e-9) {
                        positions.delete(fill.coin);
                    } else {
                        let entryPrice = previousEntry;
                        if (start === 0 || start * end < 0) {
                            entryPrice = price;
                        } else if (!isClose && previousEntry !== null) {
                            entryPrice = (Math.abs(start) * previousEntry + size * price) / Math.abs(end);
                        }
                        positions.set(fill.coin, { quantity: end, entryPrice });
                    }
                } else if (!isSpot) {
                    positions.delete(fill.coin);
                }

                const fillLeverage = numberFrom(typeof fill.leverage === 'object' ? fill.leverage?.value : fill.leverage);
                const matchedOrder = leverageByOid.get(`${fill.coin}:${fill.oid}`)
                    ?? (fill.cloid ? leverageByCloid.get(fill.cloid.toLowerCase()) : undefined);
                const orderLeverage = matchedOrder?.coin === fill.coin
                    && (matchedOrder.oid === null || matchedOrder.oid === String(fill.oid))
                    && matchedOrder.observedAt.getTime() <= fill.time ? matchedOrder : undefined;
                const observation = fillLeverage === null ? orderLeverage : undefined;
                const currentLeverage = currentLeverageBySymbol[fill.coin];
                const closedPnl = parseFloat(fill.closedPnl ?? '');
                const timestamp = new Date(fill.time);

                return {
                    id: `${fill.coin}:${fill.oid}:${fill.tid ?? fill.hash}`,
                    symbol: fill.coin,
                    side,
                    entryPrice: isClose ? previousEntry : price,
                    exitPrice: isClose ? price : undefined,
                    size,
                    leverage: fillLeverage ?? orderLeverage?.leverage ?? currentLeverage ?? null,
                    leverageSource: fillLeverage !== null ? 'fill' : orderLeverage ? 'order' : currentLeverage ? 'current' : undefined,
                    leverageObservedAt: observation?.observedAt,
                    marginMode: observation?.marginMode === 'cross' || observation?.marginMode === 'isolated'
                        ? observation.marginMode : undefined,
                    realizedPnl: isClose && Number.isFinite(closedPnl) ? closedPnl : undefined,
                    fees: parseFloat(fill.fee || '0'),
                    feeToken: fill.feeToken,
                    status: isClose ? 'closed' : 'open',
                    openedAt: timestamp,
                    closedAt: isClose ? timestamp : undefined,
                    userAddress,
                    action,
                    type,
                };
            });

            mapped.reverse();
            const filtered = sinceMs
                ? mapped.filter(trade => trade.openedAt.getTime() >= sinceMs)
                : mapped;

            return filtered.slice(0, limit);
        } catch (error) {
            console.error("Failed to get trades:", error);
            return [];
        }
    }

    /**
     * Get trade analytics for a user based on fills
     */
    async getAnalytics(userAddress: string, isTestnet: boolean = false, sinceMs?: number): Promise<TradeAnalytics> {
        try {
            const trades = await this.getTrades(userAddress, isTestnet, 1000, sinceMs); // Fetch more for analytics

            let totalTrades = 0;
            let openTrades = 0;
            let closedTrades = 0;
            let winningTrades = 0;
            let losingTrades = 0;
            let totalPnl = 0;
            let totalFees = 0;
            let totalWinPnl = 0;
            let totalLossPnl = 0;
            let maxWin = 0;
            let maxLoss = 0;

            trades.forEach(trade => {
                totalTrades++;
                const fee = trade.fees || 0;
                if (Number.isFinite(fee)) {
                    totalFees += Math.abs(fee);
                }
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
                totalFees,
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
                totalFees: 0,
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
