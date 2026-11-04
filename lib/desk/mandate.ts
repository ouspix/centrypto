/** USD risk limits are operator-owned. Research prompts never supply a mandate. */
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
export type DeskMandate = typeof DEFAULT_DESK_MANDATE;

export function parseDeskMandate(input: unknown): DeskMandate {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a desk mandate");
    const mandate = { ...DEFAULT_DESK_MANDATE };
    for (const key of Object.keys(mandate) as (keyof DeskMandate)[]) {
        const value = (data as Record<string, unknown>)[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
            throw new Error(`Set a positive finite ${key}`);
        mandate[key] = value;
    }
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
