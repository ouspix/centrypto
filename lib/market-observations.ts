import type { PrismaClient } from "@prisma/market-client";

/** Receipt time is evidence of collection, not an invented publication time. */
export type CandleObservation = {
    symbol: string;
    timeframe: string;
    openTime: Date;
    closeTime: Date;
    receivedAt: Date;
    recordedAt?: Date;
    source: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

export function candleObservation(candle: Omit<CandleObservation, "closeTime" | "recordedAt">): CandleObservation {
    if (candle.timeframe !== "1m") throw new Error("Collector observations require one-minute candles");
    return { ...candle, closeTime: new Date(candle.openTime.getTime() + 60_000) };
}

export function observationsAsOf<T extends CandleObservation>(observations: T[], decision: Date): T[] {
    const latest = new Map<string, T>();
    for (const observation of observations) {
        // Missing receipt/storage timestamps cannot certify historical availability.
        if (!observation.receivedAt || !observation.recordedAt ||
            observation.closeTime > decision || observation.receivedAt > decision || observation.recordedAt > decision) continue;
        const key = `${observation.symbol}:${observation.timeframe}:${observation.openTime.toISOString()}`;
        const prior = latest.get(key);
        if (!prior || observation.receivedAt > prior.receivedAt ||
            (+observation.receivedAt === +prior.receivedAt && observation.recordedAt >= prior.recordedAt!)) latest.set(key, observation);
    }
    return [...latest.values()].sort((a, b) => +a.openTime - +b.openTime || a.symbol.localeCompare(b.symbol));
}

/** Never fall back to the mutable latest-candle table for a timed replay. */
export async function readObservedCandlesAsOf(db: PrismaClient, symbol: string, start: Date, end: Date, decision: Date) {
    const rows = await db.marketCandleObservation.findMany({
        where: { symbol, timeframe: "1m", openTime: { gte: start, lt: end }, closeTime: { lte: decision }, receivedAt: { lte: decision }, recordedAt: { lte: decision } },
        orderBy: [{ openTime: "asc" }, { receivedAt: "asc" }, { recordedAt: "asc" }, { id: "asc" }]
    });
    return observationsAsOf(rows, decision);
}

export function liquidityFeatures(book: { bid?: number | null; ask?: number | null; bidSize?: number | null; askSize?: number | null; receivedAt?: Date | null }, decision: Date) {
    const { bid, ask, bidSize, askSize, receivedAt } = book;
    const age = receivedAt ? +decision - +receivedAt : NaN;
    const validPrices = Number.isFinite(age) && age >= 0 && age <= 60_000 &&
        Number.isFinite(bid) && Number.isFinite(ask) && bid! > 0 && ask! > bid!;
    const validSizes = validPrices && Number.isFinite(bidSize) && Number.isFinite(askSize) && bidSize! > 0 && askSize! > 0;
    const bidValue = bid! * bidSize!, askValue = ask! * askSize!;
    return {
        liquidity_spread_bps: validPrices ? 10_000 * (ask! - bid!) / ((ask! + bid!) / 2) : null,
        liquidity_log_min_side_usd: validSizes ? Math.log1p(Math.min(bidValue, askValue)) : null,
        liquidity_imbalance: validSizes ? (bidValue - askValue) / (bidValue + askValue) : null,
    };
}
