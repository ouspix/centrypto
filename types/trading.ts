/**
 * Shared trading types used across the entire application.
 * Single source of truth for TradeDecision, RiskAssessment, ApprovedOrder, etc.
 */

export type TradeDecision = {
    action: "OPEN_POSITION" | "CLOSE_POSITION" | "REDUCE_POSITION" | "ADJUST_STOPS" | "DO_NOTHING" | "HOLD" | "HOLD_POSITION" | "INCREASE_POSITION";
    symbol: string | null;
    side: "long" | "short" | null;
    target_side: "long" | "short" | "flat" | null;
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
    };
};

export type RiskAssessment = {
    approved: boolean;
    reason: string;
    modifiedOrder?: ApprovedOrder;
};

export type RiskContext = {
    newPositionsCount: number;
};

export type ApprovedOrder = {
    symbol: string;
    side: 'buy' | 'sell';
    sizeUsd: number;
    limitPx?: number;
    clientTag?: string;
};
