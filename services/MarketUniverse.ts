export type HyperliquidAsset = {
    name?: unknown;
    isDelisted?: unknown;
};

export type HyperliquidAssetCtx = {
    markPx?: unknown;
    indexPx?: unknown;
    oraclePx?: unknown;
    openInterest?: unknown;
    funding?: unknown;
    dayNtlVlm?: unknown;
};

export type ActiveMarket = {
    asset: HyperliquidAsset & { name: string };
    ctx: HyperliquidAssetCtx | undefined;
    index: number;
};

export type MarketTickRow = {
    ts: Date;
    symbol: string;
    markPrice: number;
    indexPrice: number;
    openInterest: number;
    fundingRate: number;
    volume24h: number;
};

export function activeMarketAssets(universe: unknown[], assetCtxs: unknown[] = []): ActiveMarket[] {
    return universe
        .map((asset, index) => ({ asset: asset as HyperliquidAsset, ctx: assetCtxs[index] as HyperliquidAssetCtx | undefined, index }))
        .filter((entry): entry is ActiveMarket =>
            typeof entry.asset.name === "string" &&
            entry.asset.name.length > 0 &&
            entry.asset.isDelisted !== true
        );
}

export function buildMarketTickRow(symbol: string, ctx: HyperliquidAssetCtx | undefined, ts: Date): MarketTickRow | null {
    const markPrice = numberFrom(ctx?.markPx);
    if (markPrice === null || markPrice <= 0) return null;

    return {
        ts,
        symbol,
        markPrice,
        indexPrice: numberFrom(ctx?.indexPx) ?? numberFrom(ctx?.oraclePx) ?? markPrice,
        openInterest: (numberFrom(ctx?.openInterest) ?? 0) * markPrice,
        fundingRate: numberFrom(ctx?.funding) ?? 0,
        volume24h: numberFrom(ctx?.dayNtlVlm) ?? 0
    };
}

export function volume24hFromCtx(ctx: HyperliquidAssetCtx | undefined): number {
    return numberFrom(ctx?.dayNtlVlm) ?? 0;
}

export function prioritizeBackfillSymbols(
    rankedSymbols: string[],
    explicitPrioritySymbols: string[],
    priorityLimit: number
): { prioritySymbols: string[]; remainingSymbols: string[] } {
    const limit = Number.isFinite(priorityLimit) && priorityLimit > 0
        ? Math.floor(priorityLimit)
        : rankedSymbols.length;
    const rankedSet = new Set(rankedSymbols);
    const prioritySymbols: string[] = [];
    const seen = new Set<string>();
    const addPriority = (symbol: string) => {
        if (!rankedSet.has(symbol) || seen.has(symbol)) return;
        prioritySymbols.push(symbol);
        seen.add(symbol);
    };

    for (const symbol of explicitPrioritySymbols) addPriority(symbol);

    const targetSize = Math.max(prioritySymbols.length, Math.min(limit, rankedSymbols.length));
    for (const symbol of rankedSymbols) {
        if (prioritySymbols.length >= targetSize) break;
        addPriority(symbol);
    }

    return {
        prioritySymbols,
        remainingSymbols: rankedSymbols.filter(symbol => !seen.has(symbol))
    };
}

function numberFrom(value: unknown): number | null {
    const n = typeof value === "number"
        ? value
        : typeof value === "string"
            ? parseFloat(value)
            : NaN;

    return Number.isFinite(n) ? n : null;
}
