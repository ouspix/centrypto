export type Position = {
    symbol: string;
    side: "long" | "short";
    size_usd: number;
    size_coin: number;
    fraction_of_equity: number;
    entry_price: number;
    unrealized_pnl: number;
    leverage: number;
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
        book_pressure: number;
        bid_liquidity_usd: number;
        ask_liquidity_usd: number;
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
    funding: {
        current_8h: number;
    };
    open_interest: {
        current: number;
    };
    sentiment: MarketSentiment;
    regime_tags?: string[];
    high_low?: any;
    bbands?: any;
    assetIndex?: number;
    data_source?: string;
    data_unavailable?: boolean;
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
        max_position_pct_equity_per_symbol: number;
        max_total_exposure_pct_equity: number;
        min_trade_notional_usd: number;
        kill_switch: boolean;
        no_flip_same_tick: boolean;
    };
    allowed_actions: string[];
    meta: {
        note: string;
        fallback_markets?: string[];
        missing_markets?: string[];
        duplicate_markets?: string[];
    };
    global_regime: GlobalRegime;
};
