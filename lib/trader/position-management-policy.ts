import type {
    PositionBasePlaybook,
    PositionManagementConfig,
    PositionManagementResolvedPolicy,
    RegimePositionPolicy
} from "@/lib/trader/position-management-types";

const GLOBAL_DEFAULTS: PositionManagementConfig["global"] = {
    minAgeBeforeManagementMinutes: 2,
    emergencyMaxLossBps: 120,
    liquidationDistanceMinPct: 8,
    estimatedRoundTripFeeBps: 9,
    exitFeeBufferBps: 5,
    breakevenProfitBufferBps: 3,
    minSecondsBetweenActionsPerPosition: 90,
    blockNewEntriesWhenUrgentExit: true,
    blockNewEntriesWhenPortfolioDrawdown: true,
    staleOrderToleranceBps: 8,
    staleOrderMaxAgeMinutes: 10
};

const BASE_POLICY: PositionManagementResolvedPolicy = {
    enabled: true,
    minAgeBeforeManagementMinutes: GLOBAL_DEFAULTS.minAgeBeforeManagementMinutes,
    discoveryTimeStopMinutes: 20,
    profitableTimeStopMinutes: 35,
    protectAfterMfeBps: 20,
    breakevenBufferBps: GLOBAL_DEFAULTS.exitFeeBufferBps + GLOBAL_DEFAULTS.breakevenProfitBufferBps,
    partialTakeProfitAfterMfeBps: 50,
    partialCloseFraction: 0.5,
    trailingActivationMfeBps: 70,
    trailingDistanceBps: 30,
    maxGivebackPct: 60,
    hardStopBps: GLOBAL_DEFAULTS.emergencyMaxLossBps,
    maxAllowedTakeProfitBps: 200,
    maxAllowedStopLossBps: 100,
    allowRunner: false,
    closeOnThesisInvalidation: true,
    closeOnRegimeConflict: true,
    repairMissingStop: false,
    repairStaleTakeProfit: false
};

export const DEFAULT_POSITION_MANAGEMENT_CONFIG: PositionManagementConfig = {
    enabled: true,
    version: "pm-v1",
    global: GLOBAL_DEFAULTS,
    policies: {
        meanReversion: regimes({
            DEFAULT: policy({
                discoveryTimeStopMinutes: 15,
                profitableTimeStopMinutes: 25,
                protectAfterMfeBps: 20,
                partialTakeProfitAfterMfeBps: 45,
                partialCloseFraction: 0.6,
                trailingActivationMfeBps: 70,
                trailingDistanceBps: 30,
                maxGivebackPct: 50,
                hardStopBps: 100,
                maxAllowedTakeProfitBps: 120,
                maxAllowedStopLossBps: 80,
                allowRunner: false
            }),
            CHOP: policy({
                discoveryTimeStopMinutes: 12,
                profitableTimeStopMinutes: 20,
                protectAfterMfeBps: 18,
                breakevenBufferBps: 4,
                partialTakeProfitAfterMfeBps: 35,
                partialCloseFraction: 0.7,
                trailingActivationMfeBps: 50,
                trailingDistanceBps: 20,
                maxGivebackPct: 45,
                hardStopBps: 80,
                maxAllowedTakeProfitBps: 90,
                maxAllowedStopLossBps: 80,
                allowRunner: false
            }),
            RISK_ON: policy({
                discoveryTimeStopMinutes: 15,
                profitableTimeStopMinutes: 25,
                protectAfterMfeBps: 20,
                partialTakeProfitAfterMfeBps: 45,
                partialCloseFraction: 0.6,
                trailingActivationMfeBps: 70,
                trailingDistanceBps: 30,
                maxGivebackPct: 50,
                hardStopBps: 100,
                maxAllowedTakeProfitBps: 120,
                maxAllowedStopLossBps: 90,
                allowRunner: false
            }),
            RISK_OFF: policy({
                discoveryTimeStopMinutes: 8,
                profitableTimeStopMinutes: 15,
                protectAfterMfeBps: 18,
                partialTakeProfitAfterMfeBps: 35,
                partialCloseFraction: 0.8,
                trailingActivationMfeBps: 45,
                trailingDistanceBps: 18,
                maxGivebackPct: 40,
                hardStopBps: 70,
                maxAllowedTakeProfitBps: 80,
                maxAllowedStopLossBps: 70,
                allowRunner: false,
                closeOnRegimeConflict: true
            })
        }),
        momentum: regimes({
            DEFAULT: policy({
                minAgeBeforeManagementMinutes: 3,
                discoveryTimeStopMinutes: 30,
                profitableTimeStopMinutes: 60,
                protectAfterMfeBps: 30,
                breakevenBufferBps: 5,
                partialTakeProfitAfterMfeBps: 70,
                partialCloseFraction: 0.4,
                trailingActivationMfeBps: 90,
                trailingDistanceBps: 40,
                maxGivebackPct: 60,
                hardStopBps: 150,
                maxAllowedTakeProfitBps: 250,
                maxAllowedStopLossBps: 150,
                allowRunner: true,
                closeOnRegimeConflict: false
            }),
            RISK_ON: policy({
                minAgeBeforeManagementMinutes: 3,
                discoveryTimeStopMinutes: 30,
                profitableTimeStopMinutes: 60,
                protectAfterMfeBps: 30,
                breakevenBufferBps: 5,
                partialTakeProfitAfterMfeBps: 70,
                partialCloseFraction: 0.4,
                trailingActivationMfeBps: 90,
                trailingDistanceBps: 40,
                maxGivebackPct: 60,
                hardStopBps: 150,
                maxAllowedTakeProfitBps: 250,
                maxAllowedStopLossBps: 150,
                allowRunner: true,
                closeOnRegimeConflict: false
            }),
            RISK_OFF: policy({
                minAgeBeforeManagementMinutes: 3,
                discoveryTimeStopMinutes: 25,
                profitableTimeStopMinutes: 45,
                protectAfterMfeBps: 25,
                partialTakeProfitAfterMfeBps: 60,
                partialCloseFraction: 0.5,
                trailingActivationMfeBps: 80,
                trailingDistanceBps: 35,
                maxGivebackPct: 55,
                hardStopBps: 130,
                maxAllowedTakeProfitBps: 220,
                maxAllowedStopLossBps: 130,
                allowRunner: true,
                closeOnRegimeConflict: true
            }),
            CHOP: policy({
                minAgeBeforeManagementMinutes: 3,
                discoveryTimeStopMinutes: 15,
                profitableTimeStopMinutes: 25,
                protectAfterMfeBps: 25,
                partialTakeProfitAfterMfeBps: 50,
                partialCloseFraction: 0.6,
                trailingActivationMfeBps: 70,
                trailingDistanceBps: 25,
                maxGivebackPct: 50,
                hardStopBps: 100,
                maxAllowedTakeProfitBps: 150,
                maxAllowedStopLossBps: 100,
                allowRunner: false,
                closeOnRegimeConflict: true
            })
        }),
        breakout: regimes({
            DEFAULT: policy({
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 15,
                profitableTimeStopMinutes: 40,
                protectAfterMfeBps: 30,
                breakevenBufferBps: 5,
                partialTakeProfitAfterMfeBps: 65,
                partialCloseFraction: 0.5,
                trailingActivationMfeBps: 90,
                trailingDistanceBps: 35,
                maxGivebackPct: 55,
                hardStopBps: 120,
                maxAllowedTakeProfitBps: 220,
                maxAllowedStopLossBps: 120,
                allowRunner: true
            })
        }),
        unknown: regimes({
            DEFAULT: policy()
        })
    }
};

export function resolvePositionPolicy(
    basePlaybook: PositionBasePlaybook,
    regime: string,
    config: PositionManagementConfig = DEFAULT_POSITION_MANAGEMENT_CONFIG
): PositionManagementResolvedPolicy {
    const bucket = policyBucket(basePlaybook, config);
    const key = regime === "RISK_ON" || regime === "RISK_OFF" || regime === "CHOP" ? regime : "DEFAULT";
    return {
        ...bucket.DEFAULT,
        ...bucket[key]
    };
}

export function mergePositionManagementConfig(
    override?: Partial<PositionManagementConfig> | null,
    base: PositionManagementConfig = DEFAULT_POSITION_MANAGEMENT_CONFIG
): PositionManagementConfig {
    if (!override) return base;
    return {
        ...base,
        ...override,
        global: {
            ...base.global,
            ...override.global
        },
        policies: {
            meanReversion: mergeRegimePolicy(base.policies.meanReversion, override.policies?.meanReversion),
            momentum: mergeRegimePolicy(base.policies.momentum, override.policies?.momentum),
            breakout: mergeRegimePolicy(base.policies.breakout, override.policies?.breakout),
            unknown: mergeRegimePolicy(base.policies.unknown, override.policies?.unknown)
        }
    };
}

export function basePlaybookFrom(playbook: string | null | undefined): PositionBasePlaybook {
    const normalized = String(playbook ?? "").toLowerCase();
    if (normalized.includes("mean")) return "Mean Reversion";
    if (normalized.includes("breakout")) return "Breakout";
    if (normalized.includes("momentum")) return "Momentum";
    return "Unknown";
}

function policy(overrides: Partial<PositionManagementResolvedPolicy> = {}): PositionManagementResolvedPolicy {
    return { ...BASE_POLICY, ...overrides };
}

function regimes(overrides: Partial<RegimePositionPolicy>): RegimePositionPolicy {
    const fallback = overrides.DEFAULT ?? policy();
    return {
        DEFAULT: fallback,
        CHOP: overrides.CHOP ?? fallback,
        RISK_ON: overrides.RISK_ON ?? fallback,
        RISK_OFF: overrides.RISK_OFF ?? fallback
    };
}

function policyBucket(basePlaybook: PositionBasePlaybook, config: PositionManagementConfig): RegimePositionPolicy {
    if (basePlaybook === "Mean Reversion") return config.policies.meanReversion;
    if (basePlaybook === "Momentum") return config.policies.momentum;
    if (basePlaybook === "Breakout") return config.policies.breakout;
    return config.policies.unknown;
}

function mergeRegimePolicy(base: RegimePositionPolicy, override?: Partial<RegimePositionPolicy>): RegimePositionPolicy {
    return {
        DEFAULT: { ...base.DEFAULT, ...override?.DEFAULT },
        CHOP: { ...base.CHOP, ...override?.CHOP },
        RISK_ON: { ...base.RISK_ON, ...override?.RISK_ON },
        RISK_OFF: { ...base.RISK_OFF, ...override?.RISK_OFF }
    };
}
