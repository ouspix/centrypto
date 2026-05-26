import type { PositionSide } from "@/lib/trader/position-management-types";

export function directionalBps(side: PositionSide, entry: number, current: number): number {
    if (entry <= 0 || current <= 0) return 0;
    return side === "long"
        ? ((current - entry) / entry) * 10000
        : ((entry - current) / entry) * 10000;
}

export function netCurrentBps(grossCurrentBps: number, estimatedExitFeeBps: number, feeBufferBps: number): number {
    return grossCurrentBps - Math.max(0, estimatedExitFeeBps) - Math.max(0, feeBufferBps);
}

export function givebackPct(mfeBps: number | null | undefined, netCurrentBpsValue: number): number | null {
    if (!Number.isFinite(mfeBps) || (mfeBps ?? 0) <= 0) return null;
    const raw = (((mfeBps as number) - Math.max(netCurrentBpsValue, 0)) / (mfeBps as number)) * 100;
    return clamp(raw, 0, 300);
}

export function stopDistanceBps(side: PositionSide, entryPrice: number, stopPx: number | null | undefined): number | null {
    if (entryPrice <= 0 || !stopPx || stopPx <= 0) return null;
    const distance = side === "long"
        ? ((entryPrice - stopPx) / entryPrice) * 10000
        : ((stopPx - entryPrice) / entryPrice) * 10000;
    return distance >= 0 ? distance : null;
}

export function takeProfitDistanceBps(side: PositionSide, entryPrice: number, takeProfitPx: number | null | undefined): number | null {
    if (entryPrice <= 0 || !takeProfitPx || takeProfitPx <= 0) return null;
    const distance = side === "long"
        ? ((takeProfitPx - entryPrice) / entryPrice) * 10000
        : ((entryPrice - takeProfitPx) / entryPrice) * 10000;
    return distance >= 0 ? distance : null;
}

export function breakevenStopPrice(side: PositionSide, entryPrice: number, breakevenBufferBps: number): number {
    if (entryPrice <= 0) return 0;
    return side === "long"
        ? entryPrice * (1 + breakevenBufferBps / 10000)
        : entryPrice * (1 - breakevenBufferBps / 10000);
}

export function trailingStopPrice(side: PositionSide, currentPrice: number, trailingDistanceBps: number): number {
    if (currentPrice <= 0) return 0;
    return side === "long"
        ? currentPrice * (1 - trailingDistanceBps / 10000)
        : currentPrice * (1 + trailingDistanceBps / 10000);
}

export function capTakeProfitPrice(side: PositionSide, entryPrice: number, capBps: number): number {
    if (entryPrice <= 0) return 0;
    return side === "long"
        ? entryPrice * (1 + capBps / 10000)
        : entryPrice * (1 - capBps / 10000);
}

export function capStopPrice(side: PositionSide, entryPrice: number, capBps: number): number {
    if (entryPrice <= 0) return 0;
    return side === "long"
        ? entryPrice * (1 - capBps / 10000)
        : entryPrice * (1 + capBps / 10000);
}

export function isStopWorseThan(side: PositionSide, currentStopPx: number | null, desiredStopPx: number): boolean {
    if (!currentStopPx || currentStopPx <= 0 || desiredStopPx <= 0) return true;
    return side === "long" ? currentStopPx < desiredStopPx : currentStopPx > desiredStopPx;
}

export function betterStopPrice(side: PositionSide, a: number, b: number): number {
    if (a <= 0) return b;
    if (b <= 0) return a;
    return side === "long" ? Math.max(a, b) : Math.min(a, b);
}

export function liquidationDistancePct(side: PositionSide, currentPrice: number, liquidationPrice: number | null | undefined): number | null {
    if (currentPrice <= 0 || !liquidationPrice || liquidationPrice <= 0) return null;
    const raw = side === "long"
        ? ((currentPrice - liquidationPrice) / currentPrice) * 100
        : ((liquidationPrice - currentPrice) / currentPrice) * 100;
    return Number.isFinite(raw) ? raw : null;
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}
