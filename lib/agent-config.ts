
export interface NetworkProfile {
    name: "testnet" | "mainnet";
    fees_bps: number;
    min_notional_usd: number;
    slippage_model: {
        min_bps: number;
        spread_mult: number;
        depth_mult?: number;
    };
    reliability_penalty: boolean;
}

export interface AgentConfig {
    network_profiles: {
        testnet: NetworkProfile;
        mainnet: NetworkProfile;
    };
    gates: {
        depth_usd_min: number;
        cost_bps_max_by_regime: {
            RISK_ON: number;
            RISK_OFF: number;
            CHOP: number;
        };
        spread_bps_hard_max: number;
        edge_to_cost_mult_by_regime: {
            RISK_ON: number;
            RISK_OFF: number;
            CHOP: number;
        };
        per_symbol_cost_override?: Record<string, number>;
    };
    screener: {
        top_n: number;
        min_volume_24h: number;
        min_oi_usd: number;
        min_depth_usd: number;
        min_vol_ratio_5m_vs_1h: number;
        min_abs_ret_sigma_5m_vs_1h: number;
        quality_weights: {
            vol_score: number;
            move_score: number;
            trend_align: number;
            spread_penalty: number;
            illiquidity_penalty: number;
        };
    };
    risk: {
        max_positions: number;
        max_position_fraction_per_symbol: number;
        max_total_exposure_fraction: number;
        min_trade_notional_usd: number;
        no_flip_same_tick: boolean;
        stop_loss_templates: {
            default: { stop_loss_pct: number; rr_min: number; time_stop_minutes?: number };
            scalp: { stop_loss_pct: number; rr_min: number; time_stop_minutes?: number };
            trend: { stop_loss_pct: number; rr_min: number; time_stop_minutes?: number };
        };
    };
    sentiment_policy: {
        tag_blocklist: string[];
        penalty_multipliers: Record<string, number>;
        decay_windows: Record<string, number>;
    };
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
    network_profiles: {
        testnet: {
            name: "testnet",
            fees_bps: 3.5,
            min_notional_usd: 10.0,
            slippage_model: {
                min_bps: 1.0,
                spread_mult: 0.5,
                depth_mult: 1.0
            },
            reliability_penalty: false
        },
        mainnet: {
            name: "mainnet",
            fees_bps: 3.5, // Adjust if mainnet fees differ
            min_notional_usd: 10.0,
            slippage_model: {
                min_bps: 1.0,
                spread_mult: 0.5,
                depth_mult: 1.0
            },
            reliability_penalty: true
        }
    },
    gates: {
        depth_usd_min: 10_000,
        cost_bps_max_by_regime: {
            RISK_ON: 15,
            RISK_OFF: 10,
            CHOP: 10
        },
        spread_bps_hard_max: 50,
        edge_to_cost_mult_by_regime: {
            RISK_ON: 3.0,
            RISK_OFF: 3.0,
            CHOP: 4.0 // Higher hurdle in chop
        },
        per_symbol_cost_override: {}
    },
    screener: {
        top_n: 20,
        min_volume_24h: 1_000_000,
        min_oi_usd: 500_000,
        min_depth_usd: 10_000,
        min_vol_ratio_5m_vs_1h: 0.5,
        min_abs_ret_sigma_5m_vs_1h: 0.5,
        quality_weights: {
            vol_score: 2.0,
            move_score: 1.0,
            trend_align: 0.5,
            spread_penalty: 1.0,
            illiquidity_penalty: 0.5
        }
    },
    risk: {
        max_positions: 5,
        max_position_fraction_per_symbol: 0.2,
        max_total_exposure_fraction: 1.0,
        min_trade_notional_usd: 10.0,
        no_flip_same_tick: true,
        stop_loss_templates: {
            default: { stop_loss_pct: 0.02, rr_min: 1.5 },
            scalp: { stop_loss_pct: 0.015, rr_min: 1.5, time_stop_minutes: 15 },
            trend: { stop_loss_pct: 0.03, rr_min: 2.0 }
        }
    },
    sentiment_policy: {
        tag_blocklist: ["hack", "exploit", "sec_enforcement", "outage"],
        penalty_multipliers: {
            "negative_news": 0.5,
            "hype": 1.2
        },
        decay_windows: {
            "hack": 3600 * 24, // 24 hours
            "generic": 3600 // 1 hour
        }
    }
};
