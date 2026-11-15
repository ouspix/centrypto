export const ALLOWED_FEATURE_INTERVALS = [1, 5, 10, 30, 60] as const;

export type FeatureIntervalSeconds = typeof ALLOWED_FEATURE_INTERVALS[number];

export interface L2BookLevel {
    price: number;
    size: number;
}

export interface L2BookSnapshot {
    ts: Date;
    symbol: string;
    bids: L2BookLevel[];
    asks: L2BookLevel[];
}

export interface ExecutionBookSnapshot extends L2BookSnapshot {
    intervalSeconds: number;
}

export interface MarketFeatureRow {
    ts: Date;
    symbol: string;
    intervalSeconds: number;

    best_bid: number;
    best_ask: number;
    mid_price: number;
    spread_bps: number;

    bid_depth_5bps_usd: number;
    ask_depth_5bps_usd: number;
    bid_depth_10bps_usd: number;
    ask_depth_10bps_usd: number;
    bid_depth_25bps_usd: number;
    ask_depth_25bps_usd: number;

    depth_5bps_usd: number;
    depth_10bps_usd: number;
    depth_25bps_usd: number;

    book_pressure_5bps: number;
    book_pressure_10bps: number;
    book_pressure_25bps: number;

    buy_slippage_bps_100: number | null;
    sell_slippage_bps_100: number | null;
    buy_slippage_bps_500: number | null;
    sell_slippage_bps_500: number | null;

    cost_bps_100: number | null;
    cost_bps_500: number | null;

    ret_1m: number | null;
    ret_5m: number | null;
    ret_15m: number | null;
    ret_1h: number | null;
    ret_4h: number | null;

    realized_vol_5m: number | null;
    realized_vol_1h: number | null;
    vol_ratio_5m_vs_1h: number | null;
    ret_sigma_5m_vs_1h: number | null;

    trend_side: "long" | "short" | "neutral" | null;
    trend_alignment_score: number | null;

    source_date?: string | null;
    source_hour?: number | null;
    source_file?: string | null;
}
