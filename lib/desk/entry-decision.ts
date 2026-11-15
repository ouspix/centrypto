import { allocationReviewSchema, type AllocationReview } from "./allocation-review";
/** The trader chooses the entry test before observing its next result. */
export type EntryDecision = {
  mechanism: string;
  horizonHours: number;
  sufficientEvidence: string;
  thesisInvalidation: string;
  action: "enter" | "wait" | "research" | "pass";
  reason: string;
  confirmation: {
    condition: string;
    observationMinutes: number;
    horizonRelevance: string;
  } | null;
  uncertainty: string;
  nextAction: string;
  changeReason: string | null;
  /** Required for a new discretionary execution; legacy history stays readable. */
  allocation?: AllocationReview;
  /** Concise evidence record, not a score or an additional entry gate. */
  assessment?: {
    observations: Array<{ fact: string; evidenceId: string }>;
    competingExplanation: string;
    discriminatingEvidence: string;
    horizonRationale: string;
    decisionBoundary: string;
    alternativeExpression: string | null;
  };
};

const explanation = { type: "string", minLength: 10, maxLength: 800 };
export const entryDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "mechanism",
    "horizonHours",
    "sufficientEvidence",
    "thesisInvalidation",
    "action",
    "reason",
    "confirmation",
    "uncertainty",
    "nextAction",
    "changeReason",
  ],
  properties: {
    allocation: allocationReviewSchema,
    assessment: {
      type: "object", additionalProperties: false,
      required: ["observations", "competingExplanation", "discriminatingEvidence", "horizonRationale", "decisionBoundary", "alternativeExpression"],
      properties: {
        observations: { type: "array", minItems: 1, maxItems: 3, items: {
          type: "object", additionalProperties: false, required: ["fact", "evidenceId"],
          properties: { fact: explanation, evidenceId: { type: "string", minLength: 1, maxLength: 250 } },
        } },
        competingExplanation: explanation,
        discriminatingEvidence: explanation,
        horizonRationale: explanation,
        decisionBoundary: explanation,
        alternativeExpression: { type: ["string", "null"], minLength: 10, maxLength: 800 },
      },
    },
    mechanism: explanation,
    horizonHours: { type: "number", minimum: 2, maximum: 48 },
    sufficientEvidence: explanation,
    thesisInvalidation: explanation,
    action: { type: "string", enum: ["enter", "wait", "research", "pass"] },
    reason: explanation,
    confirmation: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["condition", "observationMinutes", "horizonRelevance"],
      properties: {
        condition: explanation,
        observationMinutes: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 2880,
        },
        horizonRelevance: explanation,
      },
    },
    uncertainty: explanation,
    nextAction: explanation,
    changeReason: { type: ["string", "null"], minLength: 10, maxLength: 800 },
  },
};

export function validateEntryDecisionChange(
  prior: EntryDecision | undefined,
  next: EntryDecision | undefined,
) {
  if (!prior || !next) return;
  const criteria = (p: EntryDecision) => [
    p.mechanism,
    p.horizonHours,
    p.sufficientEvidence,
    p.thesisInvalidation,
    p.confirmation,
  ];
  if (
    JSON.stringify(criteria(prior)) !== JSON.stringify(criteria(next)) &&
    (!next.changeReason || next.changeReason === prior.changeReason)
  ) {
    throw new Error(
      "Entry criteria changed. Record the new material evidence and why it changes the original test in decisionPlan.changeReason. A triggered threshold alone does not justify moving it.",
    );
  }
}

export function entryDecisionReview(plan?: EntryDecision) {
  if (!plan)
    return {
      status: "legacy_unstructured",
      instruction:
        "Record decisionPlan on the next substantive assessment. Existing ideas remain readable and closable.",
    };
  return {
    status: "recorded",
    action: plan.action,
    assessmentStatus: plan.assessment ? "recorded_not_verified" : "not_recorded",
    allocationStatus: plan.allocation ? "recorded_not_verified" : "required_before_new_discretionary_entry",
    observationFractionOfHorizon: plan.confirmation
      ? plan.confirmation.observationMinutes / (plan.horizonHours * 60)
      : null,
    instruction:
      "Assess the saved sufficientEvidence and thesisInvalidation separately. Assessment fields are model judgments, not verified facts or entry gates. Use their evidence references to challenge the decision, not their presence as proof of quality. Explain changes with material evidence. Short observation windows require the recorded horizonRelevance; this flag is descriptive and grants no entry authority.",
  };
}

/** Make repeated choices visible without penalizing repeated actions or forcing diversity. */
export function recentDecisionContext(proposals: Array<{
  key: string; updatedAt: string; decisionPlan?: EntryDecision;
}>) {
  const recent = proposals.filter(p => p.decisionPlan)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  return {
    scope: "recent_mode_scoped_proposals_not_independent_outcomes",
    decisions: recent.map(p => ({
      proposalKey: p.key, at: p.updatedAt,
      mechanism: p.decisionPlan!.mechanism, action: p.decisionPlan!.action,
      horizonHours: p.decisionPlan!.horizonHours, reason: p.decisionPlan!.reason,
      decisionBoundary: p.decisionPlan!.assessment?.decisionBoundary ?? null,
    })),
    instruction: "Prior decisions are hypotheses, not evidence for today's verdict. A repeated action can be correct. Check whether the present facts actually support reusing its horizon, failure level and payoff assumptions; do not change an action merely to look different. No trade quota or entry permission is implied.",
  };
}
