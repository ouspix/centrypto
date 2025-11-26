
import React, { useState, useEffect } from "react";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
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
    const [config, setConfig] = useState<AgentConfig>(initialConfig || DEFAULT_AGENT_CONFIG);

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
    };

    const handleSave = () => {
        onSave(config);
        toast.success("Configuration saved");
    };

    const handleReset = () => {
        setConfig(DEFAULT_AGENT_CONFIG);
        toast.info("Reset to defaults");
    };

    return (
        <Card className="w-full h-full bg-slate-900 border-slate-800 flex flex-col shadow-2xl overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between py-5 px-6 shrink-0">
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
            <div className="flex-1 overflow-y-auto px-6 pb-6">
                <Tabs defaultValue="gates" className="w-full h-full flex flex-col">
                    <TabsList className="grid w-full grid-cols-4 bg-slate-950/50 p-1 mb-6 rounded-xl border border-slate-800/50 shrink-0">
                        <TabsTrigger value="gates" className="rounded-lg data-[state=active]:bg-slate-800 data-[state=active]:text-white text-slate-400 font-medium text-xs transition-all">Gates</TabsTrigger>
                        <TabsTrigger value="screener" className="rounded-lg data-[state=active]:bg-slate-800 data-[state=active]:text-white text-slate-400 font-medium text-xs transition-all">Screener</TabsTrigger>
                        <TabsTrigger value="risk" className="rounded-lg data-[state=active]:bg-slate-800 data-[state=active]:text-white text-slate-400 font-medium text-xs transition-all">Risk</TabsTrigger>
                        <TabsTrigger value="network" className="rounded-lg data-[state=active]:bg-slate-800 data-[state=active]:text-white text-slate-400 font-medium text-xs transition-all">Network</TabsTrigger>
                    </TabsList>

                    <div className="flex-1">
                        {/* GATES */}
                        <TabsContent value="gates" className="space-y-5 mt-0">
                            <div className="space-y-2">
                                <Label className="text-sm text-slate-300 font-medium">Min Depth (USD)</Label>
                                <Input
                                    className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
                                    type="number"
                                    value={config.gates.depth_usd_min}
                                    onChange={e => updateConfig('gates.depth_usd_min', Number(e.target.value))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label className="text-sm text-slate-300 font-medium">Max Spread (BPS)</Label>
                                <Input
                                    className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
                                    type="number"
                                    value={config.gates.spread_bps_hard_max}
                                    onChange={e => updateConfig('gates.spread_bps_hard_max', Number(e.target.value))}
                                />
                            </div>
                            <div className="grid grid-cols-3 gap-4 pt-2">
                                <div className="space-y-2">
                                    <Label className="text-xs font-medium text-slate-400">Risk On (BPS)</Label>
                                    <Input
                                        className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
                                        type="number"
                                        value={config.gates.cost_bps_max_by_regime.RISK_ON}
                                        onChange={e => updateConfig('gates.cost_bps_max_by_regime.RISK_ON', Number(e.target.value))}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-xs font-medium text-slate-400">Risk Off (BPS)</Label>
                                    <Input
                                        className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
                                        type="number"
                                        value={config.gates.cost_bps_max_by_regime.RISK_OFF}
                                        onChange={e => updateConfig('gates.cost_bps_max_by_regime.RISK_OFF', Number(e.target.value))}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-xs font-medium text-slate-400">Chop (BPS)</Label>
                                    <Input
                                        className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
                                        type="number"
                                        value={config.gates.cost_bps_max_by_regime.CHOP}
                                        onChange={e => updateConfig('gates.cost_bps_max_by_regime.CHOP', Number(e.target.value))}
                                    />
                                </div>
                            </div>
                        </TabsContent>

                        {/* SCREENER */}
                        <TabsContent value="screener" className="space-y-5 mt-0">
                            <div className="space-y-2">
                                <Label className="text-sm text-slate-300 font-medium">Top N Candidates</Label>
                                <Input
                                    className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
                                    type="number"
                                    value={config.screener.top_n}
                                    onChange={e => updateConfig('screener.top_n', Number(e.target.value))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label className="text-sm text-slate-300 font-medium">Min Volume 24h</Label>
                                <Input
                                    className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
                                    type="number"
                                    value={config.screener.min_volume_24h}
                                    onChange={e => updateConfig('screener.min_volume_24h', Number(e.target.value))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label className="text-sm text-slate-300 font-medium">Min Volatility Ratio (5m/1h)</Label>
                                <Input
                                    className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
                                    type="number"
                                    step="0.1"
                                    value={config.screener.min_vol_ratio_5m_vs_1h}
                                    onChange={e => updateConfig('screener.min_vol_ratio_5m_vs_1h', Number(e.target.value))}
                                />
                            </div>
                        </TabsContent>

                        {/* RISK */}
                        <TabsContent value="risk" className="space-y-5 mt-0">
                            <div className="space-y-2">
                                <Label className="text-sm text-slate-300 font-medium">Max Positions</Label>
                                <Input
                                    className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
                                    type="number"
                                    value={config.risk.max_positions}
                                    onChange={e => updateConfig('risk.max_positions', Number(e.target.value))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label className="text-sm text-slate-300 font-medium">Max Total Exposure (Fraction)</Label>
                                <Input
                                    className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
                                    type="number"
                                    step="0.1"
                                    max="5.0"
                                    value={config.risk.max_total_exposure_fraction}
                                    onChange={e => updateConfig('risk.max_total_exposure_fraction', Number(e.target.value))}
                                />
                            </div>
                            <div className="flex items-center justify-between p-4 bg-slate-950 rounded-xl border border-slate-800">
                                <Label className="text-sm text-slate-300 font-medium">No Flip Same Tick</Label>
                                <Switch
                                    checked={config.risk.no_flip_same_tick}
                                    onCheckedChange={c => updateConfig('risk.no_flip_same_tick', c)}
                                    className="data-[state=checked]:bg-purple-600"
                                />
                            </div>
                        </TabsContent>

                        {/* NETWORK */}
                        <TabsContent value="network" className="space-y-5 mt-0">
                            <div className="space-y-2">
                                <Label className="text-sm text-slate-300 font-medium">Slippage Min BPS</Label>
                                <Input
                                    className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
                                    type="number"
                                    value={config.network_profiles.mainnet.slippage_model.min_bps}
                                    onChange={e => updateConfig('network_profiles.mainnet.slippage_model.min_bps', Number(e.target.value))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label className="text-sm text-slate-300 font-medium">Slippage Spread Multiplier</Label>
                                <Input
                                    className="bg-slate-950 border-slate-800 text-slate-100 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all h-11 rounded-lg"
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
            <div className="p-6 pt-2 shrink-0">
                <Button onClick={handleSave} className="w-full bg-purple-600 hover:bg-purple-500 text-white font-medium h-12 rounded-xl shadow-lg shadow-purple-900/20 transition-all">
                    <Save className="h-4 w-4 mr-2" />
                    Save Configuration
                </Button>
            </div>
        </Card>
    );
}
