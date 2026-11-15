export type ScenarioAssessment = {
    instrumentId: string;
    side: "buy" | "sell";
    quantity: number;
    entryPrice: number;
    entryFeeRate: number;
    exitFeeRate: number;
    horizonHours: number;
    assumptions: string;
    evidenceIds: string[];
    scenarios: Array<{ label: string; exitPrice: number; probability: number | null; fundingQuote: number; otherCostsQuote: number; basis?: string }>;
};

const positive = { type: "number", exclusiveMinimum: 0 };
const fee = { type: "number", minimum: 0, exclusiveMaximum: 1 };
export const scenarioAssessmentSchema = {
    type: "object", additionalProperties: false,
    required: ["instrumentId", "side", "quantity", "entryPrice", "entryFeeRate", "exitFeeRate", "horizonHours", "assumptions", "evidenceIds", "scenarios"],
    properties: {
        instrumentId: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] },
        quantity: positive, entryPrice: positive, horizonHours: positive,
        entryFeeRate: fee, exitFeeRate: fee,
        assumptions: { type: "string", minLength: 1, maxLength: 1400 },
        evidenceIds: { type: "array", maxItems: 12, items: { type: "string", maxLength: 250 } },
        scenarios: { type: "array", minItems: 2, maxItems: 5, items: {
            type: "object", additionalProperties: false,
            required: ["label", "exitPrice", "probability", "fundingQuote", "otherCostsQuote"],
            properties: {
                basis: { type: "string", minLength: 10, maxLength: 700 },
                label: { type: "string", minLength: 1, maxLength: 120 }, exitPrice: positive,
                probability: { type: ["number", "null"], minimum: 0, maximum: 1 },
                fundingQuote: { type: "number" }, otherCostsQuote: { type: "number", minimum: 0 },
            },
        } },
    },
};

/** Arithmetic over explicitly supplied assumptions, not a price/probability oracle
 * or an execution approval. All cash flows use the instrument's quote currency. */
export function assessScenarios(input: ScenarioAssessment) {
    const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
    if (![input.quantity, input.entryPrice, input.horizonHours].every(x => finite(x) && x > 0) ||
        ![input.entryFeeRate, input.exitFeeRate].every(x => finite(x) && x >= 0 && x < 1) ||
        !["buy", "sell"].includes(input.side) || !input.assumptions?.trim() ||
        !Array.isArray(input.scenarios) || input.scenarios.length < 2 || input.scenarios.length > 5)
        throw new Error("Supply valid trade assumptions and two to five scenarios.");
    for (const s of input.scenarios) {
        if (!s.label?.trim() || !finite(s.exitPrice) || s.exitPrice <= 0 || !finite(s.fundingQuote) ||
            !finite(s.otherCostsQuote) || s.otherCostsQuote < 0 ||
            (s.probability !== null && (!finite(s.probability) || s.probability < 0 || s.probability > 1)))
            throw new Error("Invalid scenario prices, cash flows or probabilities.");
    }
    const weighted = input.scenarios.every(s => s.probability !== null);
    if ((!weighted && input.scenarios.some(s => s.probability !== null)) ||
        (weighted && Math.abs(input.scenarios.reduce((n, s) => n + s.probability!, 0) - 1) > 1e-6))
        throw new Error("Use probabilities totaling one, or null for every scenario. Do not invent missing probabilities.");
    const sign = input.side === "buy" ? 1 : -1;
    const notional = input.quantity * input.entryPrice;
    const entryFee = notional * input.entryFeeRate;
    const scenarios = input.scenarios.map(s => {
        const gross = sign * input.quantity * (s.exitPrice - input.entryPrice);
        const exitFee = input.quantity * s.exitPrice * input.exitFeeRate;
        const net = gross - entryFee - exitFee + s.fundingQuote - s.otherCostsQuote;
        const breakEvenExitPrice = (sign * notional + entryFee - s.fundingQuote + s.otherCostsQuote) /
            (input.quantity * (sign - input.exitFeeRate));
        return { ...s, grossPnlQuote: gross, entryFeeQuote: entryFee, exitFeeQuote: exitFee,
            netPnlQuote: net, netReturnBps: net / notional * 1e4,
            breakEvenExitPrice: breakEvenExitPrice > 0 ? breakEvenExitPrice : null };
    });
    if (!Number.isFinite(notional) || scenarios.some(s =>
        ![s.grossPnlQuote, s.entryFeeQuote, s.exitFeeQuote, s.netPnlQuote, s.netReturnBps].every(Number.isFinite)))
        throw new Error("Scenario arithmetic exceeds supported numeric range.");
    const best = Math.max(...scenarios.map(s => s.netPnlQuote)), worst = Math.min(...scenarios.map(s => s.netPnlQuote));
    const expected = weighted ? scenarios.reduce((n, s) => n + s.probability! * s.netPnlQuote, 0) : null;
    return {
        instrumentId: input.instrumentId, side: input.side, quantity: input.quantity, entryPrice: input.entryPrice,
        horizonHours: input.horizonHours, notionalQuote: notional, scenarios,
        expectedNetPnlQuote: expected,
        assessment: expected === null ? "probabilities_unestimated" : expected > 0 ? "positive_under_supplied_assumptions" : "nonpositive_under_supplied_assumptions",
        worstModeledLossQuote: Math.max(0, -worst),
        twoOutcomeBreakEvenWinProbability: best > 0 && worst < 0 ? -worst / (best - worst) : null,
        sensitivity: "Break-even probability assumes only the best and worst supplied outcomes. It is a threshold, not an estimated probability; omitted outcomes and tail losses can change it.",
        assumptions: input.assumptions, evidenceIds: input.evidenceIds,
        limitation: "Model-supplied scenarios, prices, fees and funding are not verified by this calculator. Executable entry/exit prices must already include spread and depth impact; include only additional costs in otherCostsQuote. Funding is a signed receipt (negative for payments). Positive modeled value does not authorize trading or establish collateral, stops, liquidity, or mandate compliance.",
    };
}

/** Isolate entry-price sensitivity. This is neither a fresh forecast nor a sized ticket. */
export function repriceScenarios(input: ScenarioAssessment, currentEntry: number | null) {
    if (currentEntry === null || !Number.isFinite(currentEntry) || currentEntry <= 0)
        return { status: "quote_unavailable", instruction: "No current-entry calculation is available. Do not describe supplied prices as freshly executable." };
    const original = assessScenarios(input);
    const repriced = assessScenarios({ ...input, entryPrice: currentEntry });
    return {
        status: "entry_sensitivity_only",
        entryPrice: currentEntry,
        entryChangeBps: (currentEntry / input.entryPrice - 1) * 10000,
        scenarios: repriced.scenarios.map((s, i) => ({
            label: s.label, exitPrice: s.exitPrice, netPnlQuote: s.netPnlQuote,
            changeFromSuppliedEntryQuote: s.netPnlQuote - original.scenarios[i].netPnlQuote,
        })),
        expectedNetPnlQuote: repriced.expectedNetPnlQuote,
        twoOutcomeBreakEvenWinProbability: repriced.twoOutcomeBreakEvenWinProbability,
        assumptionsHeldFixed: "Quantity, absolute exit levels, fee rates, absolute funding and other-cost amounts, horizon and supplied probabilities. Entry fee is recalculated. Percentage-based reserves, future funding, size impact and exit feasibility need separate review.",
        instruction: "Resolve any decision-relevant difference from the supplied-price calculation before using it to enter or pass. Retain fixed thesis levels unless new evidence changes them; do not move exits just to preserve the old payoff ratio. Top-of-book sensitivity is not a fill preview or a trade verdict. Unknown probabilities remain unknown.",
    };
}
