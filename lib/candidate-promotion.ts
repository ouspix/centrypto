import type { MarketStructure } from "@/services/MarketStructureService";
import type { MarketEntry } from "@/types/snapshot";
import type { TradeSide } from "@/types/trading";

export type CandidateStructureRule = "ALLOW" | "NEAR_MISS_ONLY" | "BLOCK";
export type CandidatePromotionPriorStatus = "OFF" | "SHADOW" | "LIVE";
export type CandidatePromotionOverrideAction = "enabled" | "near_miss_only" | "disabled";
export type CandidatePromotionStructureRequirement = "fresh_continuation" | "pullback_continuation";

export type CandidatePromotionConfig = {
    config_epoch?: string | null;
    global_structure_rules: {
        lateChase: CandidateStructureRule;
        extendedBreakoutWithoutPullback: CandidateStructureRule;
        freshContinuationBonus: boolean;
        pullbackContinuationBonus: boolean;
    };
    playbook_overrides: Record<string, {
        action: CandidatePromotionOverrideAction;
        requireNotLateChase: boolean;
        requireAnyStructure: CandidatePromotionStructureRequirement[];
    }>;
    prior_buckets: Record<string, {
        status: CandidatePromotionPriorStatus;
    }>;
};

export type CandidateStructureFlags = {
    is_late_chase: boolean;
    is_fresh_continuation: boolean;
    is_pullback_continuation: boolean;
    is_extended_breakout: boolean;
};

export const DEFAULT_CANDIDATE_PROMOTION_CONFIG: CandidatePromotionConfig = {
    config_epoch: null,
    global_structure_rules: {
        lateChase: "ALLOW",
        extendedBreakoutWithoutPullback: "ALLOW",
        freshContinuationBonus: false,
        pullbackContinuationBonus: false
    },
    playbook_overrides: {},
    prior_buckets: {}
};

const STRUCTURE_RULES = new Set<CandidateStructureRule>(["ALLOW", "NEAR_MISS_ONLY", "BLOCK"]);
const PRIOR_STATUSES = new Set<CandidatePromotionPriorStatus>(["OFF", "SHADOW", "LIVE"]);
const OVERRIDE_ACTIONS = new Set<CandidatePromotionOverrideAction>(["enabled", "near_miss_only", "disabled"]);
const STRUCTURE_REQUIREMENTS = new Set<CandidatePromotionStructureRequirement>(["fresh_continuation", "pullback_continuation"]);

export function normalizeCandidatePromotionConfig(input?: unknown): CandidatePromotionConfig {
    const raw = isRecord(input) ? input : {};
    const globalRules = isRecord(raw.global_structure_rules) ? raw.global_structure_rules : {};
    const playbookOverrides = isRecord(raw.playbook_overrides) ? raw.playbook_overrides : {};
    const priorBuckets = isRecord(raw.prior_buckets) ? raw.prior_buckets : {};

    return {
        config_epoch: typeof raw.config_epoch === "string" && raw.config_epoch.trim()
            ? raw.config_epoch.trim()
            : null,
        global_structure_rules: {
            lateChase: normalizeStructureRule(globalRules.lateChase),
            extendedBreakoutWithoutPullback: normalizeStructureRule(globalRules.extendedBreakoutWithoutPullback),
            freshContinuationBonus: Boolean(globalRules.freshContinuationBonus),
            pullbackContinuationBonus: Boolean(globalRules.pullbackContinuationBonus)
        },
        playbook_overrides: Object.fromEntries(
            Object.entries(playbookOverrides)
                .map(([playbook, value]) => [String(playbook), normalizePlaybookOverride(value)] as const)
                .filter(([, value]) => !!value)
        ) as CandidatePromotionConfig["playbook_overrides"],
        prior_buckets: Object.fromEntries(
            Object.entries(priorBuckets)
                .map(([key, value]) => [String(key), normalizePriorBucket(value)] as const)
                .filter(([, value]) => !!value)
        ) as CandidatePromotionConfig["prior_buckets"]
    };
}

export function candidatePromotionComparable(config?: unknown): Omit<CandidatePromotionConfig, "config_epoch"> {
    const normalized = normalizeCandidatePromotionConfig(config);
    return {
        global_structure_rules: normalized.global_structure_rules,
        playbook_overrides: sortRecord(normalized.playbook_overrides),
        prior_buckets: sortRecord(normalized.prior_buckets)
    };
}

export function candidatePromotionRulesEqual(left?: unknown, right?: unknown): boolean {
    return stableStringify(candidatePromotionComparable(left)) === stableStringify(candidatePromotionComparable(right));
}

export function candidatePromotionRulesHash(config?: unknown): string {
    return hashString(stableStringify(candidatePromotionComparable(config)));
}

export function withCandidatePromotionEpoch(config: CandidatePromotionConfig, epoch: string | null): CandidatePromotionConfig {
    return {
        ...normalizeCandidatePromotionConfig(config),
        config_epoch: epoch
    };
}

export function computeCandidateStructureFlags(input: {
    market?: MarketEntry | null;
    structure?: MarketStructure | null;
    side: TradeSide;
}): CandidateStructureFlags {
    const structure = input.structure ?? input.market?.derived?.structure ?? null;
    if (!structure) return emptyStructureFlags();

    return computeCandidateStructureFlagsFromStructure(structure, input.side);
}

export function computeCandidateStructureFlagsFromStructure(
    structure: MarketStructure,
    side: TradeSide
): CandidateStructureFlags {
    const impulseDirection = structure.impulse.direction;
    const favorableImpulse = (side === "long" && impulseDirection === "up") ||
        (side === "short" && impulseDirection === "down");
    const impulseBps = favorableImpulse ? Math.abs(structure.impulse.impulseBps ?? 0) : 0;
    const distanceFromHigh = finite(structure.range.distanceFromLocalHighBps);
    const distanceFromLow = finite(structure.range.distanceFromLocalLowBps);
    const pullbackBps = side === "long"
        ? Math.abs(Math.min(0, distanceFromHigh ?? 0))
        : Math.max(0, distanceFromLow ?? 0);
    const pullbackPct = impulseBps > 0 ? Math.min(1, pullbackBps / Math.max(impulseBps, 1)) : null;
    const nearFavorableExtreme = side === "long"
        ? distanceFromHigh !== null && distanceFromHigh >= -10
        : distanceFromLow !== null && distanceFromLow <= 10;
    const rangeExpansion = (structure.range.rangeExpansionRatio ?? 0) >= 1.4;

    const isExtendedBreakout = favorableImpulse &&
        impulseBps >= 40 &&
        nearFavorableExtreme &&
        rangeExpansion &&
        (pullbackPct === null || pullbackPct <= 0.15);
    const isLateChase = favorableImpulse &&
        impulseBps >= 80 &&
        nearFavorableExtreme &&
        (pullbackPct === null || pullbackPct <= 0.15) &&
        (structure.impulse.stalled || isExtendedBreakout);
    const isPullbackContinuation = favorableImpulse &&
        impulseBps >= 30 &&
        pullbackPct !== null &&
        pullbackPct >= 0.20 &&
        pullbackPct <= 0.70;
    const isFreshContinuation = favorableImpulse &&
        impulseBps >= 20 &&
        (pullbackPct === null || pullbackPct < 0.20) &&
        !isLateChase;

    return {
        is_late_chase: isLateChase,
        is_fresh_continuation: isFreshContinuation,
        is_pullback_continuation: isPullbackContinuation,
        is_extended_breakout: isExtendedBreakout
    };
}

export function emptyStructureFlags(): CandidateStructureFlags {
    return {
        is_late_chase: false,
        is_fresh_continuation: false,
        is_pullback_continuation: false,
        is_extended_breakout: false
    };
}

export function bucketInPlayScore(value: number | null | undefined): string {
    return scoreBucket(value, [
        [0, 39, "00-39"],
        [40, 54, "40-54"],
        [55, 59, "55-59"],
        [60, 69, "60-69"],
        [70, Infinity, "70-79"]
    ]);
}

export function bucketSetupScore(value: number | null | undefined): string {
    return scoreBucket(value, [
        [0, 39, "00-39"],
        [40, 54, "40-54"],
        [55, 59, "55-59"],
        [60, 69, "60-69"],
        [70, 79, "70-79"],
        [80, Infinity, "80-100"]
    ]);
}

export function bucketCostBps(value: number | null | undefined): string {
    const numberValue = finite(value) ?? 0;
    if (numberValue < 5) return "00-05";
    if (numberValue < 10) return "05-10";
    if (numberValue < 15) return "10-15";
    if (numberValue < 25) return "15-25";
    return "25+";
}

export function buildPriorBucketKey(input: {
    playbook: string | null | undefined;
    side: string | null | undefined;
    regime: string | null | undefined;
    inPlayScore: number | null | undefined;
    setupScore: number | null | undefined;
    costBps: number | null | undefined;
}): string {
    return [
        input.playbook || "NO_PLAYBOOK",
        input.side || "unknown",
        input.regime || "UNKNOWN",
        bucketInPlayScore(input.inPlayScore),
        bucketSetupScore(input.setupScore),
        bucketCostBps(input.costBps)
    ].join("|");
}

export function basePlaybook(playbook: string | null | undefined): string {
    return String(playbook ?? "").split(":")[0]?.trim() || "";
}

export function normalizePlaybookKey(playbook: string | null | undefined, side?: string | null): string {
    const raw = String(playbook ?? "").trim();
    if (!raw) return "";
    if (raw.includes(":")) return raw;
    return side ? `${raw}:${side}` : raw;
}

function normalizeStructureRule(value: unknown): CandidateStructureRule {
    const text = String(value ?? "").trim().toUpperCase();
    return STRUCTURE_RULES.has(text as CandidateStructureRule) ? text as CandidateStructureRule : "ALLOW";
}

function normalizePlaybookOverride(value: unknown): CandidatePromotionConfig["playbook_overrides"][string] | null {
    if (!isRecord(value)) return null;
    const actionText = String(value.action ?? "").trim().toLowerCase().replace(/_/g, "-");
    const action = actionText === "near-miss only" || actionText === "near-miss-only" || actionText === "near_miss_only"
        ? "near_miss_only"
        : actionText;
    if (!OVERRIDE_ACTIONS.has(action as CandidatePromotionOverrideAction)) return null;
    const rawRequirements = Array.isArray(value.requireAnyStructure) ? value.requireAnyStructure : [];
    return {
        action: action as CandidatePromotionOverrideAction,
        requireNotLateChase: Boolean(value.requireNotLateChase),
        requireAnyStructure: rawRequirements
            .map(item => String(item).trim())
            .filter((item): item is CandidatePromotionStructureRequirement =>
                STRUCTURE_REQUIREMENTS.has(item as CandidatePromotionStructureRequirement)
            )
    };
}

function normalizePriorBucket(value: unknown): CandidatePromotionConfig["prior_buckets"][string] | null {
    if (!isRecord(value)) return null;
    const status = String(value.status ?? "").trim().toUpperCase();
    if (!PRIOR_STATUSES.has(status as CandidatePromotionPriorStatus)) return null;
    return { status: status as CandidatePromotionPriorStatus };
}

function scoreBucket(value: number | null | undefined, buckets: Array<[number, number, string]>): string {
    const numberValue = Math.max(0, finite(value) ?? 0);
    const found = buckets.find(([min, max]) => numberValue >= min && numberValue <= max);
    return found?.[2] ?? buckets[0][2];
}

function finite(value: unknown): number | null {
    const numberValue = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
}

function isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
    return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function hashString(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
