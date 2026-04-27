import { TraderContext, TraderDecision, TraderValidationResult } from "@/types/trading";

const VALID_ACTIONS = new Set(["OPEN_POSITION", "SKIP", "HOLD_POSITION", "REDUCE_POSITION", "CLOSE_POSITION"]);
const VALID_POSITION_ACTIONS = new Set(["HOLD_POSITION", "REDUCE_POSITION", "CLOSE_POSITION"]);
const VALID_CANDIDATE_ACTIONS = new Set(["OPEN_POSITION", "SKIP"]);

export class TraderDecisionValidator {
    public validateBatch(decisions: TraderDecision[], context: TraderContext): TraderValidationResult {
        const seenCandidates = new Set<string>();
        const seenPositions = new Set<string>();

        for (const decision of decisions) {
            const result = this.validateDecision(decision, context, seenCandidates, seenPositions);
            if (!result.accepted) return result;
        }

        return { accepted: true, reason: "accepted" };
    }

    public validateDecision(
        decision: TraderDecision,
        context: TraderContext,
        seenCandidates = new Set<string>(),
        seenPositions = new Set<string>()
    ): TraderValidationResult {
        if (!VALID_ACTIONS.has(decision.action)) return this.reject("invalid_action");
        if (decision.scope !== "candidate" && decision.scope !== "position") return this.reject("invalid_scope");
        if (!decision.symbol) return this.reject("missing_symbol");
        if (typeof decision.confidence !== "number" || decision.confidence < 0 || decision.confidence > 1) return this.reject("invalid_confidence");

        if (decision.scope === "candidate") {
            if (!VALID_CANDIDATE_ACTIONS.has(decision.action)) return this.reject("invalid_candidate_action");
            if (!decision.candidate_id) return this.reject("candidate_id_required");
            if (seenCandidates.has(decision.candidate_id)) return this.reject("duplicate_candidate_decision");
            seenCandidates.add(decision.candidate_id);

            const candidate = context.eligible_candidates.find(c => c.candidate_id === decision.candidate_id);
            if (!candidate) return this.reject("candidate_not_found");
            if (decision.symbol !== candidate.symbol) return this.reject("symbol_mismatch");

            if (decision.action === "SKIP") return { accepted: true, reason: "accepted" };

            if (decision.target_side !== candidate.side) return this.reject("side_mismatch");
            if (!decision.playbook || !candidate.eligible_playbooks.includes(decision.playbook as any)) return this.reject("invalid_playbook");
            if (decision.target_size_fraction_of_equity <= 0) return this.reject("invalid_size");
            if (candidate.sizing.max_allowed_size_fraction <= 0) return this.reject("candidate_size_blocked");
            if (decision.target_size_fraction_of_equity > candidate.sizing.max_allowed_size_fraction) return this.reject("size_exceeds_max");
            if (context.global_regime === "RISK_OFF" && candidate.side === "long" && !candidate.has_hard_trigger) {
                return this.reject("risk_off_discretionary_long");
            }

            return { accepted: true, reason: "accepted" };
        }

        if (!VALID_POSITION_ACTIONS.has(decision.action)) return this.reject("invalid_position_action");
        if (decision.action === "SKIP") return this.reject("skip_not_allowed_for_position");
        if (decision.candidate_id) return this.reject("candidate_id_not_allowed_for_position");
        if (seenPositions.has(decision.symbol)) return this.reject("duplicate_position_decision");
        seenPositions.add(decision.symbol);

        const position = context.existing_positions.find(p => p.symbol === decision.symbol);
        if (!position) return this.reject("position_not_found");

        if (decision.action === "HOLD_POSITION") {
            if (!position.management_limits.can_hold) return this.reject("hold_not_allowed");
            return { accepted: true, reason: "accepted" };
        }

        if (decision.action === "REDUCE_POSITION") {
            if (!position.management_limits.can_reduce) return this.reject("reduce_not_allowed");
            if (decision.target_size_fraction_of_equity < 0) return this.reject("invalid_reduce_size");
            if (decision.target_size_fraction_of_equity >= position.exposure_fraction) return this.reject("reduce_size_not_lower");
            if (decision.target_side !== position.side && decision.target_side !== "flat") return this.reject("reduce_side_mismatch");
            return { accepted: true, reason: "accepted" };
        }

        if (decision.action === "CLOSE_POSITION") {
            if (!position.management_limits.can_close) return this.reject("close_not_allowed");
            if (decision.target_size_fraction_of_equity !== 0) return this.reject("close_size_not_zero");
            if (decision.target_side !== "flat") return this.reject("close_side_not_flat");
            return { accepted: true, reason: "accepted" };
        }

        return this.reject("unhandled_decision");
    }

    private reject(reason: string): TraderValidationResult {
        return { accepted: false, reason };
    }
}
