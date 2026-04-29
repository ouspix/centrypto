export type PresetLiveMode = "live" | "limited_manual" | "non_live";

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
    preset_name?: string;
    preset_live_mode?: PresetLiveMode;

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
        risk_per_trade_pct: number;
        // Effective leverage means notional / equity and is used for sizing.
        max_effective_leverage: number;
        // Exchange setting used for margin configuration, not as a sizing input.
        exchange_max_leverage_allowed: number;
        max_correlation_group_exposure_fraction: number;
        margin_mode: "isolated" | "cross";
        default_leverage?: number;
        slippage_pct?: number;

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

    // C. Signal sensitivity (deterministic trigger thresholds)
    triggers: {
        momentum: {
            book_pressure_min: number;
            vol_ratio_min: number;
            trend_aligned_required: boolean;
        };
        mean_reversion: {
            ret_sigma_threshold: number;
            book_pressure_min: number;
            chop_regime: "required" | "preferred" | "none";
        };
        breakout: {
            vol_ratio_min: number;
            book_pressure_min: number;
        };
    };

    cost_sanity: {
        min_edge_to_cost_mult: number;
        min_stop_to_cost_mult: number;
        min_tp_to_cost_mult: number;
    };

    correlation: {
        default_group: string;
        corr_gt_050_multiplier: number;
        corr_gt_070_multiplier: number;
        corr_gt_085_multiplier: number;
        risk_off_corr_addon: number;
    };

    regime: {
        chop: {
            max_new_positions_per_cycle_mult: number;
            confidence_threshold_mult: number;
            tp_sl_mult: number;
        };
        risk_on_off: {
            sizing_mult: number;
        };
    };

    gates: {
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

const NETWORK_PROFILES: AgentConfig["network_profiles"] = {
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
};

const RISK_PLAN_MODEL: AgentConfig["risk_plan_model"] = {
    vol_anchor_priority: ["edge.expected_move_bps", "atr_pct.m5", "atr_pct.h1", "realized_vol.m5"],
    multipliers_by_playbook: {
        Momentum: { sl_mult: 1.2, tp_mult: 2.6 },
        Breakout: { sl_mult: 1.3, tp_mult: 2.8 },
        "Mean Reversion": { sl_mult: 0.9, tp_mult: 1.8 },
        "Liquidity Grab": { sl_mult: 1.0, tp_mult: 2.0 },
        "Discretionary Edge": { sl_mult: 1.1, tp_mult: 2.2 }
    },
    regime_adjustments: {
        CHOP: { sl_mult_factor: 1.0, tp_mult_factor: 0.85 },
        RISK_ON: { sl_mult_factor: 1.0, tp_mult_factor: 1.1 },
        RISK_OFF: { sl_mult_factor: 1.05, tp_mult_factor: 1.0 }
    }
};

const REGIME: AgentConfig["regime"] = {
    chop: {
        max_new_positions_per_cycle_mult: 0.5,
        confidence_threshold_mult: 1.2,
        tp_sl_mult: 0.8
    },
    risk_on_off: {
        sizing_mult: 1.2
    }
};

const SENTIMENT_POLICY: AgentConfig["sentiment_policy"] = {
    tag_blocklist: ["hack", "exploit", "sec_enforcement", "outage"],
    penalty_multipliers: { negative_news: 0.5, hype: 1.2 },
    decay_windows: { hack: 86400, generic: 3600 }
};

function baseRisk(): AgentConfig["risk"] {
    return {
        max_positions: 5,
        max_position_fraction: 0.20,
        max_position_fraction_per_symbol: 0.20,
        max_total_exposure_fraction: 1.00,
        min_trade_notional_usd: 10,
        no_flip_same_tick: true,
        max_new_positions_per_cycle: 2,
        daily_loss_kill_switch_fraction: 0.05,
        risk_per_trade_pct: 0.005,
        max_effective_leverage: 8,
        exchange_max_leverage_allowed: 8,
        max_correlation_group_exposure_fraction: 0.50,
        margin_mode: "isolated",
        default_leverage: 1,
        slippage_pct: 0.005,
        stop_loss_templates: {
            default: { stop_loss_pct: 0.02, rr_min: 1.5 },
            scalp: { stop_loss_pct: 0.015, rr_min: 1.5, time_stop_minutes: 15 },
            trend: { stop_loss_pct: 0.03, rr_min: 2.0 }
        }
    };
}

function preset(input: {
    name: string;
    mode: PresetLiveMode;
    risk: Partial<AgentConfig["risk"]>;
    triggers: AgentConfig["triggers"];
    cost_sanity: AgentConfig["cost_sanity"];
    correlation: Omit<AgentConfig["correlation"], "default_group">;
    gates?: Partial<AgentConfig["gates"]>;
}): AgentConfig {
    const risk = { ...baseRisk(), ...input.risk };
    risk.max_position_fraction = risk.max_position_fraction ?? risk.max_position_fraction_per_symbol;
    risk.max_position_fraction_per_symbol = risk.max_position_fraction_per_symbol ?? risk.max_position_fraction;
    risk.exchange_max_leverage_allowed = risk.exchange_max_leverage_allowed ?? risk.max_effective_leverage;

    const minEdge = input.cost_sanity.min_edge_to_cost_mult;
    const defaultGates: AgentConfig["gates"] = {
        depth_usd_min: 10_000,
        cost_bps_max_by_regime: { RISK_ON: 15, RISK_OFF: 10, CHOP: 10 },
        edge_to_cost_mult_by_regime: { RISK_ON: minEdge, RISK_OFF: minEdge, CHOP: minEdge },
        per_symbol_cost_override: {}
    };

    return {
        preset_name: input.name,
        preset_live_mode: input.mode,
        network_profiles: NETWORK_PROFILES,
        risk,
        risk_plan_model: RISK_PLAN_MODEL,
        triggers: input.triggers,
        cost_sanity: input.cost_sanity,
        correlation: {
            default_group: "CRYPTO_BETA",
            ...input.correlation
        },
        regime: REGIME,
        gates: {
            ...defaultGates,
            ...input.gates,
            cost_bps_max_by_regime: {
                ...defaultGates.cost_bps_max_by_regime,
                ...input.gates?.cost_bps_max_by_regime
            },
            edge_to_cost_mult_by_regime: {
                ...defaultGates.edge_to_cost_mult_by_regime,
                ...input.gates?.edge_to_cost_mult_by_regime
            },
            per_symbol_cost_override: input.gates?.per_symbol_cost_override ?? defaultGates.per_symbol_cost_override
        },
        sentiment_policy: SENTIMENT_POLICY
    };
}

export const AGENT_PRESETS: Record<string, AgentConfig> = {
    "Scalper Strict": preset({
        name: "Scalper Strict",
        mode: "live",
        risk: {
            max_positions: 3,
            max_position_fraction: 0.10,
            max_position_fraction_per_symbol: 0.10,
            max_total_exposure_fraction: 0.50,
            min_trade_notional_usd: 50,
            max_new_positions_per_cycle: 1,
            daily_loss_kill_switch_fraction: 0.03,
            risk_per_trade_pct: 0.0025,
            max_effective_leverage: 5,
            exchange_max_leverage_allowed: 5,
            max_correlation_group_exposure_fraction: 0.30,
            margin_mode: "isolated",
            slippage_pct: 0.003
        },
        triggers: {
            momentum: { book_pressure_min: 0.35, vol_ratio_min: 1.4, trend_aligned_required: true },
            mean_reversion: { ret_sigma_threshold: 3.5, book_pressure_min: 0.20, chop_regime: "required" },
            breakout: { vol_ratio_min: 2.2, book_pressure_min: 0.45 }
        },
        cost_sanity: {
            min_edge_to_cost_mult: 5.0,
            min_stop_to_cost_mult: 2.5,
            min_tp_to_cost_mult: 4.0
        },
        correlation: {
            corr_gt_050_multiplier: 0.75,
            corr_gt_070_multiplier: 0.50,
            corr_gt_085_multiplier: 0.25,
            risk_off_corr_addon: 0.15
        },
        gates: {
            depth_usd_min: 75_000,
            cost_bps_max_by_regime: { RISK_ON: 12, RISK_OFF: 9, CHOP: 9 },
            edge_to_cost_mult_by_regime: { RISK_ON: 5, RISK_OFF: 6, CHOP: 5 }
        }
    }),
    "Momentum Moderate": preset({
        name: "Momentum Moderate",
        mode: "live",
        risk: {
            max_positions: 4,
            max_position_fraction: 0.15,
            max_position_fraction_per_symbol: 0.15,
            max_total_exposure_fraction: 0.75,
            min_trade_notional_usd: 10,
            max_new_positions_per_cycle: 2,
            daily_loss_kill_switch_fraction: 0.05,
            risk_per_trade_pct: 0.0035,
            max_effective_leverage: 3,
            exchange_max_leverage_allowed: 5,
            max_correlation_group_exposure_fraction: 0.45,
            margin_mode: "isolated",
            slippage_pct: 0.005
        },
        triggers: {
            momentum: { book_pressure_min: 0.25, vol_ratio_min: 1.0, trend_aligned_required: true },
            mean_reversion: { ret_sigma_threshold: 2.5, book_pressure_min: 0.05, chop_regime: "required" },
            breakout: { vol_ratio_min: 1.8, book_pressure_min: 0.35 }
        },
        cost_sanity: {
            min_edge_to_cost_mult: 4.0,
            min_stop_to_cost_mult: 2.0,
            min_tp_to_cost_mult: 3.0
        },
        correlation: {
            corr_gt_050_multiplier: 0.75,
            corr_gt_070_multiplier: 0.50,
            corr_gt_085_multiplier: 0.25,
            risk_off_corr_addon: 0.15
        },
        gates: {
            depth_usd_min: 25_000,
            cost_bps_max_by_regime: { RISK_ON: 18, RISK_OFF: 12, CHOP: 14 },
            edge_to_cost_mult_by_regime: { RISK_ON: 4, RISK_OFF: 5, CHOP: 4 }
        }
    }),
    "Swing Relaxed": preset({
        name: "Swing Relaxed",
        mode: "limited_manual",
        risk: {
            max_positions: 6,
            max_position_fraction: 0.20,
            max_position_fraction_per_symbol: 0.20,
            max_total_exposure_fraction: 1.00,
            min_trade_notional_usd: 10,
            max_new_positions_per_cycle: 2,
            daily_loss_kill_switch_fraction: 0.07,
            risk_per_trade_pct: 0.005,
            max_effective_leverage: 3,
            exchange_max_leverage_allowed: 4,
            max_correlation_group_exposure_fraction: 0.60,
            margin_mode: "isolated",
            slippage_pct: 0.008
        },
        triggers: {
            momentum: { book_pressure_min: 0.15, vol_ratio_min: 0.8, trend_aligned_required: true },
            mean_reversion: { ret_sigma_threshold: 2.5, book_pressure_min: 0.10, chop_regime: "preferred" },
            breakout: { vol_ratio_min: 1.5, book_pressure_min: 0.25 }
        },
        cost_sanity: {
            min_edge_to_cost_mult: 3.0,
            min_stop_to_cost_mult: 1.5,
            min_tp_to_cost_mult: 2.5
        },
        correlation: {
            corr_gt_050_multiplier: 0.85,
            corr_gt_070_multiplier: 0.65,
            corr_gt_085_multiplier: 0.40,
            risk_off_corr_addon: 0.15
        },
        gates: {
            depth_usd_min: 15_000,
            cost_bps_max_by_regime: { RISK_ON: 25, RISK_OFF: 18, CHOP: 20 },
            edge_to_cost_mult_by_regime: { RISK_ON: 3, RISK_OFF: 4, CHOP: 3 }
        }
    }),
    "LLM Permissive": preset({
        name: "LLM Permissive",
        mode: "limited_manual",
        risk: {
            max_positions: 8,
            max_position_fraction: 0.02,
            max_position_fraction_per_symbol: 0.02,
            max_total_exposure_fraction: 0.16,
            min_trade_notional_usd: 10,
            max_new_positions_per_cycle: 8,
            daily_loss_kill_switch_fraction: 0.03,
            risk_per_trade_pct: 0.005,
            max_effective_leverage: 1,
            exchange_max_leverage_allowed: 1,
            max_correlation_group_exposure_fraction: 0.16,
            margin_mode: "isolated",
            default_leverage: 1,
            slippage_pct: 0.005
        },
        triggers: {
            momentum: { book_pressure_min: 0, vol_ratio_min: 0.10, trend_aligned_required: false },
            mean_reversion: { ret_sigma_threshold: 0, book_pressure_min: 0, chop_regime: "none" },
            breakout: { vol_ratio_min: 0.10, book_pressure_min: 0 }
        },
        cost_sanity: {
            min_edge_to_cost_mult: 6.0,
            min_stop_to_cost_mult: 1.54,
            min_tp_to_cost_mult: 2.5
        },
        correlation: {
            corr_gt_050_multiplier: 1.0,
            corr_gt_070_multiplier: 1.0,
            corr_gt_085_multiplier: 1.0,
            risk_off_corr_addon: 0
        },
        gates: {
            depth_usd_min: 20_000,
            cost_bps_max_by_regime: { RISK_ON: 20, RISK_OFF: 14, CHOP: 20 },
            edge_to_cost_mult_by_regime: { RISK_ON: 6.0, RISK_OFF: 6.0, CHOP: 6.0 }
        }
    }),
    "Testnet Aggressive": preset({
        name: "Testnet Aggressive",
        mode: "non_live",
        risk: {
            max_positions: 10,
            max_position_fraction: 0.50,
            max_position_fraction_per_symbol: 0.50,
            max_total_exposure_fraction: 3.00,
            min_trade_notional_usd: 1,
            max_new_positions_per_cycle: 4,
            daily_loss_kill_switch_fraction: 0.20,
            risk_per_trade_pct: 0.02,
            max_effective_leverage: 20,
            exchange_max_leverage_allowed: 20,
            max_correlation_group_exposure_fraction: 3.00,
            margin_mode: "isolated",
            slippage_pct: 0.05
        },
        triggers: {
            momentum: { book_pressure_min: 0.05, vol_ratio_min: 0.5, trend_aligned_required: false },
            mean_reversion: { ret_sigma_threshold: 1.5, book_pressure_min: 0.01, chop_regime: "none" },
            breakout: { vol_ratio_min: 1.0, book_pressure_min: 0.10 }
        },
        cost_sanity: {
            min_edge_to_cost_mult: 0.25,
            min_stop_to_cost_mult: 0.25,
            min_tp_to_cost_mult: 0.5
        },
        correlation: {
            corr_gt_050_multiplier: 1.0,
            corr_gt_070_multiplier: 1.0,
            corr_gt_085_multiplier: 1.0,
            risk_off_corr_addon: 0
        },
        gates: {
            depth_usd_min: 0,
            cost_bps_max_by_regime: { RISK_ON: 500, RISK_OFF: 500, CHOP: 500 },
            edge_to_cost_mult_by_regime: { RISK_ON: 0.25, RISK_OFF: 0.25, CHOP: 0.25 }
        }
    })
};

export const AGENT_PRESET_MODES: Record<string, PresetLiveMode> = Object.fromEntries(
    Object.entries(AGENT_PRESETS).map(([name, cfg]) => [name, cfg.preset_live_mode || "live"])
) as Record<string, PresetLiveMode>;

// Strong default recommendation: Momentum Moderate.
export const DEFAULT_AGENT_CONFIG: AgentConfig = AGENT_PRESETS["Momentum Moderate"];
