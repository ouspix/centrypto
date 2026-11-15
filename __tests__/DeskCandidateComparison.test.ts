// @vitest-environment node
import { expect, it } from "vitest";
import { comparisonSlate, reviewCandidateComparison } from "@/lib/desk/candidate-comparison";
const candidate = (id: string) => ({ instrumentId: id });
it("diversifies across overlapping lanes before filling the slate without treating it as alpha", () => {
    const slate = comparisonSlate([
        { family: "pullback", candidates: [candidate("A"), candidate("B")] },
        { family: "breakout", candidates: [candidate("A"), candidate("C")] },
        { family: "reversal", candidates: [candidate("C"), candidate("D")] },
    ], [candidate("E")]);
    expect(slate.candidates.map(c => c.instrumentId)).toEqual(["A", "C", "D"]);
    expect(comparisonSlate([], [candidate("A"), candidate("A")]).candidates).toHaveLength(1);
    expect(comparisonSlate([], []).candidates).toEqual([]);
});
const comparison = () => ({ candidates: ["A", "B", "C"].map(instrumentId => ({ instrumentId,
    mechanism: "Independent hypothesis", stage: "investigated" as const, evidenceIds: ["observed-history"],
    support: "Observed retained recovery", objection: "Measured adverse funding", disposition: "pass", nextStep: "No new commitment justified" })),
    preferredInstrumentId: null, relativeReason: "The strongest candidate has unresolved economics", coverageReason: null as string | null });
it("allows every investigated candidate to pass without imposing trading or positive expectancy", () => {
    expect(reviewCandidateComparison(comparison())).toMatchObject({ investigated: 3, coverage: "compared" });
});
it("does not count screen-only or duplicated names as completed breadth and allows honest limited coverage", () => {
    const c = comparison();
    expect(() => reviewCandidateComparison({ ...c, candidates: [c.candidates[0], c.candidates[0]] })).toThrow("distinct");
    expect(() => reviewCandidateComparison({ ...c, preferredInstrumentId: "D" })).toThrow("Preferred");
    const limited = { ...c, candidates: c.candidates.map(r => ({ ...r, stage: "screen_only" as const })) };
    expect(() => reviewCandidateComparison(limited)).toThrow("coverageReason");
    expect(reviewCandidateComparison({ ...limited, coverageReason: "Current position protection consumed this review" })).toMatchObject({ investigated: 0, screenedOnly: 3, coverage: "limited_with_reason" });
});
