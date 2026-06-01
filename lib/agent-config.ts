import { mergePositionManagementConfig } from "@/lib/trader/position-management-policy";
import type { PositionManagementConfig } from "@/lib/trader/position-management-types";

export type PresetLiveMode = "live" | "limited_manual" | "non_live";
export type RiskPlanWidthBps = { sl_bps: number; tp_bps: number };
export type RiskPlanWidthByPlaybook = Record<string, Partial<Record<"RISK_ON" | "RISK_OFF" | "CHOP" | "DEFAULT", RiskPlanWidthBps>>>;

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
        max_width_bps_by_playbook?: RiskPlanWidthByPlaybook;
        min_width_bps_by_playbook?: RiskPlanWidthByPlaybook;
    };

    trade_cooldowns: {
        afterStopLossMinutes: number;
        afterSameSymbolLossMinutes: number;
    };

    strategy_filters: {
        blockMeanReversionOnBbExpansion: boolean;
        playbookBlocklist: string[];
        symbolSideBlocklist: Array<{ symbol: string; side: "long" | "short" }>;
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

    management_policy: {
        hold_confidence: number;
        close_confidence: number;
        playbook_aware: {
            momentum: {
                opposite_pressure_threshold: number;
                opposite_pressure_cycles: number;
                unprofitable_max_age_minutes: number;
            };
            breakout: {
                opposite_pressure_threshold: number;
                unprofitable_max_age_minutes: number;
            };
            mean_reversion: {
                sigma_worsening_threshold: number;
                opposite_pressure_threshold: number;
                unprofitable_max_age_minutes: number;
            };
            fallback: {
                opposite_pressure_threshold: number;
                unprofitable_max_age_minutes: number;
            };
        };
    };

    position_management: PositionManagementConfig;

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

    opportunity?: {
        enabled: boolean;
        minInPlayScore: number;
        minSetupScore: number;
        minNearMissScore: number;
        maxNearMissPerCycle: number;
        journalAllDiscovered: boolean;
        callOnNearMissAuto?: boolean;
        callOnNearMissManual?: boolean;
        includeOpportunityDiagnostics?: boolean;
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
    vol_anchor_priority: ["atr_pct.m5", "realized_vol.m5", "atr_pct.h1", "realized_vol.h1"],
    multipliers_by_playbook: {
        Momentum: { sl_mult: 1.2, tp_mult: 2.6 },
        Breakout: { sl_mult: 1.3, tp_mult: 2.8 },
        "Mean Reversion": { sl_mult: 0.9, tp_mult: 1.8 },
        "Pullback Continuation": { sl_mult: 0.9, tp_mult: 1.9 },
        "Failed Bounce": { sl_mult: 0.8, tp_mult: 1.8 },
        "Failed Breakdown": { sl_mult: 0.8, tp_mult: 1.8 },
        "Capitulation Bounce": { sl_mult: 0.7, tp_mult: 1.4 },
        "Liquidity Grab": { sl_mult: 1.0, tp_mult: 2.0 },
        "Discretionary Edge": { sl_mult: 1.1, tp_mult: 2.2 }
    },
    regime_adjustments: {
        CHOP: { sl_mult_factor: 1.0, tp_mult_factor: 0.85 },
        RISK_ON: { sl_mult_factor: 1.0, tp_mult_factor: 1.1 },
        RISK_OFF: { sl_mult_factor: 1.05, tp_mult_factor: 1.0 }
    },
    max_width_bps_by_playbook: {
        Momentum: {
            RISK_ON: { sl_bps: 120, tp_bps: 240 },
            RISK_OFF: { sl_bps: 100, tp_bps: 180 },
            CHOP: { sl_bps: 80, tp_bps: 120 }
        },
        Breakout: {
            RISK_ON: { sl_bps: 150, tp_bps: 300 },
            RISK_OFF: { sl_bps: 120, tp_bps: 220 },
            CHOP: { sl_bps: 90, tp_bps: 150 }
        },
        "Mean Reversion": {
            RISK_ON: { sl_bps: 80, tp_bps: 120 },
            RISK_OFF: { sl_bps: 70, tp_bps: 100 },
            CHOP: { sl_bps: 50, tp_bps: 80 }
        },
        "Pullback Continuation": {
            DEFAULT: { sl_bps: 90, tp_bps: 180 }
        },
        "Failed Bounce": {
            DEFAULT: { sl_bps: 75, tp_bps: 140 }
        },
        "Failed Breakdown": {
            DEFAULT: { sl_bps: 75, tp_bps: 140 }
        },
        "Capitulation Bounce": {
            DEFAULT: { sl_bps: 50, tp_bps: 85 }
        },
        DEFAULT: {
            DEFAULT: { sl_bps: 100, tp_bps: 200 }
        }
    },
    min_width_bps_by_playbook: {
        "Mean Reversion": {
            CHOP: { sl_bps: 30, tp_bps: 45 },
            RISK_ON: { sl_bps: 35, tp_bps: 55 },
            RISK_OFF: { sl_bps: 30, tp_bps: 45 }
        },
        Momentum: {
            CHOP: { sl_bps: 50, tp_bps: 80 },
            RISK_ON: { sl_bps: 60, tp_bps: 100 },
            RISK_OFF: { sl_bps: 50, tp_bps: 90 }
        },
        "Pullback Continuation": {
            DEFAULT: { sl_bps: 40, tp_bps: 75 }
        },
        "Failed Bounce": {
            DEFAULT: { sl_bps: 35, tp_bps: 65 }
        },
        "Failed Breakdown": {
            DEFAULT: { sl_bps: 35, tp_bps: 65 }
        },
        "Capitulation Bounce": {
            DEFAULT: { sl_bps: 30, tp_bps: 50 }
        },
        DEFAULT: {
            DEFAULT: { sl_bps: 10, tp_bps: 20 }
        }
    }
};

const TRADE_COOLDOWNS: AgentConfig["trade_cooldowns"] = {
    afterStopLossMinutes: 10,
    afterSameSymbolLossMinutes: 8
};

const STRATEGY_FILTERS: AgentConfig["strategy_filters"] = {
    blockMeanReversionOnBbExpansion: false,
    playbookBlocklist: [],
    symbolSideBlocklist: []
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

const MANAGEMENT_POLICY: AgentConfig["management_policy"] = {
    hold_confidence: 0.5,
    close_confidence: 0.65,
    playbook_aware: {
        momentum: {
            opposite_pressure_threshold: 0.08,
            opposite_pressure_cycles: 3,
            unprofitable_max_age_minutes: 180
        },
        breakout: {
            opposite_pressure_threshold: 0.08,
            unprofitable_max_age_minutes: 90
        },
        mean_reversion: {
            sigma_worsening_threshold: 1.0,
            opposite_pressure_threshold: 0.05,
            unprofitable_max_age_minutes: 45
        },
        fallback: {
            opposite_pressure_threshold: 0.03,
            unprofitable_max_age_minutes: 30
        }
    }
};

const SENTIMENT_POLICY: AgentConfig["sentiment_policy"] = {
    tag_blocklist: ["hack", "exploit", "sec_enforcement", "outage"],
    penalty_multipliers: { negative_news: 0.5, hype: 1.2 },
    decay_windows: { hack: 86400, generic: 3600 }
};

const OPPORTUNITY_POLICY: NonNullable<AgentConfig["opportunity"]> = {
    enabled: true,
    minInPlayScore: 60,
    minSetupScore: 70,
    minNearMissScore: 55,
    maxNearMissPerCycle: 5,
    journalAllDiscovered: true,
    callOnNearMissAuto: false,
    callOnNearMissManual: true,
    includeOpportunityDiagnostics: true
};

const BALANCED_PM_RISK_PLAN_MODEL: AgentConfig["risk_plan_model"] = {
    vol_anchor_priority: ["atr_pct.m5", "realized_vol.m5", "atr_pct.h1", "realized_vol.h1"],
    multipliers_by_playbook: {
        Momentum: { sl_mult: 1.0, tp_mult: 2.1 },
        Breakout: { sl_mult: 1.0, tp_mult: 2.2 },
        "Mean Reversion": { sl_mult: 0.8, tp_mult: 1.8 },
        "Pullback Continuation": { sl_mult: 0.9, tp_mult: 1.9 },
        "Failed Bounce": { sl_mult: 0.8, tp_mult: 1.8 },
        "Failed Breakdown": { sl_mult: 0.8, tp_mult: 1.8 },
        "Capitulation Bounce": { sl_mult: 0.7, tp_mult: 1.4 },
        "Liquidity Grab": { sl_mult: 0.8, tp_mult: 1.8 },
        "Discretionary Edge": { sl_mult: 0.9, tp_mult: 2.0 }
    },
    regime_adjustments: {
        CHOP: { sl_mult_factor: 0.9, tp_mult_factor: 0.9 },
        RISK_ON: { sl_mult_factor: 1.0, tp_mult_factor: 1.0 },
        RISK_OFF: { sl_mult_factor: 0.9, tp_mult_factor: 0.9 }
    },
    max_width_bps_by_playbook: {
        Momentum: {
            RISK_ON: { sl_bps: 120, tp_bps: 240 },
            RISK_OFF: { sl_bps: 100, tp_bps: 180 },
            CHOP: { sl_bps: 80, tp_bps: 150 },
            DEFAULT: { sl_bps: 100, tp_bps: 200 }
        },
        Breakout: {
            RISK_ON: { sl_bps: 130, tp_bps: 260 },
            RISK_OFF: { sl_bps: 110, tp_bps: 200 },
            CHOP: { sl_bps: 90, tp_bps: 160 },
            DEFAULT: { sl_bps: 110, tp_bps: 220 }
        },
        "Mean Reversion": {
            RISK_ON: { sl_bps: 60, tp_bps: 100 },
            RISK_OFF: { sl_bps: 45, tp_bps: 75 },
            CHOP: { sl_bps: 45, tp_bps: 80 },
            DEFAULT: { sl_bps: 55, tp_bps: 90 }
        },
        "Pullback Continuation": {
            DEFAULT: { sl_bps: 90, tp_bps: 180 }
        },
        "Failed Bounce": {
            DEFAULT: { sl_bps: 75, tp_bps: 140 }
        },
        "Failed Breakdown": {
            DEFAULT: { sl_bps: 75, tp_bps: 140 }
        },
        "Capitulation Bounce": {
            DEFAULT: { sl_bps: 50, tp_bps: 85 }
        },
        DEFAULT: {
            DEFAULT: { sl_bps: 80, tp_bps: 160 }
        }
    },
    min_width_bps_by_playbook: {
        "Mean Reversion": {
            CHOP: { sl_bps: 30, tp_bps: 45 },
            RISK_ON: { sl_bps: 35, tp_bps: 55 },
            RISK_OFF: { sl_bps: 30, tp_bps: 45 }
        },
        Momentum: {
            CHOP: { sl_bps: 50, tp_bps: 80 },
            RISK_ON: { sl_bps: 60, tp_bps: 100 },
            RISK_OFF: { sl_bps: 50, tp_bps: 90 }
        },
        "Pullback Continuation": {
            DEFAULT: { sl_bps: 40, tp_bps: 75 }
        },
        "Failed Bounce": {
            DEFAULT: { sl_bps: 35, tp_bps: 65 }
        },
        "Failed Breakdown": {
            DEFAULT: { sl_bps: 35, tp_bps: 65 }
        },
        "Capitulation Bounce": {
            DEFAULT: { sl_bps: 30, tp_bps: 50 }
        },
        DEFAULT: {
            DEFAULT: { sl_bps: 10, tp_bps: 20 }
        }
    }
};

const BALANCED_PM_POSITION_MANAGEMENT: PositionManagementConfig = enablePositionRepair({
    enabled: true,
    version: "pm-v2-balanced-20260527",
    global: {
        minAgeBeforeManagementMinutes: 2,
        emergencyMaxLossBps: 100,
        liquidationDistanceMinPct: 8,
        estimatedRoundTripFeeBps: 10,
        exitFeeBufferBps: 7,
        breakevenProfitBufferBps: 4,
        minSecondsBetweenActionsPerPosition: 60,
        blockNewEntriesWhenUrgentExit: true,
        blockNewEntriesWhenPortfolioDrawdown: true,
        staleOrderToleranceBps: 10,
        staleOrderMaxAgeMinutes: 10
    },
    policies: {
        meanReversion: {
            DEFAULT: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 10,
                profitableTimeStopMinutes: 18,
                protectAfterMfeBps: 18,
                breakevenBufferBps: 6,
                partialTakeProfitAfterMfeBps: 35,
                partialCloseFraction: 0.65,
                trailingActivationMfeBps: 50,
                trailingDistanceBps: 20,
                maxGivebackPct: 40,
                hardStopBps: 70,
                maxAllowedTakeProfitBps: 90,
                maxAllowedStopLossBps: 60,
                allowRunner: false,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            CHOP: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 8,
                profitableTimeStopMinutes: 15,
                protectAfterMfeBps: 15,
                breakevenBufferBps: 6,
                partialTakeProfitAfterMfeBps: 28,
                partialCloseFraction: 0.7,
                trailingActivationMfeBps: 45,
                trailingDistanceBps: 18,
                maxGivebackPct: 35,
                hardStopBps: 60,
                maxAllowedTakeProfitBps: 80,
                maxAllowedStopLossBps: 50,
                allowRunner: false,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            RISK_ON: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 10,
                profitableTimeStopMinutes: 18,
                protectAfterMfeBps: 18,
                breakevenBufferBps: 6,
                partialTakeProfitAfterMfeBps: 35,
                partialCloseFraction: 0.65,
                trailingActivationMfeBps: 50,
                trailingDistanceBps: 20,
                maxGivebackPct: 40,
                hardStopBps: 70,
                maxAllowedTakeProfitBps: 110,
                maxAllowedStopLossBps: 70,
                allowRunner: false,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            RISK_OFF: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 6,
                profitableTimeStopMinutes: 12,
                protectAfterMfeBps: 15,
                breakevenBufferBps: 6,
                partialTakeProfitAfterMfeBps: 28,
                partialCloseFraction: 0.8,
                trailingActivationMfeBps: 45,
                trailingDistanceBps: 15,
                maxGivebackPct: 35,
                hardStopBps: 50,
                maxAllowedTakeProfitBps: 80,
                maxAllowedStopLossBps: 50,
                allowRunner: false,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            }
        },
        momentum: {
            DEFAULT: {
                enabled: true,
                minAgeBeforeManagementMinutes: 3,
                discoveryTimeStopMinutes: 25,
                profitableTimeStopMinutes: 45,
                protectAfterMfeBps: 25,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 50,
                partialCloseFraction: 0.4,
                trailingActivationMfeBps: 70,
                trailingDistanceBps: 30,
                maxGivebackPct: 50,
                hardStopBps: 110,
                maxAllowedTakeProfitBps: 180,
                maxAllowedStopLossBps: 100,
                allowRunner: true,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            CHOP: {
                enabled: true,
                minAgeBeforeManagementMinutes: 3,
                discoveryTimeStopMinutes: 12,
                profitableTimeStopMinutes: 22,
                protectAfterMfeBps: 20,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 40,
                partialCloseFraction: 0.6,
                trailingActivationMfeBps: 60,
                trailingDistanceBps: 22,
                maxGivebackPct: 42,
                hardStopBps: 80,
                maxAllowedTakeProfitBps: 120,
                maxAllowedStopLossBps: 80,
                allowRunner: false,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            RISK_ON: {
                enabled: true,
                minAgeBeforeManagementMinutes: 3,
                discoveryTimeStopMinutes: 25,
                profitableTimeStopMinutes: 45,
                protectAfterMfeBps: 25,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 50,
                partialCloseFraction: 0.4,
                trailingActivationMfeBps: 75,
                trailingDistanceBps: 30,
                maxGivebackPct: 50,
                hardStopBps: 120,
                maxAllowedTakeProfitBps: 220,
                maxAllowedStopLossBps: 120,
                allowRunner: true,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: false,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            RISK_OFF: {
                enabled: true,
                minAgeBeforeManagementMinutes: 3,
                discoveryTimeStopMinutes: 20,
                profitableTimeStopMinutes: 35,
                protectAfterMfeBps: 20,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 45,
                partialCloseFraction: 0.5,
                trailingActivationMfeBps: 65,
                trailingDistanceBps: 28,
                maxGivebackPct: 45,
                hardStopBps: 100,
                maxAllowedTakeProfitBps: 180,
                maxAllowedStopLossBps: 100,
                allowRunner: true,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            }
        },
        breakout: {
            DEFAULT: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 15,
                profitableTimeStopMinutes: 35,
                protectAfterMfeBps: 25,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 50,
                partialCloseFraction: 0.5,
                trailingActivationMfeBps: 75,
                trailingDistanceBps: 30,
                maxGivebackPct: 45,
                hardStopBps: 100,
                maxAllowedTakeProfitBps: 180,
                maxAllowedStopLossBps: 100,
                allowRunner: true,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            CHOP: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 10,
                profitableTimeStopMinutes: 20,
                protectAfterMfeBps: 20,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 40,
                partialCloseFraction: 0.6,
                trailingActivationMfeBps: 60,
                trailingDistanceBps: 22,
                maxGivebackPct: 40,
                hardStopBps: 80,
                maxAllowedTakeProfitBps: 120,
                maxAllowedStopLossBps: 80,
                allowRunner: false,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            RISK_ON: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 15,
                profitableTimeStopMinutes: 35,
                protectAfterMfeBps: 25,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 50,
                partialCloseFraction: 0.5,
                trailingActivationMfeBps: 75,
                trailingDistanceBps: 30,
                maxGivebackPct: 45,
                hardStopBps: 100,
                maxAllowedTakeProfitBps: 220,
                maxAllowedStopLossBps: 120,
                allowRunner: true,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: false,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            RISK_OFF: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 12,
                profitableTimeStopMinutes: 30,
                protectAfterMfeBps: 22,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 45,
                partialCloseFraction: 0.55,
                trailingActivationMfeBps: 65,
                trailingDistanceBps: 25,
                maxGivebackPct: 42,
                hardStopBps: 90,
                maxAllowedTakeProfitBps: 180,
                maxAllowedStopLossBps: 100,
                allowRunner: true,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            }
        },
        unknown: {
            DEFAULT: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 12,
                profitableTimeStopMinutes: 20,
                protectAfterMfeBps: 18,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 40,
                partialCloseFraction: 0.6,
                trailingActivationMfeBps: 60,
                trailingDistanceBps: 25,
                maxGivebackPct: 40,
                hardStopBps: 80,
                maxAllowedTakeProfitBps: 120,
                maxAllowedStopLossBps: 80,
                allowRunner: false,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            CHOP: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 10,
                profitableTimeStopMinutes: 18,
                protectAfterMfeBps: 18,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 35,
                partialCloseFraction: 0.7,
                trailingActivationMfeBps: 50,
                trailingDistanceBps: 20,
                maxGivebackPct: 40,
                hardStopBps: 70,
                maxAllowedTakeProfitBps: 100,
                maxAllowedStopLossBps: 70,
                allowRunner: false,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            RISK_ON: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 12,
                profitableTimeStopMinutes: 20,
                protectAfterMfeBps: 20,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 40,
                partialCloseFraction: 0.6,
                trailingActivationMfeBps: 60,
                trailingDistanceBps: 25,
                maxGivebackPct: 45,
                hardStopBps: 80,
                maxAllowedTakeProfitBps: 140,
                maxAllowedStopLossBps: 80,
                allowRunner: false,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            },
            RISK_OFF: {
                enabled: true,
                minAgeBeforeManagementMinutes: 2,
                discoveryTimeStopMinutes: 10,
                profitableTimeStopMinutes: 18,
                protectAfterMfeBps: 18,
                breakevenBufferBps: 7,
                partialTakeProfitAfterMfeBps: 35,
                partialCloseFraction: 0.7,
                trailingActivationMfeBps: 50,
                trailingDistanceBps: 20,
                maxGivebackPct: 40,
                hardStopBps: 70,
                maxAllowedTakeProfitBps: 100,
                maxAllowedStopLossBps: 70,
                allowRunner: false,
                closeOnThesisInvalidation: true,
                closeOnRegimeConflict: true,
                repairMissingStop: false,
                repairStaleTakeProfit: false
            }
        }
    }
});

function enablePositionRepair(config: PositionManagementConfig): PositionManagementConfig {
    const patchedPolicies = Object.fromEntries(
        Object.entries(config.policies).map(([playbook, regimes]) => [
            playbook,
            Object.fromEntries(
                Object.entries(regimes).map(([regime, policy]) => [
                    regime,
                    {
                        ...policy,
                        repairMissingStop: true,
                        repairStaleTakeProfit: true
                    }
                ])
            )
        ])
    ) as PositionManagementConfig["policies"];

    return {
        ...config,
        policies: patchedPolicies
    };
}

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
    risk_plan_model?: Partial<AgentConfig["risk_plan_model"]>;
    strategy_filters?: Partial<AgentConfig["strategy_filters"]>;
    trade_cooldowns?: Partial<AgentConfig["trade_cooldowns"]>;
    position_management?: Partial<PositionManagementConfig>;
    regime?: Partial<AgentConfig["regime"]>;
    management_policy?: Partial<AgentConfig["management_policy"]>;
    sentiment_policy?: Partial<AgentConfig["sentiment_policy"]>;
    gates?: Partial<AgentConfig["gates"]>;
    opportunity?: Partial<NonNullable<AgentConfig["opportunity"]>>;
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
        risk_plan_model: {
            ...RISK_PLAN_MODEL,
            ...input.risk_plan_model,
            vol_anchor_priority: input.risk_plan_model?.vol_anchor_priority ?? RISK_PLAN_MODEL.vol_anchor_priority,
            multipliers_by_playbook: {
                ...RISK_PLAN_MODEL.multipliers_by_playbook,
                ...input.risk_plan_model?.multipliers_by_playbook
            },
            regime_adjustments: {
                ...RISK_PLAN_MODEL.regime_adjustments,
                ...input.risk_plan_model?.regime_adjustments
            },
            max_width_bps_by_playbook: {
                ...RISK_PLAN_MODEL.max_width_bps_by_playbook,
                ...input.risk_plan_model?.max_width_bps_by_playbook
            },
            min_width_bps_by_playbook: {
                ...RISK_PLAN_MODEL.min_width_bps_by_playbook,
                ...input.risk_plan_model?.min_width_bps_by_playbook
            }
        },
        trade_cooldowns: {
            ...TRADE_COOLDOWNS,
            ...input.trade_cooldowns
        },
        strategy_filters: {
            ...STRATEGY_FILTERS,
            ...input.strategy_filters,
            playbookBlocklist: input.strategy_filters?.playbookBlocklist ?? STRATEGY_FILTERS.playbookBlocklist,
            symbolSideBlocklist: input.strategy_filters?.symbolSideBlocklist ?? STRATEGY_FILTERS.symbolSideBlocklist
        },
        triggers: input.triggers,
        cost_sanity: input.cost_sanity,
        correlation: {
            default_group: "CRYPTO_BETA",
            ...input.correlation
        },
        regime: {
            chop: { ...REGIME.chop, ...input.regime?.chop },
            risk_on_off: { ...REGIME.risk_on_off, ...input.regime?.risk_on_off }
        },
        management_policy: {
            ...MANAGEMENT_POLICY,
            ...input.management_policy,
            playbook_aware: {
                momentum: {
                    ...MANAGEMENT_POLICY.playbook_aware.momentum,
                    ...input.management_policy?.playbook_aware?.momentum
                },
                breakout: {
                    ...MANAGEMENT_POLICY.playbook_aware.breakout,
                    ...input.management_policy?.playbook_aware?.breakout
                },
                mean_reversion: {
                    ...MANAGEMENT_POLICY.playbook_aware.mean_reversion,
                    ...input.management_policy?.playbook_aware?.mean_reversion
                },
                fallback: {
                    ...MANAGEMENT_POLICY.playbook_aware.fallback,
                    ...input.management_policy?.playbook_aware?.fallback
                }
            }
        },
        position_management: mergePositionManagementConfig(input.position_management),
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
        sentiment_policy: {
            ...SENTIMENT_POLICY,
            ...input.sentiment_policy,
            tag_blocklist: input.sentiment_policy?.tag_blocklist ?? SENTIMENT_POLICY.tag_blocklist,
            penalty_multipliers: {
                ...SENTIMENT_POLICY.penalty_multipliers,
                ...input.sentiment_policy?.penalty_multipliers
            },
            decay_windows: {
                ...SENTIMENT_POLICY.decay_windows,
                ...input.sentiment_policy?.decay_windows
            }
        },
        opportunity: {
            ...OPPORTUNITY_POLICY,
            ...input.opportunity
        }
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
    "Balanced PM v2": preset({
        name: "Balanced PM v2",
        mode: "live",
        risk: {
            max_positions: 3,
            max_position_fraction: 0.05,
            max_position_fraction_per_symbol: 0.05,
            max_total_exposure_fraction: 0.20,
            min_trade_notional_usd: 10,
            no_flip_same_tick: true,
            max_new_positions_per_cycle: 1,
            daily_loss_kill_switch_fraction: 0.0125,
            risk_per_trade_pct: 0.0015,
            max_effective_leverage: 2,
            exchange_max_leverage_allowed: 2,
            max_correlation_group_exposure_fraction: 0.20,
            margin_mode: "isolated",
            default_leverage: 1,
            slippage_pct: 0.0025,
            stop_loss_templates: {
                default: { stop_loss_pct: 0.01, rr_min: 1.5, time_stop_minutes: 20 },
                scalp: { stop_loss_pct: 0.008, rr_min: 1.5, time_stop_minutes: 12 },
                trend: { stop_loss_pct: 0.015, rr_min: 1.8, time_stop_minutes: 45 }
            }
        },
        triggers: {
            momentum: { book_pressure_min: 0.22, vol_ratio_min: 0.75, trend_aligned_required: true },
            mean_reversion: { ret_sigma_threshold: 3.2, book_pressure_min: 0.12, chop_regime: "required" },
            breakout: { vol_ratio_min: 1.7, book_pressure_min: 0.30 }
        },
        cost_sanity: {
            min_edge_to_cost_mult: 4.2,
            min_stop_to_cost_mult: 2.0,
            min_tp_to_cost_mult: 3.0
        },
        risk_plan_model: BALANCED_PM_RISK_PLAN_MODEL,
        strategy_filters: {
            blockMeanReversionOnBbExpansion: true,
            playbookBlocklist: ["Mean Reversion:short"],
            symbolSideBlocklist: [
                { symbol: "NEAR-PERP", side: "short" },
                { symbol: "TON-PERP", side: "short" },
                { symbol: "HYPE-PERP", side: "long" },
                { symbol: "WLD-PERP", side: "short" },
                { symbol: "ZEC-PERP", side: "short" },
                { symbol: "TAO-PERP", side: "long" }
            ]
        },
        position_management: BALANCED_PM_POSITION_MANAGEMENT,
        correlation: {
            corr_gt_050_multiplier: 0.65,
            corr_gt_070_multiplier: 0.4,
            corr_gt_085_multiplier: 0.2,
            risk_off_corr_addon: 0.2
        },
        regime: {
            chop: {
                max_new_positions_per_cycle_mult: 0.5,
                confidence_threshold_mult: 1.3,
                tp_sl_mult: 0.8
            },
            risk_on_off: {
                sizing_mult: 1.0
            }
        },
        management_policy: {
            hold_confidence: 0.5,
            close_confidence: 0.8,
            playbook_aware: {
                momentum: {
                    opposite_pressure_threshold: 0.08,
                    opposite_pressure_cycles: 2,
                    unprofitable_max_age_minutes: 45
                },
                breakout: {
                    opposite_pressure_threshold: 0.08,
                    unprofitable_max_age_minutes: 30
                },
                mean_reversion: {
                    sigma_worsening_threshold: 0.75,
                    opposite_pressure_threshold: 0.05,
                    unprofitable_max_age_minutes: 12
                },
                fallback: {
                    opposite_pressure_threshold: 0.03,
                    unprofitable_max_age_minutes: 20
                }
            }
        },
        gates: {
            depth_usd_min: 50_000,
            cost_bps_max_by_regime: { RISK_ON: 14, RISK_OFF: 10, CHOP: 12 },
            edge_to_cost_mult_by_regime: { RISK_ON: 4.2, RISK_OFF: 5.5, CHOP: 4.8 },
            per_symbol_cost_override: {}
        },
        sentiment_policy: {
            tag_blocklist: ["hack", "exploit", "sec_enforcement", "outage"],
            penalty_multipliers: {
                negative_news: 0.5,
                hype: 1.0
            },
            decay_windows: {
                hack: 86400,
                generic: 3600
            }
        }
    }),
    optimized: preset({
        name: "optimized",
        mode: "live",
        risk: {
            max_positions: 4,
            max_position_fraction: 0.15,
            max_position_fraction_per_symbol: 0.15,
            max_total_exposure_fraction: 0.75,
            min_trade_notional_usd: 10,
            no_flip_same_tick: true,
            max_new_positions_per_cycle: 2,
            daily_loss_kill_switch_fraction: 0.05,
            risk_per_trade_pct: 0.0035,
            max_effective_leverage: 19,
            exchange_max_leverage_allowed: 4,
            max_correlation_group_exposure_fraction: 0.45,
            margin_mode: "isolated",
            default_leverage: 4,
            slippage_pct: 0.005
        },
        triggers: {
            momentum: {
                book_pressure_min: 0.15657537704774804,
                vol_ratio_min: 0.6488422572742718,
                trend_aligned_required: true
            },
            mean_reversion: {
                ret_sigma_threshold: 2.2296151197695444,
                book_pressure_min: 0.044192874086290274,
                chop_regime: "required"
            },
            breakout: {
                vol_ratio_min: 1.6240604479443594,
                book_pressure_min: 0.21235336480578654
            }
        },
        cost_sanity: {
            min_edge_to_cost_mult: 4.841944297848045,
            min_stop_to_cost_mult: 2.6718925351113336,
            min_tp_to_cost_mult: 4.189168577384884
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
            edge_to_cost_mult_by_regime: {
                RISK_ON: 4.841944297848045,
                RISK_OFF: 5.841944297848045,
                CHOP: 4.841944297848045
            }
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
        risk_plan_model: {
            vol_anchor_priority: ["edge.expected_move_bps", "atr_pct.m5", "realized_vol.m5", "atr_pct.h1", "realized_vol.h1"],
            max_width_bps_by_playbook: {
                Momentum: {
                    RISK_ON: { sl_bps: 2000, tp_bps: 2500 },
                    RISK_OFF: { sl_bps: 2000, tp_bps: 2500 },
                    CHOP: { sl_bps: 2000, tp_bps: 2500 }
                },
                Breakout: {
                    RISK_ON: { sl_bps: 2000, tp_bps: 2500 },
                    RISK_OFF: { sl_bps: 2000, tp_bps: 2500 },
                    CHOP: { sl_bps: 2000, tp_bps: 2500 }
                },
                "Mean Reversion": {
                    RISK_ON: { sl_bps: 2000, tp_bps: 2500 },
                    RISK_OFF: { sl_bps: 2000, tp_bps: 2500 },
                    CHOP: { sl_bps: 2000, tp_bps: 2500 }
                }
            }
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
