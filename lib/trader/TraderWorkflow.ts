import { RiskCheckModule } from "@/lib/risk/RiskCheckModule";
import { StateSnapshot } from "@/types/snapshot";
import {
    CandidateJournalStatus,
    EligibleCandidate,
    RiskAssessment,
    TradeDecision,
    TraderContext,
    TraderDecision,
    TraderReasonCode
} from "@/types/trading";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { canonicalPlaybookForCandidate } from "@/lib/trader/playbook-utils";

export interface TraderDecisionProvider {
    decide(context: TraderContext): Promise<TraderDecision[]>;
}

export type WorkflowRiskResult = {
    riskAssessments: RiskAssessment[];
    approvedDecisions: TradeDecision[];
};

export class MainAppDeterministicProvider implements TraderDecisionProvider {
    private readonly reducedDuringBias = new Set<string>();

    constructor(private readonly config: AgentConfig = DEFAULT_AGENT_CONFIG) {}

    public async decide(context: TraderContext): Promise<TraderDecision[]> {
        const decisions: TraderDecision[] = [];

        for (const position of context.existing_positions) {
            decisions.push(this.managePosition(position));
        }

        const maxNewTrades = Math.max(0, context.max_new_trades_allowed ?? context.eligible_candidates.length);
        const candidates = [...context.eligible_candidates].sort(compareCandidatesForDeterministicEntry).slice(0, maxNewTrades);
        for (const candidate of candidates) {
            if (candidate.sizing.suggested_size_fraction <= 0) continue;
            decisions.push(this.openCandidate(candidate));
        }

        return decisions;
    }

    private managePosition(position: TraderContext["existing_positions"][number]): TraderDecision {
        const positionKey = deterministicPositionKey(position);
        const profitable = position.unrealized_pnl_usd > 0;
        if (position.management_bias === "CLOSE") {
            if (!profitable) {
                return this.holdPosition(position);
            }
            this.reducedDuringBias.delete(positionKey);
            return {
                scope: "position",
                action: "CLOSE_POSITION",
                candidate_id: null,
                symbol: position.symbol,
                target_side: "flat",
                target_size_fraction_of_equity: 0,
                playbook: null,
                confidence: this.config.management_policy.close_confidence,
                reason_code: "position_management",
                notes: deterministicPositionNotes(position, "close")
            };
        }

        if (position.management_bias === "REDUCE") {
            if (!profitable) {
                return this.holdPosition(position);
            }
            if (this.reducedDuringBias.has(positionKey)) {
                return this.holdPosition(position);
            }
            this.reducedDuringBias.add(positionKey);
            return {
                scope: "position",
                action: "REDUCE_POSITION",
                candidate_id: null,
                symbol: position.symbol,
                target_side: position.side,
                target_size_fraction_of_equity: parseFloat((position.exposure_fraction * 0.5).toFixed(6)),
                playbook: null,
                confidence: this.config.management_policy.close_confidence,
                reason_code: "risk_reduction",
                notes: deterministicPositionNotes(position, "reduce")
            };
        }

        return this.holdPosition(position);
    }

    private holdPosition(position: TraderContext["existing_positions"][number]): TraderDecision {
        return {
            scope: "position",
            action: "HOLD_POSITION",
            candidate_id: null,
            symbol: position.symbol,
            target_side: position.side,
            target_size_fraction_of_equity: position.exposure_fraction,
            playbook: null,
            confidence: this.config.management_policy.hold_confidence,
            reason_code: "position_management",
            notes: deterministicPositionNotes(position, "hold")
        };
    }

    private openCandidate(candidate: EligibleCandidate): TraderDecision {
        const playbook = candidate.eligible_playbooks[0];
        return {
            scope: "candidate",
            action: "OPEN_POSITION",
            candidate_id: candidate.candidate_id,
            symbol: candidate.symbol,
            target_side: candidate.side,
            target_size_fraction_of_equity: candidate.sizing.suggested_size_fraction,
            playbook,
            confidence: deterministicCandidateConfidence(candidate),
            reason_code: reasonCodeForPlaybook(playbook),
            notes: deterministicCandidateNotes(candidate)
        };
    }
}

export function buildBackendDecisions(
    traderDecisions: TraderDecision[],
    context: TraderContext,
    validatorReason: string
): TradeDecision[] {
    return traderDecisions.map(decision => {
        if (decision.scope === "candidate") {
            const candidate = context.eligible_candidates.find(c => c.candidate_id === decision.candidate_id);
            const side = decision.target_side === "flat" ? null : decision.target_side;
            const playbook = candidate && side
                ? canonicalPlaybookForCandidate(decision.playbook, candidate.eligible_playbooks, side) ?? decision.playbook
                : decision.playbook;

            return {
                scope: decision.scope,
                candidate_id: decision.candidate_id,
                action: decision.action,
                symbol: decision.symbol || candidate?.symbol || null,
                side,
                target_side: decision.target_side,
                target_size_fraction_of_equity: decision.target_size_fraction_of_equity,
                size_fraction_of_equity: decision.target_size_fraction_of_equity,
                risk_plan: decision.action === "OPEN_POSITION" && candidate ? {
                    stop_loss_pct: candidate.risk.stop_loss_pct,
                    take_profit_pct_primary: candidate.risk.take_profit_pct_primary
                } : null,
                playbook: playbook || candidate?.eligible_playbooks[0] || "none",
                confidence: decision.confidence,
                reason_code: decision.reason_code,
                notes: decision.notes,
                audit: candidate ? {
                    candidate_id: candidate.candidate_id,
                    cost_bps: candidate.market_quality.cost_bps,
                    edge_bps: candidate.market_quality.edge_bps,
                    book_pressure: candidate.market_quality.book_pressure,
                    depth_usd: candidate.market_quality.min_depth_usd,
                    vol_ratio_5m_vs_1h: candidate.market_quality.vol_ratio_5m_vs_1h,
                    ret_sigma_5m_vs_1h: candidate.market_quality.ret_sigma_5m_vs_1h,
                    computed_stop_loss_pct: candidate.risk.stop_loss_pct,
                    computed_take_profit_pct_primary: candidate.risk.take_profit_pct_primary,
                    computed_size_fraction_of_equity: decision.target_size_fraction_of_equity,
                    max_allowed_size_fraction: candidate.sizing.max_allowed_size_fraction,
                    suggested_size_fraction: candidate.sizing.suggested_size_fraction,
                    validator_status: validatorReason === "accepted" ? "accepted" : "rejected",
                    validator_reason: validatorReason
                } : {
                    validator_status: "rejected",
                    validator_reason: validatorReason
                }
            };
        }

        const position = context.existing_positions.find(p => p.symbol === decision.symbol);
        const targetSide = decision.action === "CLOSE_POSITION" ? "flat" : decision.target_side;
        return {
            scope: decision.scope,
            candidate_id: null,
            action: decision.action,
            symbol: decision.symbol,
            side: targetSide === "flat" ? null : targetSide,
            target_side: targetSide,
            target_size_fraction_of_equity: decision.target_size_fraction_of_equity,
            size_fraction_of_equity: decision.target_size_fraction_of_equity,
            risk_plan: null,
            playbook: decision.playbook || "none",
            confidence: decision.confidence,
            reason_code: decision.reason_code,
            notes: decision.notes,
            audit: {
                validator_status: validatorReason === "accepted" ? "accepted" : "rejected",
                validator_reason: validatorReason,
                computed_size_fraction_of_equity: decision.target_size_fraction_of_equity,
                candidate_id: null,
                book_pressure: position?.market_signal.book_pressure ?? null,
                vol_ratio_5m_vs_1h: position?.market_signal.vol_ratio_5m_vs_1h ?? null,
                ret_sigma_5m_vs_1h: position?.market_signal.ret_sigma_5m_vs_1h ?? null
            }
        };
    });
}

export function assessDecisionsForRisk(
    decisions: TradeDecision[],
    snapshot: StateSnapshot,
    riskModule: RiskCheckModule
): WorkflowRiskResult {
    const riskAssessments: RiskAssessment[] = [];
    const approvedDecisions: TradeDecision[] = [];
    let newPositionsCount = 0;

    for (const decision of decisions) {
        if (isNoTradeAction(decision.action)) {
            riskAssessments.push({ approved: true, reason: "No trade proposed" });
            continue;
        }

        const riskAssessment = riskModule.assess(decision, snapshot, { newPositionsCount });
        riskAssessments.push(riskAssessment);

        if (riskAssessment.approved && decision.action === "OPEN_POSITION") {
            newPositionsCount++;
        }
        if (riskAssessment.approved && riskAssessment.modifiedOrder) {
            approvedDecisions.push(decision);
        }
    }

    return { riskAssessments, approvedDecisions };
}

export function resolveCandidateJournalStatus(
    decision: TraderDecision | undefined,
    validation: { accepted: boolean; reason: string },
    execution?: { attempted: boolean; success: boolean; error?: string }
): CandidateJournalStatus {
    if (!decision) return "no_llm_decision";
    if (!validation.accepted && decision.action === "OPEN_POSITION") return "llm_approved_but_validator_rejected";
    if (decision.action === "SKIP") return "eligible_but_llm_skipped";
    if (execution?.success) return "executed";
    if (execution?.attempted && !execution.success) return "validator_accepted_but_execution_failed";
    return "validator_accepted";
}

export function isNoTradeAction(action: TradeDecision["action"]): boolean {
    return action === "DO_NOTHING" || action === "HOLD" || action === "HOLD_POSITION" || action === "SKIP";
}

export function compareCandidatesForDeterministicEntry(a: EligibleCandidate, b: EligibleCandidate): number {
    return ((a.market_quality.rank ?? Number.POSITIVE_INFINITY) - (b.market_quality.rank ?? Number.POSITIVE_INFINITY)) ||
        (b.market_quality.edge_to_cost_mult - a.market_quality.edge_to_cost_mult) ||
        (a.risk.cost_to_stop_ratio - b.risk.cost_to_stop_ratio) ||
        a.candidate_id.localeCompare(b.candidate_id);
}

function deterministicPositionNotes(position: TraderContext["existing_positions"][number], action: "hold" | "reduce" | "close"): string {
    const failures = position.failure_signals.length ? position.failure_signals.join(",") : "none";
    const supports = position.support_signals.length ? position.support_signals.join(",") : "none";
    return `deterministic ${action}; bias=${position.management_bias}; support=${supports}; risk=${failures}`;
}

function deterministicPositionKey(position: TraderContext["existing_positions"][number]): string {
    return `${position.symbol}:${position.side}:${position.entry_price}`;
}

function deterministicCandidateConfidence(candidate: EligibleCandidate): number {
    const edge = candidate.market_quality.edge_to_cost_mult;
    const corr = candidate.correlation.correlation_size_multiplier;
    const warningPenalty = candidate.warnings.length > 0 ? 0.08 : 0;
    const base = edge >= 8 ? 0.72 : edge >= 6 ? 0.64 : edge >= 4 ? 0.56 : 0.48;
    return parseFloat(Math.max(0.3, Math.min(0.8, base * corr - warningPenalty)).toFixed(4));
}

function deterministicCandidateNotes(candidate: EligibleCandidate): string {
    const warningText = candidate.warnings.length ? candidate.warnings.join(",") : "none";
    return `deterministic open; rank=${candidate.market_quality.rank ?? "n/a"} edge_to_cost=${candidate.market_quality.edge_to_cost_mult.toFixed(2)} risk=${warningText}`;
}

function reasonCodeForPlaybook(playbook: string): TraderReasonCode {
    if (playbook.startsWith("Momentum")) return "momentum_edge";
    if (playbook.startsWith("Breakout")) return "breakout_edge";
    if (playbook.startsWith("Mean Reversion")) return "mean_reversion_edge";
    return "discretionary_edge";
}
