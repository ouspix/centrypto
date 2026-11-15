// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  validateEntryDecisionChange,
  recentDecisionContext,
  entryDecisionReview,
  type EntryDecision,
} from "@/lib/desk/entry-decision";
import {
  confirmationDecision,
  comparisonSummary,
  type EntryComparison,
} from "@/lib/desk/entry-comparison";
import { validateProposal } from "@/lib/desk/proposals";

const plan: EntryDecision = {
  mechanism: "Buying may persist over the next six hours",
  horizonHours: 6,
  sufficientEvidence: "Demand persists above the recorded recovery level",
  thesisInvalidation:
    "Loss of the prior range accompanied by sustained selling",
  action: "wait",
  reason: "Waiting tests whether the recovery survives a completed interval",
  confirmation: {
    condition: "Two completed five-minute closes above 100",
    observationMinutes: 10,
    horizonRelevance:
      "Test recovery retention after the observed selling impulse",
  },
  uncertainty: "The additional value of waiting is still unmeasured",
  nextAction: "Compare the original entry with the fixed confirmation rule",
  changeReason: null,
};
const step = 300000,
  start = Date.UTC(2026, 10, 11);
const comparison: EntryComparison = {
  proposalKey: "candidate",
  proposalRevision: 1,
  decisionPlan: plan,
  mode: "live",
  confirmation: { relation: "above", price: 100, closedBars: 2 },
  waitUntil: start + 12 * step,
  costAssumptions: "Explicit fee and slippage assumptions",
  baselineDecisions: [],
};
const bar = (at: number, close = 101) => ({
  at,
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
});

describe("persistent discretionary criteria", () => {
  it("exposes recent repeated decisions for review without making them a veto", () => {
    const proposals = Array.from({ length: 6 }, (_, i) => ({
      key: String(i), updatedAt: `2026-11-11T${10 + i}:00:00Z`,
      decisionPlan: { ...plan, action: "pass" as const },
    }));
    const context = recentDecisionContext(proposals);
    expect(context.decisions.map(p => p.proposalKey)).toEqual(["5", "4", "3", "2"]);
    expect(context.decisions.every(p => p.action === "pass")).toBe(true);
    expect(context.instruction).toContain("A repeated action can be correct");
    expect(proposals[0].key).toBe("0");
    expect(entryDecisionReview(plan).assessmentStatus).toBe("not_recorded");
  });
  it("requires fresh evidence when criteria move, while allowing an unchanged test to change its decision", () => {
    expect(() =>
      validateEntryDecisionChange(plan, { ...plan, action: "enter" }),
    ).not.toThrow();
    expect(() =>
      validateEntryDecisionChange(plan, {
        ...plan,
        sufficientEvidence: "Wait for another higher threshold",
      }),
    ).toThrow("Entry criteria changed");
    const changed = {
      ...plan,
      sufficientEvidence: "Wait for another higher threshold",
      changeReason: "New issuer evidence invalidates the old demand assumption",
    };
    expect(() => validateEntryDecisionChange(plan, changed)).not.toThrow();
    expect(() =>
      validateEntryDecisionChange(changed, { ...changed, horizonHours: 12 }),
    ).toThrow("Entry criteria changed");
    expect(() => validateEntryDecisionChange(undefined, plan)).not.toThrow();
  });
  it("rejects unresolved research decisions without a task and validates plan fields", () => {
    const draft = {
      key: "candidate",
      expectedRevision: 0,
      status: "parked",
      thesis: plan.mechanism,
      horizon: "Six hours",
      invalidation: plan.thesisInvalidation,
      missingEvidence: [],
      evidenceIds: [],
      legs: [
        {
          instrumentId: "mainnet:perp:SOL",
          side: "buy",
          quantity: null,
          entryPrice: null,
        },
      ],
      economics: "Continuation payoff remains uncertain",
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      researchPlan: [],
      decisionPlan: plan,
    };
    expect(() => validateProposal(draft, "lead")).not.toThrow();
    expect(() =>
      validateProposal(
        { ...draft, decisionPlan: { ...plan, action: "research" } },
        "lead",
      ),
    ).toThrow("researchPlan");
    expect(() =>
      validateProposal(
        { ...draft, decisionPlan: { ...plan, horizonHours: -1 } },
        "lead",
      ),
    ).toThrow("Invalid trade proposal");
  });
});

describe("forward confirmation comparison", () => {
  it("uses only complete post-registration bars and schedules entry after observation", () => {
    const bars = [
      bar(start),
      bar(start + step),
      bar(start + 2 * step),
      bar(start + 3 * step, 1),
    ];
    const d = confirmationDecision(
      comparison,
      bars,
      step,
      start + 3 * step + 5000,
      start + 1000,
      "SOL",
      1,
    )!;
    expect(d).toMatchObject({
      signalClosedAt: start + 3 * step,
      entryAt: start + 4 * step,
      direction: 1,
    });
    expect(d.decidedAt).toBeLessThan(d.entryAt);
    expect(
      confirmationDecision(
        comparison,
        bars,
        step,
        start + 2 * step + 5000,
        start + 1000,
        "SOL",
        1,
      ),
    ).toBeNull();
  });
  it("does not reconstruct a missed trigger, bridge gaps or use a partial confirming sequence", () => {
    const bars = [bar(start), bar(start + step), bar(start + 2 * step)];
    expect(
      confirmationDecision(
        comparison,
        bars,
        step,
        start + 3 * step + 90001,
        start,
        "SOL",
        1,
      ),
    ).toBeNull();
    expect(
      confirmationDecision(
        comparison,
        [bars[0], bars[2]],
        step,
        start + 3 * step + 5000,
        start,
        "SOL",
        1,
      ),
    ).toBeNull();
    expect(
      confirmationDecision(
        comparison,
        [...bars.slice(0, 2), bar(start + 2 * step, 99)],
        step,
        start + 3 * step + 5000,
        start,
        "SOL",
        1,
      ),
    ).toBeNull();
    expect(
      confirmationDecision(
        comparison,
        bars,
        step,
        comparison.waitUntil + 1,
        start,
        "SOL",
        1,
      ),
    ).toBeNull();
  });
  it("supports downside confirmation and withholds comparative conclusions for missed observations or data gaps", () => {
    const short = {
      ...comparison,
      confirmation: { ...comparison.confirmation, relation: "below" as const },
    };
    expect(
      confirmationDecision(
        short,
        [bar(start, 99), bar(start + step, 98)],
        step,
        start + 2 * step + 5000,
        start,
        "SOL",
        -1,
      )?.direction,
    ).toBe(-1);
    const result = {
      metrics: { netPnlUsd: 2, closedTrades: 1 },
      dataQuality: { usableForSelection: true },
      trades: [],
    } as any;
    const c = { ...comparison, baselineResult: result };
    const delayed = { ...result, metrics: { netPnlUsd: 0, closedTrades: 0 } };
    expect(comparisonSummary(c, delayed, true, 0, true)).toMatchObject({
      comparable: true,
      waitingMinusImmediateUsd: -2,
    });
    expect(
      comparisonSummary(c, delayed, true, 1, true).waitingMinusImmediateUsd,
    ).toBeNull();
    expect(
      comparisonSummary(c, delayed, true, 0, false).waitingMinusImmediateUsd,
    ).toBeNull();
    expect(
      comparisonSummary(c, delayed, false, 0, true).waitingMinusImmediateUsd,
    ).toBeNull();
  });
});
