
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

    // A. Portfolio constraints (hard rules)
    risk: {
        max_positions: number;
        max_position_fraction: number;
        max_position_fraction_per_symbol: number;
        max_total_exposure_fraction: number;
        min_trade_notional_usd: number;
        no_flip_same_tick: boolean;
        max_new_positions_per_cycle: number;
        daily_loss_kill_switch_fraction: number;
        // Target leverage used for risk plan sizing when no position leverage is known
        default_leverage?: number;
        // Slippage ceiling for limit orders (fraction, e.g. 0.005 = 0.5%).
        // Wider values guarantee fills; tighter values preserve edge on mainnet.
        slippage_pct?: number;

        // Stop Loss Templates (kept for reference/defaults)
        stop_loss_templates: {
            default: { stop_loss_pct: number; rr_min: number; time_stop_minutes?: number };
            scalp: { stop_loss_pct: number; rr_min: number; time_stop_minutes?: number };
            trend: { stop_loss_pct: number; rr_min: number; time_stop_minutes?: number };
        };
    };

    // B. Risk plan model (deterministic SL/TP computation)
    risk_plan_model: {
        vol_anchor_priority: string[];
        multipliers_by_playbook: Record<string, { sl_mult: number; tp_mult: number }>;
        regime_adjustments: Record<string, { sl_mult_factor: number; tp_mult_factor: number }>;
    };

    // C. Signal sensitivity (soft thresholds)
    triggers: {
        momentum: {
            book_pressure_min: number;
            vol_ratio_min: number;
        };
        mean_reversion: {
            ret_sigma_threshold: number;
            book_pressure_min: number;
        };
        breakout: {
            vol_ratio_min: number;
            book_pressure_min: number;
        };
    };

    // C. Regime handling (policy knobs)
    regime: {
        chop: {
            max_new_positions_per_cycle_mult: number; // e.g. 0.5x
            confidence_threshold_mult: number; // e.g. 1.2x
            tp_sl_mult: number; // e.g. 0.8x
        };
        risk_on_off: {
            sizing_mult: number; // e.g. 1.2x for risk_on
        };
    };

    // Legacy/Other
    gates: {
        // Kept for compatibility if needed, but logic moving to Screener or Risk
        depth_usd_min: number;
        cost_bps_max_by_regime: {
            RISK_ON: number;
            RISK_OFF: number;
            CHOP: number;
        };
        edge_to_cost_mult_by_regime: {
            RISK_ON: number;
            RISK_OFF: number;
            CHOP: number;
        };
        per_symbol_cost_override?: Record<string, number>;
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
            slippage_model: { min_bps: 1.0, spread_mult: 0.5, depth_mult: 1.0 },
            reliability_penalty: false
        },
        mainnet: {
            name: "mainnet",
            fees_bps: 3.5,
            min_notional_usd: 10.0,
            slippage_model: { min_bps: 1.0, spread_mult: 0.5, depth_mult: 1.0 },
            reliability_penalty: true
        }
    },
    risk: {
        max_positions: 3,
        max_position_fraction: 0.10,
        max_position_fraction_per_symbol: 0.10,
        max_total_exposure_fraction: 0.50,
        min_trade_notional_usd: 50,
        no_flip_same_tick: true,
        max_new_positions_per_cycle: 1,
        daily_loss_kill_switch_fraction: 0.03,
        default_leverage: 1,
        slippage_pct: 0.005, // 0.5% — mainnet default: tight to preserve scalp edge
        stop_loss_templates: {
            default: { stop_loss_pct: 0.02, rr_min: 1.5 },
            scalp: { stop_loss_pct: 0.015, rr_min: 1.5, time_stop_minutes: 15 },
            trend: { stop_loss_pct: 0.03, rr_min: 2.0 }
        }
    },
    risk_plan_model: {
        vol_anchor_priority: ["edge.expected_move_bps", "atr_pct.m5", "atr_pct.h1", "realized_vol.m5"],
        multipliers_by_playbook: {
            Momentum: { sl_mult: 1.2, tp_mult: 2.6 },
            "Breakout/Squeeze": { sl_mult: 1.3, tp_mult: 2.8 },
            "Mean Reversion": { sl_mult: 0.9, tp_mult: 1.8 },
            "Liquidity Grab": { sl_mult: 1.0, tp_mult: 2.0 },
            "Discretionary Edge": { sl_mult: 1.1, tp_mult: 2.2 }
        },
        regime_adjustments: {
            CHOP: { sl_mult_factor: 1.0, tp_mult_factor: 0.85 },
            RISK_ON: { sl_mult_factor: 1.0, tp_mult_factor: 1.1 },
            RISK_OFF: { sl_mult_factor: 1.05, tp_mult_factor: 1.0 }
        }
    },
    triggers: {
        momentum: { book_pressure_min: 0.35, vol_ratio_min: 1.4 },
        mean_reversion: { ret_sigma_threshold: 3.5, book_pressure_min: 0.15 },
        breakout: { vol_ratio_min: 2.2, book_pressure_min: 0.45 }
    },
    regime: {
        chop: {
            max_new_positions_per_cycle_mult: 0.5,
            confidence_threshold_mult: 1.2,
            tp_sl_mult: 0.8
        },
        risk_on_off: {
            sizing_mult: 1.2
        }
    },
    gates: {
        depth_usd_min: 10_000,
        cost_bps_max_by_regime: { RISK_ON: 15, RISK_OFF: 10, CHOP: 10 },
        edge_to_cost_mult_by_regime: { RISK_ON: 3.0, RISK_OFF: 3.0, CHOP: 4.0 },
        per_symbol_cost_override: {}
    },
    sentiment_policy: {
        tag_blocklist: ["hack", "exploit", "sec_enforcement", "outage"],
        penalty_multipliers: { "negative_news": 0.5, "hype": 1.2 },
        decay_windows: { "hack": 86400, "generic": 3600 }
    }
};

export const AGENT_PRESETS: Record<string, Partial<AgentConfig>> = {
    "Scalper Strict": {
        risk: {
            ...DEFAULT_AGENT_CONFIG.risk,
            max_positions: 3,
            max_position_fraction: 0.10,
            max_position_fraction_per_symbol: 0.10,
            max_total_exposure_fraction: 0.50,
            min_trade_notional_usd: 50,
            no_flip_same_tick: true,
            max_new_positions_per_cycle: 1,
            daily_loss_kill_switch_fraction: 0.03,
            slippage_pct: 0.003 // 0.3% — scalper: tightest, every bp counts
        },
        triggers: {
            momentum: { book_pressure_min: 0.35, vol_ratio_min: 1.4 },
            mean_reversion: { ret_sigma_threshold: 3.5, book_pressure_min: 0.15 },
            breakout: { vol_ratio_min: 2.2, book_pressure_min: 0.45 }
        }
    },
    "Momentum Moderate": {
        risk: {
            ...DEFAULT_AGENT_CONFIG.risk,
            max_positions: 5,
            max_position_fraction: 0.20,
            max_position_fraction_per_symbol: 0.20,
            max_total_exposure_fraction: 1.00,
            min_trade_notional_usd: 10,
            no_flip_same_tick: true,
            max_new_positions_per_cycle: 2,
            daily_loss_kill_switch_fraction: 0.05,
            slippage_pct: 0.005 // 0.5% — moderate fills
        },
        triggers: {
            momentum: { book_pressure_min: 0.20, vol_ratio_min: 1.0 },
            mean_reversion: { ret_sigma_threshold: 3.0, book_pressure_min: 0.10 },
            breakout: { vol_ratio_min: 1.8, book_pressure_min: 0.30 }
        }
    },
    "Swing Relaxed": {
        risk: {
            ...DEFAULT_AGENT_CONFIG.risk,
            max_positions: 8,
            max_position_fraction: 0.25,
            max_position_fraction_per_symbol: 0.25,
            max_total_exposure_fraction: 1.50,
            min_trade_notional_usd: 5,
            no_flip_same_tick: false,
            max_new_positions_per_cycle: 2,
            daily_loss_kill_switch_fraction: 0.07,
            slippage_pct: 0.008 // 0.8% — swing: wider entries acceptable
        },
        triggers: {
            momentum: { book_pressure_min: 0.10, vol_ratio_min: 0.8 },
            mean_reversion: { ret_sigma_threshold: 2.5, book_pressure_min: 0.05 },
            breakout: { vol_ratio_min: 1.5, book_pressure_min: 0.20 }
        }
    },
    "Testnet Aggressive": {
        risk: {
            ...DEFAULT_AGENT_CONFIG.risk,
            max_positions: 10,
            max_position_fraction: 0.50,
            max_position_fraction_per_symbol: 0.50,
            max_total_exposure_fraction: 3.00,
            min_trade_notional_usd: 1,
            no_flip_same_tick: false,
            max_new_positions_per_cycle: 4,
            daily_loss_kill_switch_fraction: 0.20,
            slippage_pct: 0.05 // 5% — testnet: fill guarantee over precision
        },
        triggers: {
            momentum: { book_pressure_min: 0.05, vol_ratio_min: 0.5 },
            mean_reversion: { ret_sigma_threshold: 1.5, book_pressure_min: 0.01 },
            breakout: { vol_ratio_min: 1.0, book_pressure_min: 0.10 }
        }
    }
};
