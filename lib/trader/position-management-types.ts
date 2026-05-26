import type { AgentConfig } from "@/lib/agent-config";
import type { StateSnapshot } from "@/types/snapshot";

export type PositionSide = "long" | "short";
export type NetworkName = "mainnet" | "testnet";

export type PositionLifecycleState =
    | "NEW"
    | "DISCOVERY"
    | "PROTECTED"
    | "HARVESTING"
    | "TRAILING"
    | "EXIT_NOW"
    | "COOLDOWN";

export type PositionManagementActionName =
    | "HOLD_POSITION"
    | "CLOSE_POSITION"
    | "REDUCE_POSITION"
    | "PLACE_BREAKEVEN_STOP"
    | "REPLACE_STOP"
    | "REPLACE_TAKE_PROFIT"
    | "REPLACE_BRACKET"
    | "CANCEL_STALE_ORDER"
    | "NO_ACTION";

export type PositionManagementUrgency = "EMERGENCY" | "HIGH" | "NORMAL" | "LOW";

export type PositionManagementReasonCode =
    | "EMERGENCY_MAX_LOSS"
    | "LIQUIDATION_RISK"
    | "MISSING_PROTECTIVE_STOP"
    | "STALE_STOP"
    | "STALE_TAKE_PROFIT"
    | "OPEN_WAS_GREEN_NOW_RED"
    | "BREAKEVEN_PROTECTION"
    | "PARTIAL_TP_AFTER_MFE"
    | "MFE_GIVEBACK_LIMIT"
    | "TRAILING_STOP_HIT"
    | "TIME_STOP"
    | "TIME_STOP_NOT_GREEN"
    | "TIME_STOP_STALE_GREEN"
    | "THESIS_INVALIDATED"
    | "REGIME_INVALIDATION"
    | "MEAN_REVERSION_FAILED"
    | "MOMENTUM_FAILED"
    | "BREAKOUT_FAILED"
    | "ORDER_STATE_OK"
    | "POSITION_TOO_NEW"
    | "INSUFFICIENT_DATA"
    | "HOLD_WITH_SUPPORT";

export type PositionBasePlaybook = "Momentum" | "Mean Reversion" | "Breakout" | "Unknown";

export type PersistedPositionManagementState = {
    state?: PositionLifecycleState | string | null;
    highestMfeBps?: number | null;
    lowestMaeBps?: number | null;
    peakUnrealizedPnl?: number | null;
    partialTakenFraction?: number | null;
    protectedAt?: Date | string | null;
    lastActionAt?: Date | string | null;
    lastAction?: string | null;
    lastReasonCode?: string | null;
    lastStopPx?: number | null;
    lastTakeProfitPx?: number | null;
};

export type ManagedLifecycleState = {
    lifecycleId: string | null;
    symbol: string;
    side: PositionSide;
    openedAt: Date;
    ageMinutes: number;
    entryPrice: number;
    currentPrice: number;
    sizeUsd: number;
    sizeCoin: number;
    exposureFraction: number;
    currentUnrealizedPnlUsd: number;
    grossCurrentBps: number;
    estimatedFeeBps: number;
    netCurrentBps: number;
    mfeBps: number | null;
    maeBps: number | null;
    givebackPct: number | null;
    peakUnrealizedPnlUsd: number | null;
    drawdownFromPeakUsd: number | null;
    playbook: string | null;
    basePlaybook: PositionBasePlaybook;
    entryReasonCode: string | null;
    entryConfidence: number | null;
    regimeAtEntry?: string | null;
    currentRegime: "RISK_ON" | "RISK_OFF" | "CHOP" | string;
    marketTags: string[];
    liquidationPrice?: number | null;
    marketSignal: {
        edgeOk: boolean | null;
        entryOk: boolean | null;
        riskEligible: boolean | null;
        bookPressure: number | null;
        bookPressureAlignment: "supportive" | "opposite" | "neutral" | "unknown";
        trendAligned: boolean | null;
        volRatio5mVs1h: number | null;
        retSigma5mVs1h: number | null;
        reasonsFailed: string[];
    };
    priorManagementState?: PersistedPositionManagementState | null;
};

export type ManagedOpenOrder = {
    symbol: string;
    side: "buy" | "sell";
    positionSide: PositionSide | null;
    orderRole: "ENTRY" | "CLOSE" | "REDUCE" | "STOP_LOSS" | "TAKE_PROFIT" | "UNKNOWN";
    oid?: string | null;
    cloid?: string | null;
    reduceOnly: boolean;
    px: number | null;
    triggerPx: number | null;
    sizeCoin: number | null;
    sizeUsd: number | null;
    status: "OPEN" | "RESTING" | "SUBMITTED" | "UNKNOWN";
    createdAt?: Date | null;
    updatedAt?: Date | null;
};

export type PositionManagementInput = {
    accountAddress: string;
    network: NetworkName;
    now: Date;
    snapshot: StateSnapshot;
    openLifecycles: ManagedLifecycleState[];
    openOrders: ManagedOpenOrder[];
    config: AgentConfig;
    reviewReliableSince?: Date | null;
};

export type PositionManagementResult = {
    actions: PositionManagementAction[];
    portfolioFlags: {
        blockNewEntries: boolean;
        reasonCodes: string[];
    };
    diagnostics: {
        evaluatedPositions: number;
        urgentActionCount: number;
        repairActionCount: number;
        holdCount: number;
    };
};

export type PositionManagementAction = {
    source: "POSITION_MANAGER";
    lifecycleId: string | null;
    symbol: string;
    side: PositionSide;
    stateBefore: PositionLifecycleState;
    stateAfter: PositionLifecycleState;
    action: PositionManagementActionName;
    urgency: PositionManagementUrgency;
    bypassLlm: boolean;
    reasonCode: PositionManagementReasonCode;
    notes: string;
    targetSizeFractionOfEquity?: number | null;
    reduceFraction?: number | null;
    stopReplacement?: {
        stopPx: number;
        reason: string;
        cancelExistingStopOids: string[];
    } | null;
    takeProfitReplacement?: {
        takeProfitPx: number;
        reason: string;
        cancelExistingTakeProfitOids: string[];
    } | null;
    cancelOrderOids?: string[];
    evidence: PositionManagementEvidence;
};

export type PositionManagementEvidence = {
    ageMinutes: number;
    entryPrice: number;
    currentPrice: number;
    grossCurrentBps: number;
    netCurrentBps: number;
    mfeBps: number | null;
    maeBps: number | null;
    givebackPct: number | null;
    currentUnrealizedPnlUsd: number;
    peakUnrealizedPnlUsd: number | null;
    drawdownFromPeakUsd: number | null;
    estimatedFeeBps: number;
    playbook: string | null;
    basePlaybook: string;
    currentRegime: string;
    marketTags: string[];
    bookPressure: number | null;
    bookPressureAlignment: string;
    trendAligned: boolean | null;
    hasStop: boolean;
    hasTakeProfit: boolean;
    currentStopPx: number | null;
    currentTakeProfitPx: number | null;
    stopDistanceBps: number | null;
    takeProfitDistanceBps: number | null;
    policy: PositionManagementResolvedPolicy;
};

export type PositionManagementConfig = {
    enabled: boolean;
    version: string;
    global: {
        minAgeBeforeManagementMinutes: number;
        emergencyMaxLossBps: number;
        liquidationDistanceMinPct: number;
        estimatedRoundTripFeeBps: number;
        exitFeeBufferBps: number;
        breakevenProfitBufferBps: number;
        minSecondsBetweenActionsPerPosition: number;
        blockNewEntriesWhenUrgentExit: boolean;
        blockNewEntriesWhenPortfolioDrawdown: boolean;
        staleOrderToleranceBps: number;
        staleOrderMaxAgeMinutes: number;
    };
    policies: {
        meanReversion: RegimePositionPolicy;
        momentum: RegimePositionPolicy;
        breakout: RegimePositionPolicy;
        unknown: RegimePositionPolicy;
    };
};

export type RegimePositionPolicy = {
    CHOP: PositionManagementResolvedPolicy;
    RISK_ON: PositionManagementResolvedPolicy;
    RISK_OFF: PositionManagementResolvedPolicy;
    DEFAULT: PositionManagementResolvedPolicy;
};

export type PositionManagementResolvedPolicy = {
    enabled: boolean;
    minAgeBeforeManagementMinutes: number;
    discoveryTimeStopMinutes: number;
    profitableTimeStopMinutes: number;
    protectAfterMfeBps: number;
    breakevenBufferBps: number;
    partialTakeProfitAfterMfeBps: number;
    partialCloseFraction: number;
    trailingActivationMfeBps: number;
    trailingDistanceBps: number;
    maxGivebackPct: number;
    hardStopBps: number;
    maxAllowedTakeProfitBps: number;
    maxAllowedStopLossBps: number;
    allowRunner: boolean;
    closeOnThesisInvalidation: boolean;
    closeOnRegimeConflict: boolean;
    repairMissingStop: boolean;
    repairStaleTakeProfit: boolean;
};
