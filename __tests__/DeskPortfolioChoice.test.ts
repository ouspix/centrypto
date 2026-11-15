// @vitest-environment node
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { comparePortfolioScenarios, portfolioChoiceSchema, portfolioScenarioSchema, reviewPortfolioChoice, holdingPriceSensitivity, type PortfolioChoice, type PortfolioQuote, type PortfolioScenarioInput } from "@/lib/desk/portfolio-choice";
import { reconcilePriceEvidence } from "@/lib/desk/price-evidence";
const now = Date.parse("2026-11-12T18:00Z");
const quote = (bid = 99, ask = 101): PortfolioQuote => ({ bid, ask, time: now, bids: [{ px: String(bid), sz: "100" }], asks: [{ px: String(ask), sz: "100" }] });
const input = (): PortfolioScenarioInput => ({ holdingInstrumentId: "mainnet:perp:A", candidateInstrumentId: "mainnet:perp:B", candidateSide: "buy", candidateQuantity: 2,
    horizonHours: 1, assumptions: "Conditional executable exit levels, no probabilities estimated", evidenceIds: ["observed-book"],
    scenarios: [110, 90].map((holdingExitPrice, i) => ({ label: i ? "Adverse continuation" : "Favorable continuation", basis: "Conditional price sensitivity only",
        holdingExitPrice, holdingFundingUsd: 0, holdingOtherCostsUsd: 0, candidateExitPrice: i ? 40 : 60,
        candidateFundingUsd: 0, candidateOtherCostsUsd: 0, probability: null })) });
const alternative = () => ({ available: true, caseFor: "Specific observed support", caseAgainst: "Specific adverse evidence", costs: "Conditional two-sided costs", uncertainty: "Return probabilities unknown", evidenceIds: ["snapshot"] });
export const allocation = (): PortfolioChoice => ({ holdingInstrumentId: "mainnet:perp:A", candidateInstrumentId: null, horizonHours: .25,
    priceEvidenceId: null, priceClaims: [], forwardCase: { advantageOverCash: "Conditional demand advantage after costs", evidenceWeighting: "Support outweighs contrary evidence under the stated assumption", remainingTimeCase: "Demand mechanism can resolve before original exit", assumptionAtRisk: "Continued demand remains uncertain; reassess if current support is lost" },
    valuationBasis: "Forward value from current executable prices, prior loss excluded", hold: alternative(), exitToCash: alternative(),
    rotate: { ...alternative(), available: false, evidenceIds: [], caseAgainst: "No credible replacement in this focused review" },
    livePriceReconciliation: "Live quote below previous completed recovery; thesis weakened, not ignored", choice: "hold",
    reason: "Remaining thesis and incremental costs favor current holding under stated uncertainty", changeCondition: "A current loss of the specified recovery base changes the assessment" });

describe("equal forward portfolio arithmetic", () => {
    it("accepts concise cost explanations but rejects blank costs and zero horizons", () => {
        const validate = new Ajv({strict:false}).compile(portfolioChoiceSchema), a=allocation();
        a.hold.costs="None";expect(validate(a)).toBe(true);
        a.hold.costs=" ";expect(validate(a)).toBe(false);
        a.hold.costs="None";a.horizonHours=0;expect(validate(a)).toBe(false);
    });
    it("accepts ordinary short scenario labels while retaining explanation and numeric validation", () => {
        const validate = new Ajv({ strict: false }).compile(portfolioScenarioSchema);
        const a = input(); a.scenarios[0].label = "Stop"; a.scenarios[1].label = "Extension";
        expect(validate(a)).toBe(true);
        for (const label of ["", "   ", "x".repeat(101)]) {
            expect(validate({ ...a, scenarios: [{ ...a.scenarios[0], label }, a.scenarios[1]] })).toBe(false);
        }
        expect(validate({ ...a, assumptions: "" })).toBe(false);
        expect(validate({ ...a, scenarios: [{ ...a.scenarios[0], holdingExitPrice: -1 }, a.scenarios[1]] })).toBe(false);
    });
    it("rejects the actual GRASS arithmetic error without selecting an allocation", () => {
        const a = allocation(); a.priceEvidenceId = "observed-quote"; a.priceClaims = [{ referencePrice: .45356, liveRelation: "above" }];
        const facts = { instrumentId: a.holdingInstrumentId, bid: .45319, ask: .45350, time: now };
        expect(() => reviewPortfolioChoice(a, facts)).toThrow("live is below 0.45356");
        a.priceClaims[0].liveRelation = "below";
        expect(reviewPortfolioChoice(a, facts)).toMatchObject({ recorded: true, executionAuthorized: false, checkedPrices: [{ liveRelation: "below", bid: .45319 }] });
        expect(() => reviewPortfolioChoice(a)).toThrow("current price evidence");
        expect(() => reviewPortfolioChoice(a, { ...facts, instrumentId: "different" })).toThrow("another instrument");
    });
    it("exposes forward sensitivity for longs and shorts without inventing fees or a winner", () => {
        const r = holdingPriceSensitivity({ quantity: 694.4, stopPrice: .4443, targetPrice: .4583 }, { bid: .45319, ask: .45350 });
        expect(r.grossToStopUsd).toBeCloseTo(-6.173216); expect(r.grossToTargetUsd).toBeCloseTo(3.548384);
        expect(r.costs).toContain("not included"); expect(r).not.toHaveProperty("choice");
        expect(holdingPriceSensitivity({ quantity: -2, stopPrice: 110, targetPrice: 90 }, { bid: 99, ask: 101 })).toMatchObject({ currentExitSidePrice: 101, grossToStopUsd: -18, grossToTargetUsd: 22 });
    });
    it("charges closing and replacement costs once and excludes past entry losses", () => {
        const r = comparePortfolioScenarios(input(), 1, quote(), quote(49, 51), .001, now);
        expect(r.status).toBe("conditional_sensitivity_only");
        expect(r).toMatchObject({ executionAuthorized: false, expected: null, baseline: { currentHoldingMid: 100, priorEntryAndPaidFeesExcluded: true } });
        if (!r.outcomes) throw new Error("Missing outcomes");
        expect(r.outcomes[0].holdUsd).toBeCloseTo(9.89);
        expect(r.outcomes[0].exitToCashUsd).toBeCloseTo(-1.099);
        expect(r.outcomes[0].rotateUsd).toBeCloseTo(16.679);
        expect(r.outcomes[1].holdUsd).toBeCloseTo(-10.09);
        expect(r.outcomes[1].rotateUsd).toBeCloseTo(-23.281);
    });
    it("uses buy-to-close for short holdings and correct short replacement cashflows", () => {
        const a = input(); a.candidateSide = "sell";
        const r = comparePortfolioScenarios(a, -1, quote(), quote(49, 51), .001, now);
        if (!r.outcomes) throw new Error("Missing outcomes");
        expect(r.outcomes[1].holdUsd).toBeCloseTo(9.91);
        expect(r.outcomes[1].exitToCashUsd).toBeCloseTo(-1.101);
        expect(r.outcomes[1].rotateUsd).toBeCloseTo(16.721);
    });
    it("walks depth and leaves missing depth unknown rather than assuming a fill", () => {
        const q = quote(); q.bids = [{ px: "99", sz: ".5" }, { px: "98", sz: ".5" }];
        expect(comparePortfolioScenarios(input(), 1, q, quote(49, 51), 0, now)).toMatchObject({ currentCosts: { exitVwap: 98.5 } });
        q.bids = [{ px: "99", sz: ".5" }];
        const r = comparePortfolioScenarios(input(), 1, q, quote(49, 51), 0, now);
        if (!r.outcomes) throw new Error("Missing outcomes");
        expect(r.outcomes[0]).toMatchObject({ exitToCashUsd: null, rotateUsd: null, holdUsd: 10 });
    });
    it("allows no candidate, unknown probabilities and signed funding without selecting a winner", () => {
        const a = input(); a.candidateInstrumentId = a.candidateSide = a.candidateQuantity = null;
        a.scenarios = a.scenarios.map(s => ({ ...s, holdingFundingUsd: -2, holdingOtherCostsUsd: 1, candidateExitPrice: null, candidateFundingUsd: null, candidateOtherCostsUsd: null }));
        const r = comparePortfolioScenarios(a, 1, quote(), null, 0, now);
        expect(r).toMatchObject({ expected: null, outcomes: [{ holdUsd: 7, rotateUsd: null }, { holdUsd: -13, rotateUsd: null }] });
        expect(r).not.toHaveProperty("choice");
    });
    it("does not manufacture fees, probabilities or quote freshness", () => {
        expect(comparePortfolioScenarios(input(), 1, quote(), quote(), null, now)).toMatchObject({ status: "costs_unavailable" });
        expect(() => comparePortfolioScenarios(input(), 1, { ...quote(), time: now - 5001 }, quote(), 0, now)).toThrow("fresh");
        const a = input(); a.scenarios[0].probability = .5;
        expect(() => comparePortfolioScenarios(a, 1, quote(), quote(), 0, now)).toThrow("Probabilities");
        a.scenarios[1].probability = .5;
        expect(comparePortfolioScenarios(a, 1, quote(), quote(), 0, now)).toMatchObject({ expected: { holdUsd: 0 } });
    });
    it.each(["hold", "exit_to_cash", "unresolved"] as const)("records %s without requiring rotation or an order", choice => {
        const a = { ...allocation(), choice };
        expect(new Ajv({ strict: false }).compile(portfolioChoiceSchema)(a)).toBe(true);
        expect(reviewPortfolioChoice(a)).toMatchObject({ recorded: true, executionAuthorized: false });
    });
    it("does not label an unavailable or same-instrument choice a valid rotation", () => {
        expect(() => reviewPortfolioChoice({ ...allocation(), choice: "rotate" })).toThrow("unavailable");
        expect(() => reviewPortfolioChoice({ ...allocation(), candidateInstrumentId: "mainnet:perp:A" })).toThrow("distinct");
    });
    it("still requires evidence for every available alternative", () => {
        const a = allocation(); a.hold.evidenceIds = [];
        expect(() => reviewPortfolioChoice(a)).toThrow("Cite observed evidence");
    });
});
describe("closed candles and live price evidence", () => {
    it("computes all three referenced closes against the same live spread", () => {
        const closes = [.45234, .45356, .45420].map((c, i) => ({ t: now - (3-i)*60000, T: now - (3-i)*60000 + 59999, c: String(c), h: String(c), l: String(c) }));
        const r = reconcilePriceEvidence(closes, now, { bid: .45319, ask: .45350, time: now }, [], now);
        expect(r.recentCompletedRelations.map(x => x.liveSide)).toEqual(["above", "below", "below"]);
    });
    const rows = [{ t: now - 900000, T: now - 1, c: "105", l: "101", h: "106" }, { t: now, T: now + 899999, c: "99", l: "98", h: "105" }];
    it("exposes the MON-style disagreement without selecting the winner", () => {
        const r = reconcilePriceEvidence(rows, now, { bid: 99, ask: 99.1, time: now }, [{ label: "Saved recovery", price: 100 }], now);
        expect(r.lastCompleted?.close).toBe(105);
        expect(r.forming).toMatchObject({ final: false, close: 99, low: 98 });
        expect(r.levels[0]).toMatchObject({ completedSide: "above", liveSide: "below", oppositeSides: true });
        expect(r.live.bidVsCompletedBps).toBeCloseTo((99 / 105 - 1) * 10000);
    });
    it("marks a straddling spread and stale quote honestly, retaining closed/forming timestamps", () => {
        const r = reconcilePriceEvidence(rows, now, { bid: 99, ask: 101, time: now }, [{ label: "Threshold", price: 100 }], now);
        expect(r.levels[0]).toMatchObject({ liveSide: "touching_or_straddling", oppositeSides: false });
        const stale = reconcilePriceEvidence(rows, now, { bid: 99, ask: 99.1, time: now - 6000 }, [{ label: "Threshold", price: 100 }], now);
        expect(stale.live).toMatchObject({ status: "unavailable", bid: null });
        expect(stale.levels[0].liveSide).toBeNull();
    });
    it("never promotes a formerly forming bar to completed just because a cached snapshot aged", () => {
        const r = reconcilePriceEvidence(rows, now - 10, { bid: 99, ask: 100, time: now + 10 }, [], now + 10);
        expect(r.lastCompleted).toBeNull();
        expect(r.forming?.close).toBe(105);
    });
});


it("accepts a seven-level journal while still rejecting incorrect price claims", () => {
    const a = allocation(); a.priceEvidenceId = "quote";
    a.priceClaims = Array.from({ length: 7 }, (_, i) => ({ referencePrice: 90 + i, liveRelation: "above" as const }));
    const validate = new Ajv({ strict: false }).compile(portfolioChoiceSchema);
    expect(validate(a)).toBe(true);
    const facts = { instrumentId: a.holdingInstrumentId, bid: 99, ask: 101, time: now };
    expect(reviewPortfolioChoice(a, facts).checkedPrices).toHaveLength(7);
    a.priceClaims[6].referencePrice = 102;
    expect(() => reviewPortfolioChoice(a, facts)).toThrow("contradicts");
    expect(validate({ ...a, priceClaims: Array(17).fill(a.priceClaims[0]) })).toBe(false);
});
