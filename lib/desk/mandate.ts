/** USD risk limits are operator-owned. Research prompts never supply a mandate. */
/** Existing host safeguards, independent of operator settings. Keep these enforced. */
export const DIRECTIONAL_HOST_LIMITS = { capitalUsd: 1245, sizingGrossLeverage: 1, sizingHeadroomBps: 200 } as const;
export const LEGACY_SIZING_DEFAULTS = { concurrentPositions: 2, costAllowanceBps: 50 } as const;
export const DEFAULT_DESK_MANDATE = {
    capitalUsd: 1000,
    maxOrderUsd: 100,
    maxInstrumentUsd: 250,
    maxGrossLeverage: 1,
    maxDailyLossUsd: 30,
    maxRiskPerTradeUsd: 15,
    maxSlippageBps: 15,
    minDepthUsd: 2500,
};
export type DeskMandate = typeof DEFAULT_DESK_MANDATE & {
    maxOpenRiskUsd?: number;
    maxConcurrentPositions?: number;
    costAllowanceBps?: number;
};

export const SWING_DESK_MANDATE: DeskMandate = {
    capitalUsd: 1245, maxOrderUsd: 500, maxInstrumentUsd: 500, maxGrossLeverage: 1,
    maxDailyLossUsd: 24.9, maxRiskPerTradeUsd: 6.225, maxSlippageBps: 15, minDepthUsd: 2500,
    maxOpenRiskUsd: 12.45, maxConcurrentPositions: 2, costAllowanceBps: 50,
};

export function parseDeskMandate(input: unknown): DeskMandate {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a desk mandate");
    const mandate: DeskMandate = { ...DEFAULT_DESK_MANDATE };
    for (const key of Object.keys(DEFAULT_DESK_MANDATE) as (keyof typeof DEFAULT_DESK_MANDATE)[]) {
        const value = (data as Record<string, unknown>)[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
            throw new Error(`Set a positive finite ${key}`);
        mandate[key] = value;
    }
    for (const key of ["maxOpenRiskUsd", "maxConcurrentPositions", "costAllowanceBps"] as const) {
        const value = (data as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
            throw new Error(`Invalid ${key}`);
        mandate[key] = value;
    }
    if (mandate.maxConcurrentPositions !== undefined &&
        (!Number.isInteger(mandate.maxConcurrentPositions) || mandate.maxConcurrentPositions > 20))
        throw new Error("Invalid concurrent position count");
    if ((mandate.maxOpenRiskUsd ?? 0) > mandate.capitalUsd || (mandate.costAllowanceBps ?? 0) >= 10000)
        throw new Error("Invalid aggregate risk or cost allowance");
    if (
        mandate.maxRiskPerTradeUsd > mandate.capitalUsd ||
        mandate.maxDailyLossUsd > mandate.capitalUsd ||
        mandate.maxSlippageBps >= 10000 ||
        mandate.maxOrderUsd > mandate.maxInstrumentUsd ||
        mandate.maxInstrumentUsd > mandate.maxGrossLeverage * mandate.capitalUsd
    )
        throw new Error("Order, exposure, loss and slippage limits must fit the book mandate");
    return mandate;
}

/** Versioned book settings plus separately labelled, unchanged host/sizing constraints. */
export function bookRiskContext(book: { id: string; version: number; mandateJson: string }) {
    const mandate = parseDeskMandate(book.mandateJson);
    return {
        source: "current_book_mandate" as const, bookId: book.id, bookVersion: book.version, mandate,
        hostLimits: DIRECTIONAL_HOST_LIMITS,
        sizingPolicy: {
            capitalCeilingUsd: Math.min(mandate.capitalUsd, DIRECTIONAL_HOST_LIMITS.capitalUsd),
            maxGrossLeverage: Math.min(mandate.maxGrossLeverage, DIRECTIONAL_HOST_LIMITS.sizingGrossLeverage),
            aggregateRiskLimitUsd: mandate.maxOpenRiskUsd ?? mandate.maxRiskPerTradeUsd * 2,
            maxConcurrentPositions: mandate.maxConcurrentPositions ?? LEGACY_SIZING_DEFAULTS.concurrentPositions,
            costAllowanceBps: mandate.costAllowanceBps ?? LEGACY_SIZING_DEFAULTS.costAllowanceBps,
        },
        instruction: "The versioned mandate is the operator's current configuration. Host safeguards and conservative sizing constraints are separate and remain enforced. Sizing fallbacks apply only to omitted optional fields. Strategy descriptions, activation snapshots and old journal amounts are not current limits. Available capacity is not an instruction to trade. Fresh execution checks remain authoritative; this read grants no orders or settings changes.",
    };
}
