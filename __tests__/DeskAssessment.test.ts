// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assessScenarios, repriceScenarios, type ScenarioAssessment } from "@/lib/desk/assessment";
import { roleInstructions } from "@/lib/desk/roles";

const trade = (overrides: Partial<ScenarioAssessment> = {}): ScenarioAssessment => ({
    instrumentId: "mainnet:perp:SOL", side: "buy", quantity: 2, entryPrice: 100,
    entryFeeRate: 0.001, exitFeeRate: 0.001, horizonHours: 6,
    assumptions: "Hypothetical executable exits; probabilities unestimated; funding zero for sensitivity, not a forecast.",
    evidenceIds: [], scenarios: [
        { label: "upside", exitPrice: 110, probability: null, fundingQuote: 0, otherCostsQuote: 0 },
        { label: "downside", exitPrice: 95, probability: null, fundingQuote: 0, otherCostsQuote: 0 },
    ], ...overrides,
});

describe("trade scenario assessment", () => {
    it("reprices both directions without moving exits, inventing probabilities or approving a trade", () => {
        for (const side of ["buy", "sell"] as const) {
            const input = trade({ side });
            const snapshot = JSON.stringify(input);
            const better = repriceScenarios(input, side === "buy" ? 98 : 102);
            expect(better.status).toBe("entry_sensitivity_only");
            expect(better.expectedNetPnlQuote).toBeNull();
            expect(better.scenarios!.map(s => s.exitPrice)).toEqual([110, 95]);
            expect(better.scenarios!.every(s => s.changeFromSuppliedEntryQuote > 0)).toBe(true);
            const worse = repriceScenarios(input, side === "buy" ? 102 : 98);
            expect(worse.scenarios!.every(s => s.changeFromSuppliedEntryQuote < 0)).toBe(true);
            expect(JSON.stringify(input)).toBe(snapshot);
        }
        expect(repriceScenarios(trade(), null).status).toBe("quote_unavailable");
        expect(repriceScenarios(trade(), NaN).status).toBe("quote_unavailable");
    });
    it("reveals when a changed quote reverses modeled economics while preserving supplied weights", () => {
        const input = trade({ scenarios: trade().scenarios.map(s => ({ ...s, probability: 0.5 })) });
        expect(assessScenarios(input).expectedNetPnlQuote).toBeGreaterThan(0);
        const repriced = repriceScenarios(input, 105);
        expect(repriced.expectedNetPnlQuote).toBeLessThan(0);
        expect(repriced.scenarios![0].netPnlQuote).toBeCloseTo(9.57);
        expect(repriced.instruction).toContain("not a fill preview or a trade verdict");
    });
    it("reports fee-adjusted outcomes and a threshold without inventing probabilities", () => {
        const result = assessScenarios(trade());
        expect(result.expectedNetPnlQuote).toBeNull();
        expect(result.assessment).toBe("probabilities_unestimated");
        expect(result.scenarios[0].netPnlQuote).toBeCloseTo(19.58);
        expect(result.scenarios[1].netPnlQuote).toBeCloseTo(-10.39);
        expect(result.twoOutcomeBreakEvenWinProbability).toBeCloseTo(10.39 / 29.97);
        expect(result.scenarios[0].breakEvenExitPrice).toBeCloseTo(100.1 / 0.999);
    });
    it("can support a directional trade despite negative immediate roundtrip and funding-only returns", () => {
        const base = trade();
        const result = assessScenarios(trade({ scenarios: base.scenarios.map((s, i) => ({ ...s, probability: i ? 0.4 : 0.6, fundingQuote: -0.3 })) }));
        expect(result.expectedNetPnlQuote).toBeCloseTo(7.292);
        expect(result.assessment).toBe("positive_under_supplied_assumptions");
        expect(result.limitation).toContain("does not authorize trading");
    });
    it("prices shorts, signed funding and extra costs, with true break-even exit fees", () => {
        const base = trade({ side: "sell" });
        const input = { ...base, scenarios: base.scenarios.map(s => ({ ...s, fundingQuote: 0.5, otherCostsQuote: 0.1 })) };
        const result = assessScenarios(input);
        expect(result.scenarios[0].netPnlQuote).toBeCloseTo(-20.02);
        expect(result.scenarios[1].netPnlQuote).toBeCloseTo(10.01);
        const atBreakEven = assessScenarios({ ...input, scenarios: input.scenarios.map((s, i) => ({ ...s, exitPrice: result.scenarios[i].breakEvenExitPrice! })) });
        expect(atBreakEven.scenarios[0].netPnlQuote).toBeCloseTo(0);
    });
    it("rejects incomplete weights, fabricated zero-cost placeholders and invalid quantities", () => {
        const base = trade();
        expect(() => assessScenarios(trade({ scenarios: base.scenarios.map((s, i) => ({ ...s, probability: i ? null : 0.6 })) }))).toThrow(/probabilities/);
        expect(() => assessScenarios(trade({ scenarios: base.scenarios.map(s => ({ ...s, probability: 0.4 })) }))).toThrow(/probabilities/);
        expect(() => assessScenarios(trade({ entryFeeRate: null as unknown as number }))).toThrow(/valid trade/);
        for (const quantity of [0, -1, NaN, Infinity]) expect(() => assessScenarios(trade({ quantity }))).toThrow();
        expect(() => assessScenarios(trade({ quantity: 1e308 }))).toThrow(/numeric range/);
    });
    it("handles all-positive and all-negative scenarios without misleading binary thresholds", () => {
        const input = trade();
        for (const exitPrice of [90, 120]) {
            const result = assessScenarios(trade({ scenarios: input.scenarios.map(s => ({ ...s, exitPrice, probability: 0.5 })) }));
            expect(result.twoOutcomeBreakEvenWinProbability).toBeNull();
            expect(result.expectedNetPnlQuote! > 0).toBe(exitPrice === 120);
        }
    });
    it("asks the lead to assess the strongest candidate and retains live-only authority", () => {
        const lead = roleInstructions("lead", { live: true, consult: false });
        expect(lead).toContain("rather than counting votes");
        expect(lead).toContain("assess_trade_scenarios");
        expect(lead).toContain("use a small real order merely to learn");
        expect(roleInstructions("lead", { live: false, consult: false })).toContain("Only the live lead can authorize orders");
    });
});
