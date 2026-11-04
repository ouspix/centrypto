import {
    basePlaybook,
    buildPriorBucketKey,
    computeCandidateStructureFlags,
    normalizeCandidatePromotionConfig,
    normalizePlaybookKey,
    type CandidatePromotionConfig,
    type CandidateStructureFlags
} from "@/lib/candidate-promotion";
import type { AgentConfig } from "@/lib/agent-config";
import type { GlobalRegime, MarketEntry } from "@/types/snapshot";
import type { Playbook, TradeSide } from "@/types/trading";

export type CandidatePromotionPolicyInput = {
    market: MarketEntry;
    side: TradeSide;
    playbook: Playbook | string | null | undefined;
    regime: GlobalRegime["current"];
    inPlayScore?: number | null;
    setupScore?: number | null;
    costBps?: number | null;
    currentStatus?: string | null;
};

export type CandidatePromotionPolicyDecision = {
    structureFlags: CandidateStructureFlags;
    matchedPriorBucket: string | null;
    promotionReason: string | null;
    demotionReason: string | null;
    shadowReason: string | null;
    finalStatus: "unchanged" | "promote" | "demote";
    configEpoch: string | null;
};

export class CandidatePromotionPolicy {
    private readonly config: CandidatePromotionConfig;

    constructor(agentConfig: AgentConfig) {
        this.config = normalizeCandidatePromotionConfig(agentConfig.candidate_promotion);
    }

    public evaluate(input: CandidatePromotionPolicyInput): CandidatePromotionPolicyDecision {
        const playbook = normalizePlaybookKey(input.playbook, input.side);
        const costBps = input.costBps ?? input.market.execution?.costBps ?? input.market.derived?.costs?.cost_bps ?? null;
        const structureFlags = computeCandidateStructureFlags({
            market: input.market,
            side: input.side
        });
        const matchedPriorBucket = buildPriorBucketKey({
            playbook,
            side: input.side,
            regime: input.regime,
            inPlayScore: input.inPlayScore,
            setupScore: input.setupScore,
            costBps
        });

        const demotionReason = this.demoteReason(playbook, structureFlags);
        if (demotionReason) {
            return {
                structureFlags,
                matchedPriorBucket,
                promotionReason: null,
                demotionReason,
                shadowReason: null,
                finalStatus: "demote",
                configEpoch: this.config.config_epoch ?? null
            };
        }

        const priorStatus = this.config.prior_buckets[matchedPriorBucket]?.status ?? "OFF";
        const override = this.config.playbook_overrides[playbook] ??
            this.config.playbook_overrides[basePlaybook(playbook)];
        const overrideAllowed = override?.action === "enabled" && this.overrideRequirementsPass(override, structureFlags);

        let promotionReason: string | null = null;
        let shadowReason: string | null = null;
        if (priorStatus === "LIVE") {
            promotionReason = `PRIOR_BUCKET_LIVE:${matchedPriorBucket}`;
        } else if (priorStatus === "SHADOW") {
            shadowReason = `PRIOR_BUCKET_SHADOW:${matchedPriorBucket}`;
        }

        if (!promotionReason && overrideAllowed) {
            promotionReason = `PLAYBOOK_OVERRIDE_ENABLED:${playbook}`;
        }
        if (!promotionReason && this.config.global_structure_rules.freshContinuationBonus && structureFlags.is_fresh_continuation) {
            promotionReason = "STRUCTURE_FRESH_CONTINUATION_BONUS";
        }
        if (!promotionReason && this.config.global_structure_rules.pullbackContinuationBonus && structureFlags.is_pullback_continuation) {
            promotionReason = "STRUCTURE_PULLBACK_CONTINUATION_BONUS";
        }

        return {
            structureFlags,
            matchedPriorBucket,
            promotionReason,
            demotionReason: null,
            shadowReason,
            finalStatus: promotionReason ? "promote" : "unchanged",
            configEpoch: this.config.config_epoch ?? null
        };
    }

    private demoteReason(playbook: string, flags: CandidateStructureFlags): string | null {
        const globalRules = this.config.global_structure_rules;
        if (flags.is_late_chase && globalRules.lateChase !== "ALLOW") {
            return globalRules.lateChase === "BLOCK" ? "LATE_CHASE_BLOCK" : "LATE_CHASE_NEAR_MISS_ONLY";
        }
        if (
            flags.is_extended_breakout &&
            !flags.is_pullback_continuation &&
            globalRules.extendedBreakoutWithoutPullback !== "ALLOW"
        ) {
            return globalRules.extendedBreakoutWithoutPullback === "BLOCK"
                ? "EXTENDED_BREAKOUT_WITHOUT_PULLBACK_BLOCK"
                : "EXTENDED_BREAKOUT_WITHOUT_PULLBACK_NEAR_MISS_ONLY";
        }

        const override = this.config.playbook_overrides[playbook] ??
            this.config.playbook_overrides[basePlaybook(playbook)];
        if (!override) return null;
        if (!this.overrideRequirementsPass(override, flags)) return "PLAYBOOK_OVERRIDE_REQUIREMENTS_NOT_MET";
        if (override.action === "disabled") return `PLAYBOOK_DISABLED:${playbook}`;
        if (override.action === "near_miss_only") return `PLAYBOOK_NEAR_MISS_ONLY:${playbook}`;
        return null;
    }

    private overrideRequirementsPass(
        override: CandidatePromotionConfig["playbook_overrides"][string],
        flags: CandidateStructureFlags
    ): boolean {
        if (override.requireNotLateChase && flags.is_late_chase) return false;
        if (override.requireAnyStructure.length === 0) return true;
        return override.requireAnyStructure.some(requirement =>
            requirement === "fresh_continuation"
                ? flags.is_fresh_continuation
                : flags.is_pullback_continuation
        );
    }
}
