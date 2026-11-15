import type { AllocationReview } from "@/lib/desk/allocation-review";
import type { DeskOrder } from "@/lib/desk/execution-types";
import type { TradeProposal } from "@/lib/desk/proposals";

export function allocationReview(): AllocationReview {
    return {
        version: "allocation-1",
        payoff: {
            continuation: { netReturnBps: 45, basis: "Conditional prior range recovery after explicit costs, not a forecast." },
            stagnation: { netReturnBps: -10, basis: "Unchanged price loses the round-trip fee and walking allowance." },
            failure: { netReturnBps: -80, basis: "Observed failed recovery level with costs; gaps remain possible." },
            costs: "Round-trip fees 9bps plus 1bp walking; funding assumed zero, not guaranteed.",
            extensionRequired: false, extensionEvidence: null,
            preferenceOverCash: "Repeated recovery after a specific supply change supports the range repair despite larger failure sensitivity; uncertain magnitude remains explicit.",
            evidenceIds: ["history:fixture"],
        },
        eventRisk: { status: "none_identified", events: [], action: "enter_as_sized",
            rationale: "Current dated calendar has no identified material release within this two-hour window; unscheduled risk remains.",
            maxNotionalUsd: null, exitBefore: null, evidenceIds: ["calendar:fixture"] },
        theme: { family: "recovery", driver: "Broad market recovery after inventory reduction",
            correlatedInstrumentIds: [], jointDownside: "Flat owned book; this single recovery can fail with the broader market and gap through its stop.",
            marginalCase: "This entry adds recovery exposure from cash; prior observed outcomes do not establish independent alpha.", evidenceIds: ["allocation-context:fixture"] },
    };
}

export function reviewedProposal(order: DeskOrder): TradeProposal {
    return { key: order.proposalKey!, revision: 1, status: "candidate", thesis: "Bounded recovery following a retained repricing",
        horizon: "Two hours from a confirmed fill", invalidation: "Failed retention returns price through the prior base",
        missingEvidence: [], evidenceIds: ["history:fixture"], legs: [{ instrumentId: order.instrumentId, side: order.side, quantity: order.quantity, entryPrice: order.limitPrice }],
        economics: "Conditional scenario analysis, no estimated probabilities or reward/risk admission rule",
        validUntil: order.entryExpiresAt!, researchPlan: [], updatedBy: "lead", updatedAt: new Date().toISOString(), sourceShiftId: "fixture",
        setup: { strategyVersion: "desk-discretionary-1", entryCondition: "Retained repricing with current executable price", stopPrice: order.stopPrice!, targetPrice: order.takeProfitPrice ?? null,
            holdHours: order.maxHoldHours!, riskBudgetUsd: 6, entryExpiresAt: order.entryExpiresAt!, backtestRunIds: [] },
        decisionPlan: { mechanism: "Retained repricing after a supply change", horizonHours: order.maxHoldHours!, sufficientEvidence: "Completed retention and current executable quote agree",
            thesisInvalidation: "Failed retention through the original base", action: "enter", reason: "Specific remaining range repair outweighs the common failure case within the selected horizon",
            confirmation: null, uncertainty: "Future participation and payoff magnitude remain uncertain", nextAction: "Preview the exact bounded ticket and verify the host receipt", changeReason: null,
            allocation: allocationReview() } };
}
