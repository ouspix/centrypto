/**
 * Shared trading types used across the entire application.
 * Single source of truth for TradeDecision, RiskAssessment, ApprovedOrder, etc.
 */

export type TraderDecisionAction = "OPEN_POSITION" | "SKIP" | "HOLD_POSITION" | "REDUCE_POSITION" | "CLOSE_POSITION";
export type TraderDecisionScope = "candidate" | "position";
export type TradeSide = "long" | "short";
export type TargetSide = TradeSide | "flat";

export type TraderReasonCode =
    | "momentum_edge"
    | "breakout_edge"
    | "mean_reversion_edge"
    | "liquidity_grab"
    | "discretionary_edge"
    | "position_management"
    | "risk_reduction"
    | "skip";

export type TraderDecision = {
    scope: TraderDecisionScope;
    action: TraderDecisionAction;
    candidate_id: string | null;
    symbol: string;
    target_side: TargetSide;
    target_size_fraction_of_equity: number;
    playbook: string | null;
    confidence: number;
    reason_code: TraderReasonCode;
    notes: string;
};

export type TradeDecision = {
    action: "OPEN_POSITION" | "CLOSE_POSITION" | "REDUCE_POSITION" | "ADJUST_STOPS" | "DO_NOTHING" | "HOLD" | "HOLD_POSITION" | "INCREASE_POSITION" | "SKIP";
    scope?: TraderDecisionScope;
    candidate_id?: string | null;
    symbol: string | null;
    side: TradeSide | null;
    target_side: TargetSide | null;
    target_size_fraction_of_equity: number | null;
    size_fraction_of_equity: number | null; // Deprecated
    risk_plan: {
        stop_loss_pct: number;
        take_profit_pct_primary: number;
    } | null;
    playbook: string;
    confidence: number;
    reason_code: string;
    notes: string;
    audit?: {
        spread_bps?: number | null;
        cost_bps?: number | null;
        edge_bps?: number | null;
        book_pressure?: number | null;
        depth_usd?: number | null;
        vol_ratio_5m_vs_1h?: number | null;
        ret_sigma_5m_vs_1h?: number | null;
        anchor_key?: string | null;
        anchor_value?: number | null;
        regime?: string;
        computed_stop_loss_pct?: number | null;
        computed_take_profit_pct_primary?: number | null;
        computed_size_fraction_of_equity?: number | null;
        candidate_id?: string | null;
        max_allowed_size_fraction?: number | null;
        suggested_size_fraction?: number | null;
        validator_status?: string | null;
        validator_reason?: string | null;
        position_manager?: unknown;
    };
};

export type RiskAssessment = {
    approved: boolean;
    reason: string;
    modifiedOrder?: ApprovedOrder;
};

export type CandidateRejectionDiagnostic = {
    symbol: string;
    rank: number | null;
    reasons: string[];
    edge_bps: number | null;
    cost_bps: number | null;
    edge_to_cost_mult: number | null;
    min_depth_usd: number | null;
    tradeable: boolean | null;
    eligible_playbooks: string[];
    triggered_playbooks: string[];
};

export type NearMissCandidate = {
    symbol: string;
    side: TradeSide;
    inPlayScore: number;
    setupType: string | null;
    setupScore: number | null;
    playbook?: Playbook | null;
    status: string;
    reasons: string[];
    warnings: string[];
    executionTradeable: boolean;
    executionBlockReasons: string[];
};

export type OpportunityDiagnostic = NearMissCandidate & {
    discoveryReasons: string[];
};

export type TraderContextDiagnostics = {
    screened_market_count: number;
    held_position_count: number;
    eligible_candidate_count: number;
    max_new_trades_allowed: number;
    rejection_counts: Record<string, number>;
    top_rejections: CandidateRejectionDiagnostic[];
};

export type LlmRunStatus = {
    status: "called" | "skipped";
    reason_code?: string;
    reason?: string;
    diagnostics?: TraderContextDiagnostics & {
        regime: TraderContext["global_regime"];
        profile: string;
        snapshot_id: number | null;
    };
};

export type RiskContext = {
    newPositionsCount: number;
};

export type ApprovedOrder = {
    symbol: string;
    side: 'buy' | 'sell';
    sizeUsd: number;
    sizeCoin?: number;
    limitPx?: number;
    clientTag?: string;
};

export type Playbook =
    | "Momentum:long"
    | "Momentum:short"
    | "Breakout:long"
    | "Breakout:short"
    | "Mean Reversion:long"
    | "Mean Reversion:short"
    | "Pullback Continuation:long"
    | "Pullback Continuation:short"
    | "Failed Bounce:short"
    | "Failed Breakdown:long"
    | "Capitulation Bounce:long"
    | "Capitulation Bounce:short";

export type TraderContext = {
    snapshot_id: number | null;
    timestamp: number;
    global_regime: "RISK_ON" | "RISK_OFF" | "CHOP";
    profile: string;
    portfolio: {
        equity_usd: number;
        gross_exposure_fraction: number;
        remaining_capacity_fraction: number;
        daily_pnl_pct: number;
        kill_switch: boolean;
    };
    existing_positions: ManagedPosition[];
    eligible_candidates: EligibleCandidate[];
    near_miss_candidates?: NearMissCandidate[];
    opportunity_diagnostics?: OpportunityDiagnostic[];
    max_new_trades_allowed?: number;
};

export type ManagedPosition = {
    symbol: string;
    side: TradeSide;
    exposure_fraction: number;
    size_usd: number;
    entry_price: number;
    unrealized_pnl_usd: number;
    market_signal: {
        edge_ok: boolean;
        entry_ok: boolean;
        risk_eligible: boolean;
        reasons_failed: string[];
        book_pressure: number | null;
        book_pressure_side_alignment: "supportive" | "opposite" | "neutral" | "unknown";
        ret_sigma_5m_vs_1h: number | null;
        vol_ratio_5m_vs_1h: number | null;
        trend_aligned: boolean;
        regime_conflict: boolean;
    };
    management_limits: {
        can_hold: boolean;
        can_reduce: boolean;
        can_close: boolean;
        can_increase: false;
        max_increase_to_fraction: 0;
    };
    management_bias: "HOLD" | "REDUCE" | "CLOSE";
    failure_signals: string[];
    support_signals: string[];
};

export type EligibleCandidate = {
    candidate_id: string;
    symbol: string;
    side: TradeSide;
    eligible_playbooks: Playbook[];
    has_hard_trigger: true;
    trigger_diagnostics: {
        trigger_profile: string;
        triggered_playbooks: Playbook[];
        trigger_margin: {
            vol_ratio_margin?: number;
            book_pressure_margin?: number;
            ret_sigma_margin?: number;
            regime_size_multiplier: number;
        };
    };
    market_quality: {
        rank: number | null;
        cost_bps: number;
        edge_bps: number;
        edge_to_cost_mult: number;
        book_pressure: number;
        vol_ratio_5m_vs_1h: number;
        ret_sigma_5m_vs_1h: number;
        trend_aligned: boolean;
        min_depth_usd: number;
    };
    risk: {
        stop_loss_pct: number;
        take_profit_pct_primary: number;
        stop_bps: number;
        take_profit_bps: number;
        cost_to_stop_ratio: number;
        cost_to_tp_ratio: number;
    };
    sizing: {
        risk_based_size_fraction: number;
        max_allowed_size_fraction: number;
        suggested_size_fraction: number;
        min_size_fraction: number;
        risk_at_suggested_size_pct_equity: number;
        effective_leverage_at_suggested_size: number;
        max_effective_leverage_allowed: number;
        exchange_max_leverage_allowed: number;
    };
    correlation: {
        group: string;
        same_direction_group_exposure: number;
        max_group_exposure: number;
        highest_corr_existing_position: {
            symbol: string;
            correlation: number;
            same_direction: boolean;
        } | null;
        correlation_size_multiplier: number;
    };
    warnings: string[];
};

export type TraderValidationResult = {
    accepted: boolean;
    reason: string;
};

export type CandidateJournalStatus =
    | "eligible_but_llm_skipped"
    | "llm_approved_but_validator_rejected"
    | "validator_accepted"
    | "validator_accepted_but_execution_failed"
    | "executed"
    | "managed_position"
    | "no_llm_decision";
