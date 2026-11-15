const text = { type: "string", minLength: 10, maxLength: 900 };
const ids = { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1 } };
const alternative = { type: "object", additionalProperties: false,
    required: ["available", "caseFor", "caseAgainst", "costs", "uncertainty", "evidenceIds"], properties: {
        available: { type: "boolean" }, caseFor: text, caseAgainst: text,
        costs: { ...text, minLength: 1, pattern: "\\S", description: "Future costs, or a concise explanation such as None when no transaction is needed." },
        uncertainty: text, evidenceIds: { ...ids, minItems: 0, description: "At least one observed evidence ID when available=true; an unavailable alternative may use []." },
    } };
export const portfolioChoiceSchema = { type: "object", additionalProperties: false,
    required: ["holdingInstrumentId", "candidateInstrumentId", "horizonHours", "valuationBasis", "hold", "exitToCash", "rotate", "livePriceReconciliation", "choice", "reason", "changeCondition", "forwardCase", "priceEvidenceId", "priceClaims"],
    properties: {
        holdingInstrumentId: { type: "string", minLength: 1 }, candidateInstrumentId: { type: ["string", "null"] },
        horizonHours: { type: "number", exclusiveMinimum: 0, maximum: 48, description: "Positive forward comparison horizon for an actual nonzero holding. An expired deadline does not mean horizonHours=0; closed positions need no holding comparison." }, valuationBasis: text,
        hold: alternative, exitToCash: alternative, rotate: alternative, livePriceReconciliation: text,
        choice: { enum: ["hold", "exit_to_cash", "rotate", "unresolved"] }, reason: text, changeCondition: text,
        forwardCase: { type: "object", additionalProperties: false,
            required: ["advantageOverCash", "evidenceWeighting", "remainingTimeCase", "assumptionAtRisk"], properties: {
                advantageOverCash: { ...text, description: "Marginal economic advantage from now after future costs; explain cash's advantage if cash is selected. Risk capacity or a surviving stop is not an advantage." },
                evidenceWeighting: { ...text, description: "Why the strongest evidence outweighs the strongest contrary evidence and adverse payoff sensitivity, or why the judgment is unresolved. Do not merely restate a candle sequence or absence of invalidation." },
                remainingTimeCase: { ...text, description: "Why the mechanism can deliver within the remaining original horizon. A deadline is not a reason to wait until it." },
                assumptionAtRisk: { ...text, description: "The assumption the preferred decision needs, how the evidence supports it, and what observation would overturn it. No invented probabilities." },
            } },
        priceEvidenceId: { type: ["string", "null"], description: "Exact priceEvidenceId from this holding's order_book/current market_history quote. Null only when no price claim is made and explain the missing evidence." },
        priceClaims: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false,
            required: ["referencePrice", "liveRelation"], properties: { referencePrice: { type: "number", exclusiveMinimum: 0 },
                liveRelation: { enum: ["above", "below", "touching_or_straddling"] } } },
            description: "Up to 16 decisive live-versus-level claims, including cited closes, stop and target. Avoid duplicate levels. The host verifies every claim against the referenced bid/ask; do not contradict these relations in prose." },
    } };
type Alternative = { available: boolean; caseFor: string; caseAgainst: string; costs: string; uncertainty: string; evidenceIds: string[] };
export type PortfolioChoice = { holdingInstrumentId: string; candidateInstrumentId: string | null; horizonHours: number;
    valuationBasis: string; hold: Alternative; exitToCash: Alternative; rotate: Alternative; livePriceReconciliation: string;
    choice: "hold" | "exit_to_cash" | "rotate" | "unresolved"; reason: string; changeCondition: string;
    forwardCase: { advantageOverCash: string; evidenceWeighting: string; remainingTimeCase: string; assumptionAtRisk: string };
    priceEvidenceId: string | null; priceClaims: Array<{ referencePrice: number; liveRelation: "above" | "below" | "touching_or_straddling" }> };
export type PriceFacts = { instrumentId: string; bid: number; ask: number; time: number };
export function reviewPortfolioChoice(input: PortfolioChoice, priceFacts?: PriceFacts) {
    for (const alternative of [input.hold, input.exitToCash, input.rotate]) {
        if (alternative.available && alternative.evidenceIds.length === 0) throw new Error("Cite observed evidence for each available alternative; unavailable alternatives may have no evidence.");
    }
    if (input.candidateInstrumentId === input.holdingInstrumentId) throw new Error("Replacement must be a distinct instrument; a same-instrument adjustment is not rotation.");
    if (!input.candidateInstrumentId && input.rotate.available) throw new Error("Without a concrete candidate, mark rotation unavailable and explain why; never invent one to complete the journal.");
    const selected = input.choice === "hold" ? input.hold : input.choice === "exit_to_cash" ? input.exitToCash : input.choice === "rotate" ? input.rotate : null;
    if (selected && !selected.available) throw new Error("The selected alternative is unavailable; explain an unresolved decision instead.");
    if (input.priceClaims?.length && !input.priceEvidenceId) throw new Error("Price claims need the holding's observed priceEvidenceId.");
    if (input.priceEvidenceId && (!priceFacts || priceFacts.instrumentId !== input.holdingInstrumentId))
        throw new Error("Read this holding's current price evidence before recording numerical claims; evidence from another instrument or shift is not valid.");
    const checkedPrices = (input.priceClaims ?? []).map(claim => {
        const actual = priceFacts!.bid > claim.referencePrice ? "above" : priceFacts!.ask < claim.referencePrice ? "below" : "touching_or_straddling";
        if (actual !== claim.liveRelation) throw new Error(`Price claim contradicts observed bid ${priceFacts!.bid} / ask ${priceFacts!.ask}: live is ${actual} ${claim.referencePrice}, not ${claim.liveRelation}. Correct the claim and reassess its effect on the choice.`);
        return { ...claim, bid: priceFacts!.bid, ask: priceFacts!.ask, observedAt: new Date(priceFacts!.time).toISOString() };
    });
    return { recorded: true, executionAuthorized: false, checkedPrices,
        instruction: "Comparative judgment recorded, not verified alpha or order permission. Holding and cash are valid choices. Use current execution checks for any action; urgent protection never waits for this journal." };
}

/** Price sensitivity only, not an expected return or automatic hold/cash threshold. */
export function holdingPriceSensitivity(holding: { quantity: number; stopPrice: number | null; targetPrice: number | null }, quote: { bid: number; ask: number }) {
    const price = holding.quantity > 0 ? quote.bid : quote.ask;
    return { currentExitSidePrice: price, quantity: holding.quantity,
        stopPrice: holding.stopPrice, targetPrice: holding.targetPrice,
        grossToStopUsd: holding.stopPrice === null ? null : holding.quantity * (holding.stopPrice - price),
        grossToTargetUsd: holding.targetPrice === null ? null : holding.quantity * (holding.targetPrice - price),
        costs: "Future fees, funding and depth walking are not included; use assess_portfolio_choices for costed conditional scenarios when decisive.",
        instruction: "Forward sensitivity from the observed executable side, excluding sunk entry PnL. These levels are scenarios, not exhaustive outcomes, probabilities or guaranteed fills. Do not change stops, targets or deadlines to improve arithmetic. Explain why evidence makes the selected alternative worth its downside and remaining time; no ratio mandates a trade or exit." };
}

const cash = { type: "number" }, positive = { type: "number", exclusiveMinimum: 0 };
export const portfolioScenarioSchema = { type: "object", additionalProperties: false,
    required: ["holdingInstrumentId", "candidateInstrumentId", "candidateSide", "candidateQuantity", "horizonHours", "assumptions", "evidenceIds", "scenarios"],
    properties: {
        holdingInstrumentId: { type: "string" }, candidateInstrumentId: { type: ["string", "null"] },
        candidateSide: { type: ["string", "null"], enum: ["buy", "sell", null] }, candidateQuantity: { type: ["number", "null"], exclusiveMinimum: 0 },
        horizonHours: { ...positive, maximum: 48 }, assumptions: text, evidenceIds: ids,
        scenarios: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", additionalProperties: false,
            required: ["label", "basis", "holdingExitPrice", "holdingFundingUsd", "holdingOtherCostsUsd", "candidateExitPrice", "candidateFundingUsd", "candidateOtherCostsUsd", "probability"],
            properties: { label: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S", description: "Short scenario name, for example Stop or Extension. Explain the scenario in basis." }, basis: text, holdingExitPrice: positive, holdingFundingUsd: cash, holdingOtherCostsUsd: { ...cash, minimum: 0 },
                candidateExitPrice: { type: ["number", "null"], exclusiveMinimum: 0 }, candidateFundingUsd: { type: ["number", "null"] },
                candidateOtherCostsUsd: { type: ["number", "null"], minimum: 0 }, probability: { type: ["number", "null"], minimum: 0, maximum: 1 } } } },
    } };
export type PortfolioScenario = { label: string; basis: string; holdingExitPrice: number; holdingFundingUsd: number; holdingOtherCostsUsd: number;
    candidateExitPrice: number | null; candidateFundingUsd: number | null; candidateOtherCostsUsd: number | null; probability: number | null };
export type PortfolioScenarioInput = { holdingInstrumentId: string; candidateInstrumentId: string | null; candidateSide: "buy" | "sell" | null;
    candidateQuantity: number | null; horizonHours: number; assumptions: string; evidenceIds: string[]; scenarios: PortfolioScenario[] };
export type PortfolioQuote = { bid: number; ask: number; time: number; bids: Array<{ px: string; sz: string }>; asks: Array<{ px: string; sz: string }> };
function sweep(levels: PortfolioQuote["bids"], quantity: number) {
    let remaining = quantity, value = 0;
    for (const level of levels) {
        if (!(+level.px > 0) || !(+level.sz >= 0)) return null;
        const fill = Math.min(remaining, +level.sz); value += fill * +level.px; remaining -= fill;
        if (remaining <= quantity * 1e-10) return value / quantity;
    }
    return null;
}
/** Common current-midpoint baseline; prior entry PnL/fees are deliberately absent. */
export function comparePortfolioScenarios(input: PortfolioScenarioInput, quantity: number, holding: PortfolioQuote,
    candidate: PortfolioQuote | null, feeRate: number | null, now = Date.now()) {
    const validQuote = (q: PortfolioQuote) => q.bid > 0 && q.ask >= q.bid && Number.isFinite(q.bid + q.ask) && q.time <= now + 1000 && now - q.time <= 5000;
    if (!Number.isFinite(quantity) || !quantity || !validQuote(holding) || (candidate && !validQuote(candidate)))
        throw new Error("Current owned quantity and fresh valid quotes are required.");
    if (feeRate === null || !Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) return { status: "costs_unavailable", instruction: "Fee data unavailable; do not assume free turnover or rank choices numerically." };
    if (!(input.horizonHours > 0 && input.horizonHours <= 48) || input.scenarios.length < 2 || input.scenarios.length > 4) throw new Error("Use a common positive horizon and two to four scenarios.");
    const rotation = !!input.candidateInstrumentId;
    if (rotation && (!candidate || !input.candidateQuantity || !Number.isFinite(input.candidateQuantity) || !["buy", "sell"].includes(input.candidateSide!)) ||
        !rotation && (candidate || input.candidateQuantity !== null || input.candidateSide !== null)) throw new Error("Supply a complete replacement or null candidate fields.");
    const weights = input.scenarios.map(s => s.probability), weighted = weights.every(p => p !== null);
    if (weights.some(p => p !== null && (!Number.isFinite(p) || p < 0 || p > 1)) ||
        weighted && Math.abs(weights.reduce((n, p) => n + p!, 0) - 1) > 1e-6 || !weighted && weights.some(p => p !== null)) throw new Error("Probabilities must all be null or sum to one.");
    const mid = (holding.bid + holding.ask) / 2, size = Math.abs(quantity), sign = Math.sign(quantity);
    const exitPrice = sweep(quantity > 0 ? holding.bids : holding.asks, size);
    const candidateEntry = candidate && input.candidateQuantity ? sweep(input.candidateSide === "buy" ? candidate.asks : candidate.bids, input.candidateQuantity) : null;
    const closeCash = exitPrice === null ? null : sign * size * (exitPrice - mid) - size * exitPrice * feeRate;
    const outcomes = input.scenarios.map(s => {
        if (!(s.holdingExitPrice > 0) || ![s.holdingExitPrice, s.holdingFundingUsd, s.holdingOtherCostsUsd].every(Number.isFinite) || s.holdingOtherCostsUsd < 0 ||
            rotation && (!(s.candidateExitPrice! > 0) || ![s.candidateExitPrice, s.candidateFundingUsd, s.candidateOtherCostsUsd].every(x => typeof x === "number" && Number.isFinite(x)) || s.candidateOtherCostsUsd! < 0) ||
            !rotation && [s.candidateExitPrice, s.candidateFundingUsd, s.candidateOtherCostsUsd].some(x => x !== null)) throw new Error("Supply executable scenario exit prices and explicit funding/cost assumptions for each relevant leg.");
        const hold = sign * size * (s.holdingExitPrice - mid) - size * s.holdingExitPrice * feeRate + s.holdingFundingUsd - s.holdingOtherCostsUsd;
        const rotate = closeCash === null || candidateEntry === null ? null : closeCash + (input.candidateSide === "buy" ? 1 : -1) * input.candidateQuantity! * (s.candidateExitPrice! - candidateEntry)
            - input.candidateQuantity! * (candidateEntry + s.candidateExitPrice!) * feeRate + s.candidateFundingUsd! - s.candidateOtherCostsUsd!;
        if (![hold, closeCash, rotate].every(v => v === null || Number.isFinite(v))) throw new Error("Portfolio scenario arithmetic exceeds supported range.");
        return { ...s, holdUsd: hold, exitToCashUsd: closeCash, rotateUsd: rotate,
            holdMinusCashUsd: closeCash === null ? null : hold - closeCash, rotateMinusHoldUsd: rotate === null ? null : rotate - hold };
    });
    return { status: "conditional_sensitivity_only", executionAuthorized: false, horizonHours: input.horizonHours,
        baseline: { currentHoldingMid: mid, quantity, priorEntryAndPaidFeesExcluded: true },
        currentCosts: { exitVwap: exitPrice, exitFeeUsd: exitPrice === null ? null : size * exitPrice * feeRate,
            candidateEntryVwap: candidateEntry, candidateEntryFeeUsd: candidateEntry === null ? null : input.candidateQuantity! * candidateEntry * feeRate, feeRate },
        outcomes, expected: weighted ? { holdUsd: outcomes.reduce((n, s) => n + s.probability! * s.holdUsd, 0),
            cashUsd: closeCash, rotateUsd: outcomes.some(s => s.rotateUsd === null) ? null : outcomes.reduce((n, s) => n + s.probability! * s.rotateUsd!, 0) } : null,
        instruction: "No winner selected. Current depth walking and fees are estimates, not a preview. Null costs/outcomes mean unavailable depth, not zero or a rejection. Scenario exits must be executable prices with future spread/slippage included; future funding and additional costs are assumptions. Cash earns zero in this comparison. Honor original deadlines: model an earlier mandated exit then cash, never extend a position to fit a horizon. A stop is a risk bound, not evidence of positive holding value. Rotation requires exit reconciliation followed by fresh sizing/preview under unchanged limits; no atomic replacement or future permission is granted.",
    };
}
