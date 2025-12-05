import { AgentConfig } from "@/lib/agent-config";
import { ScreenerConfig } from "@/lib/screener-config";

export type Position = {
    symbol: string;
    side: "long" | "short";
    size_usd: number;
    size_coin: number;
    fraction_of_equity: number;
    entry_price: number;
    unrealized_pnl: number;
    leverage: number;
    position_age_min?: number | null;
    regim_when_opening?: string | null;
    edge_to_cost?: number | null;
    playbook_when_opened?: string | null;
    llm_reason_when_opened?: string | null;
};

export type DerivedPortfolio = {
    total_exposure_fraction: number;
    remaining_capacity: number;
    position_slots_used: number;
    slots_remaining: number;
};

export type AccountState = {
    equity_usd: number;
    daily_realized_pnl: number;
    daily_realized_pnl_usd?: number;
    daily_unrealized_pnl_usd?: number;
    daily_total_pnl_usd?: number;
    max_daily_loss: number;
    current_positions: Position[];
    derived_portfolio: DerivedPortfolio;
};

export type MarketSentiment = {
    score: number;
    mentionsVsBaseline: number;
    disagreement: number;
    change2h: number;
};

export type MarketEntry = {
    symbol: string;
    price: number;
    spread_bps: number;
    orderbook: {
        best_bid?: number;
        best_ask?: number;
        mid?: number;
        book_pressure: number;
        bid_liquidity_usd: number;
        ask_liquidity_usd: number;
        depth_bands_usd?: {
            bid: Record<string, number>;
            ask: Record<string, number>;
        };
    };
    returns: {
        m5: number;
        m15: number;
        h1: number;
    };
    vol_zscores: {
        vol_5m_vs_1h: number;
        ret_5m_vs_1h: number;
    };
    realized_vol?: {
        m1: number;
        m5: number;
        m15: number;
        h1: number;
        h4: number;
    };
    atr_pct?: {
        m5: number;
        h1: number;
    };
    volume_zscores?: {
        v1m_vs_1h: number;
        v5m_vs_1h: number;
        v15m_vs_1h: number;
    };
    funding: {
        current_8h: number;
        delta_5m?: number;
    };
    open_interest: {
        current: number;
        delta_5m?: number;
    };
    sentiment: MarketSentiment;
    regime_tags?: string[];
    high_low?: any;
    bbands?: any;
    assetIndex?: number;
    data_source?: string;
    data_unavailable?: boolean;
    news_blocked?: boolean;
        derived?: {
            costs: {
                fees_bps: number;
                slippage_bps_est: number;
                cost_bps: number;
                cost_ok: boolean;
            };
            edge: {
                expected_move_bps: number;
                edge_bps: number;
                edge_ok: boolean;
            };
            technicals: {
                high_low: any;
                bb_width_m5: number;
            };
            triggers: {
                direction_m15: number;
                direction_h1: number;
                trend_aligned: boolean;
                momentum_ok_long: boolean;
                momentum_ok_short: boolean;
                mr_ok_long: boolean;
                mr_ok_short: boolean;
                breakout_ok: boolean;
            };
            liquidity: {
                min_depth_usd: number;
                depth_ok: boolean;
                tradeable: boolean;
            };
            normalized: {
                ret_sigma_5m_vs_1h: number;
                vol_ratio_5m_vs_1h: number;
            };
            entry?: {
                entry_ok: boolean;
                edge_to_cost_mult: number;
                entry_score?: number | null;
                confidence_hint?: number | null;
                reasons_failed?: string[];
            };
            risk?: {
                eligible: boolean;
                eligible_playbooks: string[];
                best_anchor_key: string | null;
                best_anchor_value: number | null;
            };
            rank?: number;
        };
    };

export type GlobalRegime = {
    current: "RISK_ON" | "RISK_OFF" | "CHOP";
    score: number; // -1 (risk-off) to 1 (risk-on)
    reason: string;
};

export type StateSnapshot = {
    timestamp: number;
    account: AccountState;
    markets: Record<string, MarketEntry>;
    constraints: {
        max_position_pct_equity?: number;
        max_position_pct_equity_per_symbol: number;
        max_total_exposure_pct_equity: number;
        min_trade_notional_usd: number;
        kill_switch: boolean;
        no_flip_same_tick: boolean;
        max_new_positions_per_cycle: number;
        daily_loss_kill_switch_fraction: number;
        max_new_trades_allowed?: number;
        max_new_entries_allowed?: number;
        max_increases_allowed?: number | null;
    };
    allowed_actions: string[];
    meta: {
        note: string;
        fallback_markets?: string[];
        missing_markets?: string[];
        duplicate_markets?: string[];
        snapshot_id?: number;
    };
    presets?: {
        screening: ScreenerConfig;
        agent: AgentConfig;
    };
    global_regime: GlobalRegime;
    debug_context?: boolean;
};
