export type AutoTraderNetwork = "mainnet" | "testnet";
export type AutoTraderCycleType = "SCHEDULED" | "MANUAL" | "RECOVERY";
export type AutoTraderRunStatus = "RUNNING" | "COMPLETED" | "SKIPPED" | "FAILED";
export type AutoTraderDecisionType = "ENTRY_CANDIDATE" | "OPEN_POSITION_MANAGEMENT";
export type AutoTraderPositionSnapshotPhase = "PRE_DECISION" | "POST_EXECUTION" | "PERIODIC_SYNC";
export type AutoTraderOrderRole = "ENTRY" | "REDUCE" | "CLOSE" | "STOP_LOSS" | "TAKE_PROFIT";
export type AutoTraderOrderStatus = "PLANNED" | "SUBMITTED" | "FILLED" | "RESTING" | "FAILED" | "ERROR";
export type AutoTraderFillType = "OPEN" | "CLOSE" | "REDUCE" | "UNKNOWN";
export type AutoTraderAttributionStatus = "MATCHED" | "FALLBACK_MATCHED" | "UNMATCHED";
export type AutoTraderAttributionMethod = "ORDER_ID" | "CLOID" | "CLOID_TO_OID" | "FALLBACK" | "UNMATCHED";
export type AutoTraderLifecycleStatus = "OPEN" | "CLOSED";
export type AutoTraderMfeSource = "CANDLE_1M" | "POSITION_SNAPSHOT" | "UNKNOWN";
export type AutoTraderMfeCoverage = "FULL" | "PARTIAL" | "NONE";

export type ReviewThresholds = {
    greenToRedMinMfeBps: number;
    lateGivebackMinMfeBps: number;
    lateGivebackPct: number;
};

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
    greenToRedMinMfeBps: 20,
    lateGivebackMinMfeBps: 20,
    lateGivebackPct: 75
};

export type NormalizedFill = {
    accountAddress: string;
    agentWalletAddress?: string | null;
    network: AutoTraderNetwork;
    rawCoin: string;
    normalizedSymbol: string;
    px: number;
    sz: number;
    side: string | null;
    dir: string | null;
    closedPnl: number;
    fee: number;
    hash: string | null;
    oid: string | null;
    cloid: string | null;
    tid: string | null;
    time: Date;
    fillType: AutoTraderFillType;
    dedupeKey: string;
    rawJson: string;
};

export type LifecycleInputFill = {
    id: string;
    normalizedSymbol: string;
    side: string | null;
    dir: string | null;
    px: number;
    sz: number;
    closedPnl: number;
    fee: number;
    time: Date;
    attributionStatus: AutoTraderAttributionStatus | string;
    attributionMethod: AutoTraderAttributionMethod | string;
    decisionId?: string | null;
    orderAttemptId?: string | null;
};

export type ReconstructedLifecycle = {
    id?: string;
    accountAddress: string;
    network: AutoTraderNetwork;
    symbol: string;
    side: "long" | "short";
    openedAt: Date;
    closedAt: Date | null;
    status: AutoTraderLifecycleStatus;
    openFillIds: string[];
    closeFillIds: string[];
    attributedDecisionIds: string[];
    attributedOrderAttemptIds: string[];
    entryPrice: number;
    exitPrice: number | null;
    sizeOpened: number;
    sizeClosed: number;
    grossRealizedPnl: number;
    fees: number;
    netRealizedPnl: number;
    attributionMethod: AutoTraderAttributionMethod;
    rawDebugJson: Record<string, unknown>;
};
