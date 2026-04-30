import { AgentConfig } from "@/lib/agent-config";
import { ScreenerConfig } from "@/lib/screener-config";
import { MarketEntry, StateSnapshot } from "@/types/snapshot";
import { TradeDecision, TraderContext, TraderDecision } from "@/types/trading";

export const ALLOWED_FEATURE_INTERVALS = [1, 5, 10, 30, 60] as const;

export type FeatureIntervalSeconds = typeof ALLOWED_FEATURE_INTERVALS[number];

export type BacktestPolicyName =
    | "take_none"
    | "take_top_rank"
    | "take_best_edge_cost"
    | "clean_only"
    | "recorded_llm"
    | "real_llm";

export type HydrationConfig = {
    enabled: boolean;
    symbols: string[];
    lookbackHours: number;
    tmpRoot?: string;
    keepTmp?: boolean;
};

export type BacktestLlmConfig = {
    enabled: boolean;
    model: string;
    decisionsPath?: string;
    tracePath?: string;
    ollamaBaseUrl?: string;
};

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

export interface BacktestSnapshot {
    snapshot_id: number;
    timestamp: number;
    markets: Record<string, MarketEntry>;
    state: StateSnapshot;
}

export interface BacktestRunConfig {
    network: "mainnet" | "testnet";
    start: Date;
    end: Date;
    intervalSeconds: number;
    initialCapitalUsd: number;
    screeningPresetName: string;
    agentPresetName: string;
    screeningConfig: ScreenerConfig;
    agentConfig: AgentConfig;
    policyName: BacktestPolicyName;
    managementPolicyName: "never_close" | "playbook_aware";
    seed: number;
    featureDbPath?: string;
    runId?: string;
    hydration?: HydrationConfig;
    llm?: BacktestLlmConfig;
}

export interface CoverageReport {
    expected_timestamps: number;
    available_timestamps: number;
    missing_feature_rows_by_symbol: Record<string, number>;
    missing_execution_books_by_symbol?: Record<string, number>;
    missing_candle_intervals: Array<{ symbol: string; start: string; end: string }>;
    symbols_dropped_insufficient_history: string[];
    skipped_timestamps: Array<{ ts: string; reason: string }>;
}

export interface ForwardOutcome {
    outcome_5m_bps: number | null;
    outcome_15m_bps: number | null;
    outcome_1h_bps: number | null;
    mfe_15m_bps: number | null;
    mae_15m_bps: number | null;
}

export interface SimPosition {
    id: string;
    symbol: string;
    side: "long" | "short";
    playbook: string;
    entry_ts: Date;
    entry_price: number;
    entry_fee_usd?: number;
    size_fraction: number;
    notional_usd: number;
    size_coin: number;

    stop_loss_pct: number;
    take_profit_pct: number;
    time_stop_minutes?: number;

    entry_regime: unknown;
    entry_signal: {
        ret_sigma_5m_vs_1h: number | null;
        vol_ratio_5m_vs_1h: number | null;
        book_pressure: number | null;
        trend_alignment_score: number | null;
        edge_to_cost_mult: number | null;
    };

    highest_price: number;
    lowest_price: number;
    max_favorable_excursion_bps: number;
    max_adverse_excursion_bps: number;
    opposite_pressure_cycles?: number;

    realized_pnl_usd?: number;
    unrealized_pnl_usd?: number;
}

export interface SimTrade {
    trade_id: string;
    entry_ts: Date;
    exit_ts: Date;
    symbol: string;
    side: "long" | "short";
    playbook: string;
    entry_price: number;
    exit_price: number;
    size_fraction: number;
    notional_usd: number;
    fees_usd: number;
    slippage_bps: number;
    gross_pnl_usd: number;
    net_pnl_usd: number;
    exit_reason: string;
    max_favorable_excursion_bps: number;
    max_adverse_excursion_bps: number;
    entry_regime?: unknown;
}

export interface BacktestMetrics {
    net_pnl_usd: number;
    net_pnl_bps: number;
    max_drawdown_usd: number;
    max_drawdown_bps: number;
    trade_count: number;
    win_rate: number;
    profit_factor: number;
    avg_win_usd: number;
    avg_loss_usd: number;
    avg_trade_net_bps: number;
    turnover_usd: number;
    turnover_cost_usd: number;
    stop_hit_rate: number;
    take_profit_hit_rate: number;
    time_stop_rate: number;
    avg_holding_minutes: number;
    one_symbol_concentration: number;
    one_regime_concentration: number;
    breakdowns: Record<string, Record<string, Partial<BacktestMetrics>>>;
}

export interface BacktestRunResult {
    run_id: string;
    config: BacktestRunConfig;
    coverage: CoverageReport;
    metrics: BacktestMetrics;
    trades: SimTrade[];
    equity_curve: Array<{ ts: Date; equity_usd: number }>;
}

export interface TraderPolicy {
    decide(ctx: TraderContext): Promise<TraderDecision[]>;
}

export interface PositionManagementPolicy {
    decide(position: SimPosition, ctx: TraderContext): TraderDecision;
}

export interface ExecutionDecision {
    decision: TradeDecision;
    riskApproved: boolean;
    riskReason: string;
}

export interface ExecutionResult {
    decision: TradeDecision;
    attempted: boolean;
    success: boolean;
    status: string;
    reason: string;
    symbol: string | null;
    action: string;
    candidate_id?: string | null;
    fill_price?: number | null;
    requested_notional_usd?: number | null;
    filled_notional_usd?: number | null;
    fees_usd?: number | null;
    slippage_bps?: number | null;
    used_book?: boolean;
    trade_id?: string | null;
}
