import { depthWithinBand, inspectBook } from "./execution-risk";
import { positive, type DeskL2, type Level } from "./execution-types";
import type { DeskMandate } from "./mandate";

/** Uses the execution gate's midpoint, boundaries and arithmetic on every
 * returned venue level, before any presentation truncation. */
export function bandLiquidity(
    book: DeskL2, mandate: Pick<DeskMandate, "maxSlippageBps" | "minDepthUsd">,
    quoteUsd: number | undefined, now = Date.now(),
) {
    if (!Array.isArray(book?.levels) || !Array.isArray(book.levels[0]) || !Array.isArray(book.levels[1]))
        throw new Error("Order book depth unavailable");
    const { mid } = inspectBook(book, now);
    if (!Number.isFinite(mandate.maxSlippageBps) || mandate.maxSlippageBps < 0 ||
        !Number.isFinite(mandate.minDepthUsd) || mandate.minDepthUsd < 0) throw new Error("Invalid liquidity mandate");
    if (quoteUsd !== undefined) positive(quoteUsd, "quote USD rate");
    const distance = mid * mandate.maxSlippageBps / 10000;
    const side = (levels: Level[], buy: boolean) => {
        let previous = buy ? -Infinity : Infinity;
        for (const level of levels) {
            const price = positive(level.px, "book price");
            positive(level.sz, "book quantity");
            if (buy ? price <= previous : price >= previous) throw new Error("Unsorted or duplicate book levels");
            previous = price;
        }
        const boundary = mid + (buy ? distance : -distance);
        const complete = levels.some(level => buy ? +level.px >= boundary : +level.px <= boundary);
        const observedDepthQuote = depthWithinBand(levels, buy, boundary, 1);
        const observedDepthUsd = quoteUsd === undefined ? null : depthWithinBand(levels, buy, boundary, quoteUsd);
        const status = observedDepthUsd === null ? "usd_conversion_unavailable" :
            observedDepthUsd >= mandate.minDepthUsd ? "sufficient" : complete ? "insufficient" : "incomplete";
        return { orderSide: buy ? "buy" : "sell", boundary, observedDepthQuote, observedDepthUsd,
            status, coverage: complete ? "complete_within_band" : "lower_bound",
            returnedLevels: levels.length,
            levelsWithinBand: levels.filter(level => buy ? +level.px <= boundary : +level.px >= boundary).length };
    };
    return { reference: "midpoint", midpoint: mid, maxSlippageBps: mandate.maxSlippageBps,
        minDepthUsd: mandate.minDepthUsd, observedAt: new Date(book.time).toISOString(),
        bids: side(book.levels[0], false), asks: side(book.levels[1], true),
        instruction: "Use these calculated totals, not sums of displayed levels. Buy entry uses asks; sell entry uses bids. Lower-bound depth can prove sufficiency, but below-threshold incomplete coverage does not prove insufficient liquidity. This snapshot is not order approval; fresh preview repeats all risk and execution checks." };
}
