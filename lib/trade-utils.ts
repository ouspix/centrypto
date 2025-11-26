
export type OrderRequest = {
    asset: number;
    isBuy: boolean;
    limitPx: number;
    sz: number;
    reduceOnly: boolean;
};

/**
 * Generates parameters for a close position order with aggressive pricing to ensure execution.
 * 
 * @param assetIndex - The index of the asset in the universe
 * @param size - The size of the position to close (absolute value)
 * @param currentPrice - The current market price (or entry price if market price unavailable)
 * @param isLong - Whether the position being closed is a Long position
 * @returns OrderRequest object formatted for the API
 */
export function getCloseOrderParams(
    assetIndex: number,
    size: number,
    currentPrice: number,
    isLong: boolean
): OrderRequest {
    // Aggressive price buffer (10%) to ensure fill
    // If Long, we sell (Ask), so we want to sell lower than market to fill immediately
    // If Short, we buy (Bid), so we want to buy higher than market to fill immediately
    const aggressivePrice = isLong
        ? currentPrice * 0.9  // Sell into bids
        : currentPrice * 1.1; // Buy into asks

    return {
        asset: assetIndex,
        isBuy: !isLong, // Close Long = Sell (isBuy=false), Close Short = Buy (isBuy=true)
        limitPx: aggressivePrice,
        sz: Math.abs(size),
        reduceOnly: true
    };
}
