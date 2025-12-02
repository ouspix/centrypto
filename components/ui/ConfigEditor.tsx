
import React, { useState, useEffect } from "react";
import { AgentConfig, DEFAULT_AGENT_CONFIG, AGENT_PRESETS } from "@/lib/agent-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Save, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";

interface ConfigEditorProps {
    initialConfig?: AgentConfig;
    onSave: (config: AgentConfig) => void;
    onCancel: () => void;
}

export function ConfigEditor({ initialConfig, onSave, onCancel }: ConfigEditorProps) {
    const [config, setConfig] = useState<AgentConfig>(() => {
        // Deep merge initialConfig with defaults to ensure new fields (like triggers) exist
        const merged: AgentConfig = {
            ...DEFAULT_AGENT_CONFIG,
            ...initialConfig,
            triggers: {
                ...DEFAULT_AGENT_CONFIG.triggers,
                ...(initialConfig?.triggers || {})
            },
            risk: {
                ...DEFAULT_AGENT_CONFIG.risk,
                ...(initialConfig?.risk || {})
            },
            regime: {
                ...DEFAULT_AGENT_CONFIG.regime,
                ...(initialConfig?.regime || {})
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
                }
            }
        };
        merged.risk.max_position_fraction = merged.risk.max_position_fraction ?? merged.risk.max_position_fraction_per_symbol;
        merged.risk.max_position_fraction_per_symbol = merged.risk.max_position_fraction_per_symbol ?? merged.risk.max_position_fraction;
        return merged;
    });
    const [preset, setPreset] = useState<string>('default');

    // Helper to update nested state
    const updateConfig = (path: string, value: any) => {
        setConfig(prev => {
            const newConfig = { ...prev };
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

    const handleSave = () => {
        onSave(config);
        toast.success("Configuration saved");
    };

    const handleReset = () => {
        setConfig(DEFAULT_AGENT_CONFIG);
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

        setConfig(prev => ({
            ...DEFAULT_AGENT_CONFIG,
            ...presetCfg,
            gates: { ...DEFAULT_AGENT_CONFIG.gates, ...(presetCfg.gates || {}) },
            risk: { ...DEFAULT_AGENT_CONFIG.risk, ...(presetCfg.risk || {}) },
            triggers: { ...DEFAULT_AGENT_CONFIG.triggers, ...(presetCfg.triggers || {}) },
            regime: { ...DEFAULT_AGENT_CONFIG.regime, ...(presetCfg.regime || {}) },
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
                }
            },
            network_profiles: { ...DEFAULT_AGENT_CONFIG.network_profiles, ...(presetCfg as any).network_profiles }
        }));
        setPreset(key);
    };

    return (
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
                        <label className="text-xs text-slate-400 font-medium">Preset</label>
                        <select
                            value={preset}
                            onChange={(e) => applyPreset(e.target.value)}
                            className="flex-1 text-sm bg-slate-900/50 border border-slate-800 text-slate-200 font-medium rounded-md px-3 py-2 focus:outline-none focus:border-purple-500/50 transition-colors"
                        >
                            <option value="default">Default</option>
                            {Object.keys(AGENT_PRESETS).map(key => (
                                <option key={key} value={key}>{key}</option>
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
                                    <Label className="text-xs text-slate-300 font-medium">Max Positions</Label>
                                    <Input
                                        className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                        type="number"
                                        value={config.risk.max_positions}
                                        onChange={e => updateConfig('risk.max_positions', Number(e.target.value))}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-xs text-slate-300 font-medium">Max New Pos / Cycle</Label>
                                    <Input
                                        className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                        type="number"
                                        value={config.risk.max_new_positions_per_cycle}
                                        onChange={e => updateConfig('risk.max_new_positions_per_cycle', Number(e.target.value))}
                                    />
                                </div>
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs text-slate-300 font-medium">Max Position Fraction per Symbol</Label>
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
                                <Label className="text-xs text-slate-300 font-medium">Max Total Exposure (Fraction)</Label>
                                <Input
                                    className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                    type="number"
                                    step="0.1"
                                    max="5.0"
                                    value={config.risk.max_total_exposure_fraction}
                                    onChange={e => updateConfig('risk.max_total_exposure_fraction', Number(e.target.value))}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs text-slate-300 font-medium">Daily Loss Kill Switch (Fraction)</Label>
                                <Input
                                    className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                    type="number"
                                    step="0.01"
                                    value={config.risk.daily_loss_kill_switch_fraction}
                                    onChange={e => updateConfig('risk.daily_loss_kill_switch_fraction', Number(e.target.value))}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs text-slate-300 font-medium">Min Trade Notional (USD)</Label>
                                <Input
                                    className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                    type="number"
                                    value={config.risk.min_trade_notional_usd}
                                    onChange={e => updateConfig('risk.min_trade_notional_usd', Number(e.target.value))}
                                />
                            </div>
                            <div className="flex items-center justify-between p-3 bg-slate-950 rounded-lg border border-slate-800">
                                <Label className="text-xs text-slate-300 font-medium">No Flip Same Tick</Label>
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
                                        <Label className="text-xs font-medium text-slate-400">Book Pressure Min</Label>
                                        <Input
                                            className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-9 rounded-lg text-sm"
                                            type="number"
                                            step="0.05"
                                            value={config.triggers?.momentum.book_pressure_min ?? 0.2}
                                            onChange={e => updateConfig('triggers.momentum.book_pressure_min', Number(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label className="text-xs font-medium text-slate-400">Vol Ratio Min</Label>
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
                                        <Label className="text-xs font-medium text-slate-400">Ret Sigma Threshold</Label>
                                        <Input
                                            className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-9 rounded-lg text-sm"
                                            type="number"
                                            step="0.5"
                                            value={config.triggers?.mean_reversion.ret_sigma_threshold ?? 3.0}
                                            onChange={e => updateConfig('triggers.mean_reversion.ret_sigma_threshold', Number(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label className="text-xs font-medium text-slate-400">Book Pressure Min</Label>
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
                                        <Label className="text-xs font-medium text-slate-400">Vol Ratio Min</Label>
                                        <Input
                                            className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-9 rounded-lg text-sm"
                                            type="number"
                                            step="0.1"
                                            value={config.triggers?.breakout.vol_ratio_min ?? 2.0}
                                            onChange={e => updateConfig('triggers.breakout.vol_ratio_min', Number(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label className="text-xs font-medium text-slate-400">Book Pressure Min</Label>
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
                                        <Label className="text-[10px] font-medium text-slate-400">New Pos Mult</Label>
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium h-8 text-sm rounded-md"
                                            type="number"
                                            step="0.1"
                                            value={config.regime?.chop.max_new_positions_per_cycle_mult ?? 0.5}
                                            onChange={e => updateConfig('regime.chop.max_new_positions_per_cycle_mult', Number(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label className="text-[10px] font-medium text-slate-400">Conf. Thresh Mult</Label>
                                        <Input
                                            className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium h-8 text-sm rounded-md"
                                            type="number"
                                            step="0.1"
                                            value={config.regime?.chop.confidence_threshold_mult ?? 1.2}
                                            onChange={e => updateConfig('regime.chop.confidence_threshold_mult', Number(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label className="text-[10px] font-medium text-slate-400">TP/SL Mult</Label>
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
                                    <Label className="text-[10px] font-medium text-slate-400">Risk On Sizing Mult</Label>
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
                            <div className="space-y-1.5">
                                <Label className="text-xs text-slate-300 font-medium">Min Depth (USD)</Label>
                                <Input
                                    className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                    type="number"
                                    value={config.gates.depth_usd_min}
                                    onChange={e => updateConfig('gates.depth_usd_min', Number(e.target.value))}
                                />
                            </div>

                            <div className="grid grid-cols-3 gap-3 pt-2">
                                <div className="space-y-1.5">
                                    <Label className="text-[10px] font-medium text-slate-400">Risk On (BPS)</Label>
                                    <Input
                                        className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                        type="number"
                                        value={config.gates.cost_bps_max_by_regime.RISK_ON}
                                        onChange={e => updateConfig('gates.cost_bps_max_by_regime.RISK_ON', Number(e.target.value))}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-[10px] font-medium text-slate-400">Risk Off (BPS)</Label>
                                    <Input
                                        className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                        type="number"
                                        value={config.gates.cost_bps_max_by_regime.RISK_OFF}
                                        onChange={e => updateConfig('gates.cost_bps_max_by_regime.RISK_OFF', Number(e.target.value))}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-[10px] font-medium text-slate-400">Chop (BPS)</Label>
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
                                <Label className="text-xs text-slate-300 font-medium">Slippage Min BPS</Label>
                                <Input
                                    className="bg-slate-900/50 border-slate-800 text-slate-200 font-medium focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-8 text-sm rounded-md"
                                    type="number"
                                    value={config.network_profiles.mainnet.slippage_model.min_bps}
                                    onChange={e => updateConfig('network_profiles.mainnet.slippage_model.min_bps', Number(e.target.value))}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs text-slate-300 font-medium">Slippage Spread Multiplier</Label>
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
    );
}
