
import React, { useState, useEffect } from "react";
import { AgentConfig, DEFAULT_AGENT_CONFIG, AGENT_PRESETS } from "@/lib/agent-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LabelWithTooltip } from "@/components/ui/label-with-tooltip";
import { Save, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";

interface ConfigEditorProps {
    initialConfig?: AgentConfig;
    initialPreset?: string;
    onSave: (config: AgentConfig, presetName: string) => void | Promise<void>;
    onCancel: () => void;
}

const cloneConfig = (value: AgentConfig): AgentConfig => JSON.parse(JSON.stringify(value));

function mergeEditorConfig(initialConfig?: AgentConfig): AgentConfig {
    const merged: AgentConfig = {
        ...DEFAULT_AGENT_CONFIG,
        ...initialConfig,
        triggers: {
            momentum: { ...DEFAULT_AGENT_CONFIG.triggers.momentum, ...(initialConfig?.triggers?.momentum || {}) },
            mean_reversion: { ...DEFAULT_AGENT_CONFIG.triggers.mean_reversion, ...(initialConfig?.triggers?.mean_reversion || {}) },
            breakout: { ...DEFAULT_AGENT_CONFIG.triggers.breakout, ...(initialConfig?.triggers?.breakout || {}) }
        },
        risk: {
            ...DEFAULT_AGENT_CONFIG.risk,
            ...(initialConfig?.risk || {})
        },
        cost_sanity: {
            ...DEFAULT_AGENT_CONFIG.cost_sanity,
            ...(initialConfig?.cost_sanity || {})
        },
        correlation: {
            ...DEFAULT_AGENT_CONFIG.correlation,
            ...(initialConfig?.correlation || {})
        },
        regime: {
            chop: { ...DEFAULT_AGENT_CONFIG.regime.chop, ...(initialConfig?.regime?.chop || {}) },
            risk_on_off: { ...DEFAULT_AGENT_CONFIG.regime.risk_on_off, ...(initialConfig?.regime?.risk_on_off || {}) }
        },
        management_policy: {
            ...DEFAULT_AGENT_CONFIG.management_policy,
            ...(initialConfig?.management_policy || {}),
            playbook_aware: {
                momentum: {
                    ...DEFAULT_AGENT_CONFIG.management_policy.playbook_aware.momentum,
                    ...(initialConfig?.management_policy?.playbook_aware?.momentum || {})
                },
                breakout: {
                    ...DEFAULT_AGENT_CONFIG.management_policy.playbook_aware.breakout,
                    ...(initialConfig?.management_policy?.playbook_aware?.breakout || {})
                },
                mean_reversion: {
                    ...DEFAULT_AGENT_CONFIG.management_policy.playbook_aware.mean_reversion,
                    ...(initialConfig?.management_policy?.playbook_aware?.mean_reversion || {})
                },
                fallback: {
                    ...DEFAULT_AGENT_CONFIG.management_policy.playbook_aware.fallback,
                    ...(initialConfig?.management_policy?.playbook_aware?.fallback || {})
                }
            }
        },
        strategy_filters: {
            ...DEFAULT_AGENT_CONFIG.strategy_filters,
            ...(initialConfig?.strategy_filters || {}),
            playbookBlocklist: initialConfig?.strategy_filters?.playbookBlocklist ?? DEFAULT_AGENT_CONFIG.strategy_filters.playbookBlocklist,
            symbolSideBlocklist: initialConfig?.strategy_filters?.symbolSideBlocklist ?? DEFAULT_AGENT_CONFIG.strategy_filters.symbolSideBlocklist
        },
        position_management: initialConfig?.position_management ?? DEFAULT_AGENT_CONFIG.position_management,
        sentiment_policy: {
            ...DEFAULT_AGENT_CONFIG.sentiment_policy,
            ...(initialConfig?.sentiment_policy || {}),
            tag_blocklist: initialConfig?.sentiment_policy?.tag_blocklist ?? DEFAULT_AGENT_CONFIG.sentiment_policy.tag_blocklist,
            penalty_multipliers: {
                ...DEFAULT_AGENT_CONFIG.sentiment_policy.penalty_multipliers,
                ...(initialConfig?.sentiment_policy?.penalty_multipliers || {})
            },
            decay_windows: {
                ...DEFAULT_AGENT_CONFIG.sentiment_policy.decay_windows,
                ...(initialConfig?.sentiment_policy?.decay_windows || {})
            }
        },
        risk_plan_model: {
            ...DEFAULT_AGENT_CONFIG.risk_plan_model,
            ...(initialConfig?.risk_plan_model || {}),
            vol_anchor_priority: initialConfig?.risk_plan_model?.vol_anchor_priority ?? DEFAULT_AGENT_CONFIG.risk_plan_model.vol_anchor_priority,
            multipliers_by_playbook: {
                ...DEFAULT_AGENT_CONFIG.risk_plan_model.multipliers_by_playbook,
                ...(initialConfig?.risk_plan_model?.multipliers_by_playbook || {})
            },
            regime_adjustments: {
                ...DEFAULT_AGENT_CONFIG.risk_plan_model.regime_adjustments,
                ...(initialConfig?.risk_plan_model?.regime_adjustments || {})
            },
            max_width_bps_by_playbook: {
                ...DEFAULT_AGENT_CONFIG.risk_plan_model.max_width_bps_by_playbook,
                ...(initialConfig?.risk_plan_model?.max_width_bps_by_playbook || {})
            },
            min_width_bps_by_playbook: {
                ...DEFAULT_AGENT_CONFIG.risk_plan_model.min_width_bps_by_playbook,
                ...(initialConfig?.risk_plan_model?.min_width_bps_by_playbook || {})
            }
        },
        trade_cooldowns: {
            ...DEFAULT_AGENT_CONFIG.trade_cooldowns,
            ...(initialConfig?.trade_cooldowns || {})
        }
    };
    merged.risk.max_position_fraction = merged.risk.max_position_fraction ?? merged.risk.max_position_fraction_per_symbol;
    merged.risk.max_position_fraction_per_symbol = merged.risk.max_position_fraction_per_symbol ?? merged.risk.max_position_fraction;
    return cloneConfig(merged);
}

export function ConfigEditor({ initialConfig, initialPreset, onSave, onCancel }: ConfigEditorProps) {
    const [config, setConfig] = useState<AgentConfig>(() => mergeEditorConfig(initialConfig));
    const [preset, setPreset] = useState<string>(initialPreset || 'default');

    useEffect(() => {
        setConfig(mergeEditorConfig(initialConfig));
        setPreset(initialPreset || 'default');
    }, [initialConfig, initialPreset]);

    // Helper to update nested state
    const updateConfig = (path: string, value: any) => {
        setConfig(prev => {
            const newConfig = cloneConfig(prev);
            const keys = path.split('.');
            let current: any = newConfig;
            for (let i = 0; i < keys.length - 1; i++) {
                current = current[keys[i]];
            }
            current[keys[keys.length - 1]] = value;
            return newConfig;
        });
        setPreset('custom');
    };

    const handleSave = async () => {
        try {
            await onSave(config, preset);
            toast.success("Configuration saved");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to save configuration");
        }
    };

    const handleReset = () => {
        setConfig(cloneConfig(DEFAULT_AGENT_CONFIG));
        toast.info("Reset to defaults");
        setPreset('default');
    };

    const applyPreset = (key: string) => {
        if (key === 'default') {
            handleReset();
            return;
        }
        const presetCfg = AGENT_PRESETS[key];
        if (!presetCfg) return;

        setConfig(cloneConfig({
            ...DEFAULT_AGENT_CONFIG,
            ...presetCfg,
            gates: {
                ...DEFAULT_AGENT_CONFIG.gates,
                ...(presetCfg.gates || {}),
                cost_bps_max_by_regime: {
                    ...DEFAULT_AGENT_CONFIG.gates.cost_bps_max_by_regime,
                    ...(presetCfg.gates?.cost_bps_max_by_regime || {})
                },
                edge_to_cost_mult_by_regime: {
                    ...DEFAULT_AGENT_CONFIG.gates.edge_to_cost_mult_by_regime,
                    ...(presetCfg.gates?.edge_to_cost_mult_by_regime || {})
                },
                per_symbol_cost_override: {
                    ...DEFAULT_AGENT_CONFIG.gates.per_symbol_cost_override,
                    ...(presetCfg.gates?.per_symbol_cost_override || {})
                }
            },
            risk: { ...DEFAULT_AGENT_CONFIG.risk, ...(presetCfg.risk || {}) },
            triggers: {
                momentum: { ...DEFAULT_AGENT_CONFIG.triggers.momentum, ...(presetCfg.triggers?.momentum || {}) },
                mean_reversion: { ...DEFAULT_AGENT_CONFIG.triggers.mean_reversion, ...(presetCfg.triggers?.mean_reversion || {}) },
                breakout: { ...DEFAULT_AGENT_CONFIG.triggers.breakout, ...(presetCfg.triggers?.breakout || {}) }
            },
            cost_sanity: { ...DEFAULT_AGENT_CONFIG.cost_sanity, ...(presetCfg.cost_sanity || {}) },
            correlation: { ...DEFAULT_AGENT_CONFIG.correlation, ...(presetCfg.correlation || {}) },
            regime: {
                chop: { ...DEFAULT_AGENT_CONFIG.regime.chop, ...(presetCfg.regime?.chop || {}) },
                risk_on_off: { ...DEFAULT_AGENT_CONFIG.regime.risk_on_off, ...(presetCfg.regime?.risk_on_off || {}) }
            },
            management_policy: {
                ...DEFAULT_AGENT_CONFIG.management_policy,
                ...(presetCfg.management_policy || {}),
                playbook_aware: {
                    momentum: {
                        ...DEFAULT_AGENT_CONFIG.management_policy.playbook_aware.momentum,
                        ...(presetCfg.management_policy?.playbook_aware?.momentum || {})
                    },
                    breakout: {
                        ...DEFAULT_AGENT_CONFIG.management_policy.playbook_aware.breakout,
                        ...(presetCfg.management_policy?.playbook_aware?.breakout || {})
                    },
                    mean_reversion: {
                        ...DEFAULT_AGENT_CONFIG.management_policy.playbook_aware.mean_reversion,
                        ...(presetCfg.management_policy?.playbook_aware?.mean_reversion || {})
                    },
                    fallback: {
                        ...DEFAULT_AGENT_CONFIG.management_policy.playbook_aware.fallback,
                        ...(presetCfg.management_policy?.playbook_aware?.fallback || {})
                    }
                }
            },
            strategy_filters: {
                ...DEFAULT_AGENT_CONFIG.strategy_filters,
                ...(presetCfg.strategy_filters || {}),
                playbookBlocklist: presetCfg.strategy_filters?.playbookBlocklist ?? DEFAULT_AGENT_CONFIG.strategy_filters.playbookBlocklist,
                symbolSideBlocklist: presetCfg.strategy_filters?.symbolSideBlocklist ?? DEFAULT_AGENT_CONFIG.strategy_filters.symbolSideBlocklist
            },
            position_management: presetCfg.position_management ?? DEFAULT_AGENT_CONFIG.position_management,
            sentiment_policy: {
                ...DEFAULT_AGENT_CONFIG.sentiment_policy,
                ...(presetCfg.sentiment_policy || {}),
                tag_blocklist: presetCfg.sentiment_policy?.tag_blocklist ?? DEFAULT_AGENT_CONFIG.sentiment_policy.tag_blocklist,
                penalty_multipliers: {
                    ...DEFAULT_AGENT_CONFIG.sentiment_policy.penalty_multipliers,
                    ...(presetCfg.sentiment_policy?.penalty_multipliers || {})
                },
                decay_windows: {
                    ...DEFAULT_AGENT_CONFIG.sentiment_policy.decay_windows,
                    ...(presetCfg.sentiment_policy?.decay_windows || {})
                }
            },
            risk_plan_model: {
                ...DEFAULT_AGENT_CONFIG.risk_plan_model,
                ...(presetCfg as any).risk_plan_model,
                vol_anchor_priority: (presetCfg as any).risk_plan_model?.vol_anchor_priority ?? DEFAULT_AGENT_CONFIG.risk_plan_model.vol_anchor_priority,
                multipliers_by_playbook: {
                    ...DEFAULT_AGENT_CONFIG.risk_plan_model.multipliers_by_playbook,
                    ...(presetCfg as any).risk_plan_model?.multipliers_by_playbook
                },
                regime_adjustments: {
                    ...DEFAULT_AGENT_CONFIG.risk_plan_model.regime_adjustments,
                    ...(presetCfg as any).risk_plan_model?.regime_adjustments
                },
                max_width_bps_by_playbook: {
                    ...DEFAULT_AGENT_CONFIG.risk_plan_model.max_width_bps_by_playbook,
                    ...(presetCfg as any).risk_plan_model?.max_width_bps_by_playbook
                },
                min_width_bps_by_playbook: {
                    ...DEFAULT_AGENT_CONFIG.risk_plan_model.min_width_bps_by_playbook,
                    ...(presetCfg as any).risk_plan_model?.min_width_bps_by_playbook
                }
            },
            trade_cooldowns: {
                ...DEFAULT_AGENT_CONFIG.trade_cooldowns,
                ...((presetCfg as any).trade_cooldowns || {})
            },
            network_profiles: { ...DEFAULT_AGENT_CONFIG.network_profiles, ...(presetCfg as any).network_profiles }
        }));
        setPreset(key);
    };

    return (
        <TooltipProvider delayDuration={120}>
            <Card className="w-full bg-slate-900 border-slate-800 flex flex-col shadow-none border-0">
                <CardHeader className="flex flex-row items-center justify-between py-3 px-4 shrink-0">
                    <CardTitle className="text-lg font-medium text-white tracking-tight">Agent Configuration</CardTitle>
                    <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" onClick={handleReset} title="Reset to Defaults" className="h-8 w-8 hover:bg-slate-800 text-slate-400 hover:text-white transition-colors rounded-full">
                            <RotateCcw className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={onCancel} title="Close" className="h-8 w-8 hover:bg-slate-800 text-slate-400 hover:text-white transition-colors rounded-full">
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                </CardHeader>
                <div className="px-4 pb-4">
                    <div className="flex flex-col gap-3 mb-5">
                        <div className="flex items-center gap-3">
                            <LabelWithTooltip
                                label="Preset"
                                tooltip="Load a saved mix of risk, trigger, regime, and network defaults."
                                className="text-xs text-slate-400 font-medium"
                                labelClassName="text-xs text-slate-400 font-medium"
                            />
                            <select
                                value={preset}
                                onChange={(e) => applyPreset(e.target.value)}
                                className="flex-1 text-sm bg-slate-900/50 border border-slate-800 text-slate-200 font-medium rounded-md px-3 py-2 focus:outline-none focus:border-purple-500/50 transition-colors"
                            >
                                <option value="default">Default</option>
                                {Object.keys(AGENT_PRESETS).map(key => (
                                    <option key={key} value={key}>
                                        {key}{AGENT_PRESETS[key].preset_live_mode === "limited_manual" ? " (manual)" : AGENT_PRESETS[key].preset_live_mode === "non_live" ? " (non-live)" : ""}
                                    </option>
                                ))}
                                <option value="custom">Custom (edited)</option>
                            </select>

                        </div>
                    </div>
                    <Tabs defaultValue="risk" className="w-full h-full flex flex-col">
                        <TabsList className="grid w-full grid-cols-5 bg-slate-900/30 p-1 mb-5 rounded-lg border border-slate-800/50 shrink-0 gap-1">
                            <TabsTrigger value="risk" className="rounded-md data-[state=active]:bg-slate-800 data-[state=active]:text-slate-100 text-slate-500 font-medium text-xs transition-all py-1.5">Risk</TabsTrigger>
                            <TabsTrigger value="triggers" className="rounded-md data-[state=active]:bg-slate-800 data-[state=active]:text-slate-100 text-slate-500 font-medium text-xs transition-all py-1.5">Triggers</TabsTrigger>
                            <TabsTrigger value="regime" className="rounded-md data-[state=active]:bg-slate-800 data-[state=active]:text-slate-100 text-slate-500 font-medium text-xs transition-all py-1.5">Regime</TabsTrigger>
                            <TabsTrigger value="gates" className="rounded-md data-[state=active]:bg-slate-800 data-[state=active]:text-slate-100 text-slate-500 font-medium text-xs transition-all py-1.5">Gates</TabsTrigger>
                            <TabsTrigger value="network" className="rounded-md data-[state=active]:bg-slate-800 data-[state=active]:text-slate-100 text-slate-500 font-medium text-xs transition-all py-1.5">Network</TabsTrigger>
                        </TabsList>

                        <div className="flex-1">
                            {/* RISK */}
                            <TabsContent value="risk" className="space-y-4 mt-0">
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Max Positions"
                                            tooltip="Hard cap on simultaneous open positions across all symbols."
                                            labelClassName="text-xs text-slate-300 font-medium"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                            type="number"
                                            value={config.risk.max_positions}
                                            onChange={e => updateConfig('risk.max_positions', Number(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Max New Pos / Cycle"
                                            tooltip="Limit how many fresh entries the agent can open in a single decision cycle."
                                            labelClassName="text-xs text-slate-300 font-medium"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                            type="number"
                                            value={config.risk.max_new_positions_per_cycle}
                                            onChange={e => updateConfig('risk.max_new_positions_per_cycle', Number(e.target.value))}
                                        />
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <LabelWithTooltip
                                        label="Max Position Fraction per Symbol"
                                        tooltip="Maximum fraction of equity that can be allocated to any single symbol. Also mirrors the overall per-trade cap."
                                        labelClassName="text-xs text-slate-300 font-medium"
                                    />
                                    <Input
                                        className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                        type="number"
                                        step="0.01"
                                        value={config.risk.max_position_fraction_per_symbol}
                                        onChange={e => {
                                            const val = Number(e.target.value);
                                            updateConfig('risk.max_position_fraction_per_symbol', val);
                                            updateConfig('risk.max_position_fraction', val);
                                        }}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <LabelWithTooltip
                                        label="Max Total Exposure (Fraction)"
                                        tooltip="Cap on total gross exposure vs. equity (sum of all legs), preventing over-leverage across the book."
                                        labelClassName="text-xs text-slate-300 font-medium"
                                    />
                                    <Input
                                        className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                        type="number"
                                        step="0.1"
                                        max="5.0"
                                        value={config.risk.max_total_exposure_fraction}
                                        onChange={e => updateConfig('risk.max_total_exposure_fraction', Number(e.target.value))}
                                    />
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Risk Per Trade"
                                            tooltip="Equity fraction risked at the stop. Example: 0.005 means 0.50% of equity."
                                            labelClassName="text-xs text-slate-300 font-medium"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                            type="number"
                                            step="0.0005"
                                            value={config.risk.risk_per_trade_pct}
                                            onChange={e => updateConfig('risk.risk_per_trade_pct', Number(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Max Effective Leverage"
                                            tooltip="Hard cap on notional divided by equity. This is not the exchange leverage setting."
                                            labelClassName="text-xs text-slate-300 font-medium"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                            type="number"
                                            step="0.5"
                                            value={config.risk.max_effective_leverage}
                                            onChange={e => updateConfig('risk.max_effective_leverage', Number(e.target.value))}
                                        />
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Exchange Leverage"
                                            tooltip="Hyperliquid leverage setting applied before opening a new position. This changes the x-value shown on the exchange, not the target notional size."
                                            labelClassName="text-xs text-slate-300 font-medium"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                            type="number"
                                            step="1"
                                            min="1"
                                            value={config.risk.exchange_max_leverage_allowed}
                                            onChange={e => updateConfig('risk.exchange_max_leverage_allowed', Number(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Default Leverage"
                                            tooltip="Fallback leverage used for risk-plan calculations when there is no current position leverage."
                                            labelClassName="text-xs text-slate-300 font-medium"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                            type="number"
                                            step="1"
                                            min="1"
                                            value={config.risk.default_leverage ?? config.risk.exchange_max_leverage_allowed}
                                            onChange={e => updateConfig('risk.default_leverage', Number(e.target.value))}
                                        />
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Max Corr. Exposure"
                                            tooltip="Same-direction CRYPTO_BETA exposure cap as a fraction of equity."
                                            labelClassName="text-xs text-slate-300 font-medium"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                            type="number"
                                            step="0.05"
                                            value={config.risk.max_correlation_group_exposure_fraction}
                                            onChange={e => updateConfig('risk.max_correlation_group_exposure_fraction', Number(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Slippage Tolerance"
                                            tooltip="Limit order price tolerance as a fraction. Example: 0.005 means 0.50%."
                                            labelClassName="text-xs text-slate-300 font-medium"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                            type="number"
                                            step="0.001"
                                            value={config.risk.slippage_pct ?? 0}
                                            onChange={e => updateConfig('risk.slippage_pct', Number(e.target.value))}
                                        />
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <LabelWithTooltip
                                        label="Margin Mode"
                                        tooltip="Isolated margin is the v1 default for bot-managed derivatives positions."
                                        labelClassName="text-xs text-slate-300 font-medium"
                                    />
                                    <select
                                        value={config.risk.margin_mode}
                                        onChange={e => updateConfig('risk.margin_mode', e.target.value)}
                                        className="w-full bg-slate-900/50 border border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 transition-all h-8 text-sm rounded-md px-2"
                                    >
                                        <option value="isolated">isolated</option>
                                        <option value="cross">cross</option>
                                    </select>
                                </div>
                                <div className="space-y-1.5">
                                    <LabelWithTooltip
                                        label="Daily Loss Kill Switch (Fraction)"
                                        tooltip="Equity drawdown limit for the day. If breached, the agent should stop trading until the next session."
                                        labelClassName="text-xs text-slate-300 font-medium"
                                    />
                                    <Input
                                        className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                        type="number"
                                        step="0.01"
                                        value={config.risk.daily_loss_kill_switch_fraction}
                                        onChange={e => updateConfig('risk.daily_loss_kill_switch_fraction', Number(e.target.value))}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <LabelWithTooltip
                                        label="Min Trade Notional (USD)"
                                        tooltip="Smallest notional size the agent is allowed to submit, used to avoid dust orders."
                                        labelClassName="text-xs text-slate-300 font-medium"
                                    />
                                    <Input
                                        className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                        type="number"
                                        value={config.risk.min_trade_notional_usd}
                                        onChange={e => updateConfig('risk.min_trade_notional_usd', Number(e.target.value))}
                                    />
                                </div>
                                <div className="flex items-center justify-between p-3 bg-slate-950 rounded-lg border border-slate-800">
                                    <LabelWithTooltip
                                        label="No Flip Same Tick"
                                        tooltip="Blocks immediate side flips within the same engine tick to reduce churn and fee drag."
                                        className="text-xs text-slate-300 font-medium"
                                        labelClassName="text-xs text-slate-300 font-medium"
                                    />
                                    <Switch
                                        checked={config.risk.no_flip_same_tick}
                                        onCheckedChange={c => updateConfig('risk.no_flip_same_tick', c)}
                                        className="data-[state=checked]:bg-purple-600"
                                    />
                                </div>
                            </TabsContent>

                            {/* TRIGGERS */}
                            <TabsContent value="triggers" className="space-y-6 mt-0">
                                {/* Momentum */}
                                <div className="space-y-3">
                                    <h4 className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Momentum</h4>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <LabelWithTooltip
                                                label="Book Pressure Min"
                                                tooltip="Minimum order book imbalance to count as momentum confirmation. Higher values require stronger bid/ask skew."
                                                labelClassName="text-xs font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-9 rounded-lg text-sm"
                                                type="number"
                                                step="0.05"
                                                value={config.triggers?.momentum.book_pressure_min ?? 0.2}
                                                onChange={e => updateConfig('triggers.momentum.book_pressure_min', Number(e.target.value))}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <LabelWithTooltip
                                                label="Vol Ratio Min"
                                                tooltip="Floor for short-term vs. long-term volume ratio before treating a move as real momentum."
                                                labelClassName="text-xs font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-9 rounded-lg text-sm"
                                                type="number"
                                                step="0.1"
                                                value={config.triggers?.momentum.vol_ratio_min ?? 1.0}
                                                onChange={e => updateConfig('triggers.momentum.vol_ratio_min', Number(e.target.value))}
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Mean Reversion */}
                                <div className="space-y-3 pt-2 border-t border-slate-800/50">
                                    <h4 className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Mean Reversion</h4>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <LabelWithTooltip
                                                label="Ret Sigma Threshold"
                                                tooltip="How many standard deviations a return must stretch before flagging a fade opportunity."
                                                labelClassName="text-xs font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-9 rounded-lg text-sm"
                                                type="number"
                                                step="0.5"
                                                value={config.triggers?.mean_reversion.ret_sigma_threshold ?? 3.0}
                                                onChange={e => updateConfig('triggers.mean_reversion.ret_sigma_threshold', Number(e.target.value))}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <LabelWithTooltip
                                                label="Book Pressure Min"
                                                tooltip="Baseline book skew needed to trust that a stretched move can snap back."
                                                labelClassName="text-xs font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-9 rounded-lg text-sm"
                                                type="number"
                                                step="0.05"
                                                value={config.triggers?.mean_reversion.book_pressure_min ?? 0.1}
                                                onChange={e => updateConfig('triggers.mean_reversion.book_pressure_min', Number(e.target.value))}
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Breakout */}
                                <div className="space-y-3 pt-2 border-t border-slate-800/50">
                                    <h4 className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Breakout</h4>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <LabelWithTooltip
                                                label="Vol Ratio Min"
                                                tooltip="Minimum volume expansion vs. baseline to treat the squeeze release as a true breakout."
                                                labelClassName="text-xs font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-9 rounded-lg text-sm"
                                                type="number"
                                                step="0.1"
                                                value={config.triggers?.breakout.vol_ratio_min ?? 2.0}
                                                onChange={e => updateConfig('triggers.breakout.vol_ratio_min', Number(e.target.value))}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <LabelWithTooltip
                                                label="Book Pressure Min"
                                                tooltip="Order book bias required to keep trading in the breakout direction after the initial squeeze."
                                                labelClassName="text-xs font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-9 rounded-lg text-sm"
                                                type="number"
                                                step="0.05"
                                                value={config.triggers?.breakout.book_pressure_min ?? 0.3}
                                                onChange={e => updateConfig('triggers.breakout.book_pressure_min', Number(e.target.value))}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </TabsContent>

                            {/* REGIME */}
                            <TabsContent value="regime" className="space-y-4 mt-0">
                                <div className="space-y-3">
                                    <h4 className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Chop Regime</h4>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1.5">
                                            <LabelWithTooltip
                                                label="New Pos Mult"
                                                tooltip="Multiplier applied to max new positions when the global regime is CHOP. Values below 1 slow down entries."
                                                labelClassName="text-[10px] font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium h-8 text-sm rounded-md"
                                                type="number"
                                                step="0.1"
                                                value={config.regime?.chop.max_new_positions_per_cycle_mult ?? 0.5}
                                                onChange={e => updateConfig('regime.chop.max_new_positions_per_cycle_mult', Number(e.target.value))}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <LabelWithTooltip
                                                label="Conf. Thresh Mult"
                                                tooltip="Inflates the confidence threshold needed to take trades in CHOP, forcing only A+ setups."
                                                labelClassName="text-[10px] font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium h-8 text-sm rounded-md"
                                                type="number"
                                                step="0.1"
                                                value={config.regime?.chop.confidence_threshold_mult ?? 1.2}
                                                onChange={e => updateConfig('regime.chop.confidence_threshold_mult', Number(e.target.value))}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <LabelWithTooltip
                                                label="TP/SL Mult"
                                                tooltip="Scales the take-profit / stop-loss template in CHOP to tighten or loosen exits."
                                                labelClassName="text-[10px] font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium h-8 text-sm rounded-md"
                                                type="number"
                                                step="0.1"
                                                value={config.regime?.chop.tp_sl_mult ?? 0.8}
                                                onChange={e => updateConfig('regime.chop.tp_sl_mult', Number(e.target.value))}
                                            />
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-3 pt-2 border-t border-slate-800/50">
                                    <h4 className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Risk On/Off</h4>
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Risk On Sizing Mult"
                                            tooltip="Scaling factor on position sizing when the system flags RISK_ON or RISK_OFF regimes."
                                            labelClassName="text-[10px] font-medium text-slate-400"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium h-8 text-sm rounded-md"
                                            type="number"
                                            step="0.1"
                                            value={config.regime?.risk_on_off.sizing_mult ?? 1.2}
                                            onChange={e => updateConfig('regime.risk_on_off.sizing_mult', Number(e.target.value))}
                                        />
                                    </div>
                                </div>
                            </TabsContent>

                            {/* GATES */}
                            <TabsContent value="gates" className="space-y-4 mt-0">
                                <div className="space-y-3">
                                    <h4 className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Cost Sanity</h4>
                                    <div className="grid grid-cols-3 gap-3">
                                        <div className="space-y-1.5">
                                            <LabelWithTooltip
                                                label="Edge/Cost"
                                                tooltip="Reject candidates when edge-to-cost is below this multiple before the LLM sees them."
                                                labelClassName="text-[10px] font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                                type="number"
                                                step="0.1"
                                                value={config.cost_sanity.min_edge_to_cost_mult}
                                                onChange={e => updateConfig('cost_sanity.min_edge_to_cost_mult', Number(e.target.value))}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <LabelWithTooltip
                                                label="Stop/Cost"
                                                tooltip="Reject candidates whose deterministic stop is too small relative to fees, spread, and slippage."
                                                labelClassName="text-[10px] font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                                type="number"
                                                step="0.1"
                                                value={config.cost_sanity.min_stop_to_cost_mult}
                                                onChange={e => updateConfig('cost_sanity.min_stop_to_cost_mult', Number(e.target.value))}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <LabelWithTooltip
                                                label="TP/Cost"
                                                tooltip="Reject candidates whose deterministic take-profit is too small relative to trading costs."
                                                labelClassName="text-[10px] font-medium text-slate-400"
                                            />
                                            <Input
                                                className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                                type="number"
                                                step="0.1"
                                                value={config.cost_sanity.min_tp_to_cost_mult}
                                                onChange={e => updateConfig('cost_sanity.min_tp_to_cost_mult', Number(e.target.value))}
                                            />
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <LabelWithTooltip
                                        label="Min Depth (USD)"
                                        tooltip="Absolute minimum combined order book depth required before trading a symbol."
                                        labelClassName="text-xs text-slate-300 font-medium"
                                    />
                                    <Input
                                        className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                        type="number"
                                        value={config.gates.depth_usd_min}
                                        onChange={e => updateConfig('gates.depth_usd_min', Number(e.target.value))}
                                    />
                                </div>

                                <div className="grid grid-cols-3 gap-3 pt-2">
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Risk On (BPS)"
                                            tooltip="Max allowed all-in trading cost (fees + slip + spread) when regime is RISK_ON."
                                            labelClassName="text-[10px] font-medium text-slate-400"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                            type="number"
                                            value={config.gates.cost_bps_max_by_regime.RISK_ON}
                                            onChange={e => updateConfig('gates.cost_bps_max_by_regime.RISK_ON', Number(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Risk Off (BPS)"
                                            tooltip="Max allowed cost when the book is in defensive RISK_OFF mode."
                                            labelClassName="text-[10px] font-medium text-slate-400"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                            type="number"
                                            value={config.gates.cost_bps_max_by_regime.RISK_OFF}
                                            onChange={e => updateConfig('gates.cost_bps_max_by_regime.RISK_OFF', Number(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <LabelWithTooltip
                                            label="Chop (BPS)"
                                            tooltip="Max allowed cost when trading a choppy regime, usually tighter to avoid grinding drawdown."
                                            labelClassName="text-[10px] font-medium text-slate-400"
                                        />
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                            type="number"
                                            value={config.gates.cost_bps_max_by_regime.CHOP}
                                            onChange={e => updateConfig('gates.cost_bps_max_by_regime.CHOP', Number(e.target.value))}
                                        />
                                    </div>
                                </div>
                            </TabsContent>

                            {/* NETWORK */}
                            <TabsContent value="network" className="space-y-4 mt-0">
                                <div className="space-y-1.5">
                                    <LabelWithTooltip
                                        label="Slippage Min BPS"
                                        tooltip="Base slippage floor baked into sizing calculations even when depth looks perfect."
                                        labelClassName="text-xs text-slate-300 font-medium"
                                    />
                                    <Input
                                        className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                        type="number"
                                        value={config.network_profiles.mainnet.slippage_model.min_bps}
                                        onChange={e => updateConfig('network_profiles.mainnet.slippage_model.min_bps', Number(e.target.value))}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <LabelWithTooltip
                                        label="Slippage Spread Multiplier"
                                        tooltip="How strongly the model should scale slippage off the observed spread width."
                                        labelClassName="text-xs text-slate-300 font-medium"
                                    />
                                    <Input
                                        className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                        type="number"
                                        step="0.1"
                                        value={config.network_profiles.mainnet.slippage_model.spread_mult}
                                        onChange={e => updateConfig('network_profiles.mainnet.slippage_model.spread_mult', Number(e.target.value))}
                                    />
                                </div>
                            </TabsContent>
                        </div>
                    </Tabs>
                </div>
                <div className="p-4 pt-2 shrink-0">
                    <Button onClick={handleSave} className="w-full bg-purple-600/90 hover:bg-purple-600 text-white font-medium h-10 text-sm rounded-lg shadow-lg shadow-purple-900/10 transition-all">
                        <Save className="h-4 w-4 mr-2" />
                        Save Configuration
                    </Button>
                </div>
            </Card>
        </TooltipProvider>
    );
}
