// @vitest-environment node
import { expect, it } from "vitest";
import { decodeTriage, isOpportunityTrigger, reusableTriage, triageLimits, type TriageCandidate, type TriageCheckpoint } from "@/lib/desk/review-admission";
const candidate: TriageCandidate = { instrumentId: "mainnet:perp:GRAM", nomination: "material_change", changes: [], previous: null,
    current: { observedAt: 1000, price: 1.25, return1hBps: 100, return4hBps: 200, fundingHourly: 0, oiChange1hPct: 0 } };
const checkpoint: TriageCheckpoint = { instrumentId: candidate.instrumentId, decision: "monitor", at: 1000, reviewedAt: 0,
    observed: candidate.current, reason: "No decision-sensitive change", nextEvidence: "A materially improved entry price" };
it("reuses a bounded triage verdict across restarts, but reopens changed price, observations and investigations", () => {
    expect(reusableTriage(JSON.parse(JSON.stringify(checkpoint)), candidate, 2000)).toBe(true);
    expect(reusableTriage(checkpoint, candidate, 1000 + triageLimits.deferMs)).toBe(false);
    expect(reusableTriage(checkpoint, { ...candidate, current: { ...candidate.current!, price: 1.23 } }, 2000)).toBe(false);
    expect(reusableTriage(checkpoint, { ...candidate, current: { ...candidate.current!, fundingHourly: .0001 } }, 2000)).toBe(false);
    expect(reusableTriage(checkpoint, { ...candidate, previous: { observed: null, reviewedAt: 1500 } }, 2000)).toBe(false);
    expect(reusableTriage(checkpoint, { ...candidate, current: null }, 2000)).toBe(false);
    expect(reusableTriage(checkpoint, { ...candidate, previous: { observed: null, reviewedAt: 0, summaryAt: 500 } }, 2000)).toBe(false);
});
it("never assigns urgent protection, actual fills, operator work or deadline reviews to opportunity triage", () => {
    for (const kind of ["risk", "correction", "operator", "scheduled", "follow_up", "missed_fill", "news"])
        expect(isOpportunityTrigger({ id: "w", kind, payload: {} })).toBe(false);
    expect(isOpportunityTrigger({ id: "w", kind: "fill", payload: { kind: "fill" } })).toBe(false);
    expect(isOpportunityTrigger({ id: "w", kind: "watch", payload: { condition: "deadline" } })).toBe(false);
    expect(isOpportunityTrigger({ id: "w", kind: "watch", payload: { condition: "depth_recovery" } })).toBe(true);
    expect(isOpportunityTrigger({ id: "w", kind: "market_move", priority: 10, payload: {} })).toBe(false);
});
it("rejects missing, repeated, invented and malformed candidate verdicts", () => {
    const verdict = { instrumentId: candidate.instrumentId, decision: "review", reason: "Price repairs the previous payoff concern", nextEvidence: "Check surviving structure and current costs" };
    expect(decodeTriage(JSON.stringify({ candidates: [verdict] }), [candidate])).toEqual([verdict]);
    for (const candidates of [[], [verdict, verdict], [{ ...verdict, instrumentId: "invented" }], [{ ...verdict, decision: "buy" }], [{ ...verdict, nextEvidence: "" }]])
        expect(() => decodeTriage(JSON.stringify({ candidates }), [candidate])).toThrow();
});
