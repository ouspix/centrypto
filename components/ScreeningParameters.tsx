"use client"

import { useState, useEffect, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Filter, ChevronDown, ChevronUp } from "lucide-react"

type ScreeningConfig = {
    layer1Enabled: boolean;
    minVolume24h: number;
    minRecentVolume: number;
    recentVolumeMinutes: number;
    layer2Enabled: boolean;
    maxSpreadBps: number;
    dynamicSpreadEnabled: boolean;
    minDepthUsd: number;
    layer3Enabled: boolean;
    minVolZscore: number;
    minRetZscore: number;
    minRealizedVol: number;
    minRetM5: number;
    minRetM15: number;
    layer4Enabled: boolean;
    topN: number;
    quality_weights: {
        vol_score: number;
        move_score: number;
        trend_align: number;
        spread_penalty: number;
        illiquidity_penalty: number;
    };
}

const DEFAULT_CONFIG: ScreeningConfig = {
    layer1Enabled: true,
    minVolume24h: 1_000_000,
    minRecentVolume: 50_000,
    recentVolumeMinutes: 15,
    layer2Enabled: true,
    maxSpreadBps: 50,
    dynamicSpreadEnabled: true,
    minDepthUsd: 10_000,
    layer3Enabled: true,
    minVolZscore: 0.5,
    minRetZscore: 0.5,
    minRealizedVol: 0.0005,
    minRetM5: 0.0001,
    minRetM15: 0.0001,
    layer4Enabled: true,
    topN: 20,
    quality_weights: {
        vol_score: 2.0,
        move_score: 1.0,
        trend_align: 0.5,
        spread_penalty: 1.0,
        illiquidity_penalty: 0.5
    }
}

const PRESETS: Record<string, Partial<ScreeningConfig>> = {
    default: DEFAULT_CONFIG,
    scalper_strict: {
        minVolume24h: 2_000_000,
        minRecentVolume: 150_000,
        recentVolumeMinutes: 10,
        maxSpreadBps: 30,
        minDepthUsd: 25_000,
        minVolZscore: 0.8,
        minRetZscore: 0.8,
        minRealizedVol: 0.0008,
        topN: 15,
        quality_weights: {
            vol_score: 2.5,
            move_score: 1.2,
            trend_align: 0.7,
            spread_penalty: 1.5,
            illiquidity_penalty: 1.0
        }
    },
    momentum_moderate: {
        minVolume24h: 1_000_000,
        minRecentVolume: 75_000,
        recentVolumeMinutes: 15,
        maxSpreadBps: 50,
        minDepthUsd: 15_000,
        minVolZscore: 0.5,
        minRetZscore: 0.5,
        minRealizedVol: 0.0005,
        topN: 20,
        quality_weights: {
            vol_score: 2.0,
            move_score: 1.0,
            trend_align: 0.5,
            spread_penalty: 1.0,
            illiquidity_penalty: 0.5
        }
    },
    relaxed_liquidity: {
        minVolume24h: 500_000,
        minRecentVolume: 25_000,
        recentVolumeMinutes: 20,
        maxSpreadBps: 80,
        minDepthUsd: 5_000,
        minVolZscore: 0.2,
        minRetZscore: 0.2,
        minRealizedVol: 0.0003,
        topN: 30,
        quality_weights: {
            vol_score: 1.5,
            move_score: 0.8,
            trend_align: 0.3,
            spread_penalty: 0.5,
            illiquidity_penalty: 0.3
        }
    },
    testnet_lenient: {
        minVolume24h: 0,
        minRecentVolume: 10_000,
        recentVolumeMinutes: 20,
        maxSpreadBps: 120,
        minDepthUsd: 1_000,
        minVolZscore: 0.0,
        minRetZscore: 0.0,
        minRealizedVol: 0.0001,
        topN: 25,
        quality_weights: {
            vol_score: 1.2,
            move_score: 0.8,
            trend_align: 0.2,
            spread_penalty: 0.3,
            illiquidity_penalty: 0.2
        }
    }
};

export function ScreeningParameters() {
    const [config, setConfig] = useState<ScreeningConfig>(DEFAULT_CONFIG)
    const [expanded, setExpanded] = useState(true)
    const [loaded, setLoaded] = useState(false)
    const [preset, setPreset] = useState<string>('momentum_moderate')

    // Load from localStorage on mount
    useEffect(() => {
        const saved = localStorage.getItem('screeningConfig')
        if (saved) {
            try {
                const loaded = JSON.parse(saved)
                setConfig({ ...DEFAULT_CONFIG, ...loaded })
                setPreset('custom')
            } catch (e) {
                console.error('Failed to load screening config', e)
            }
        }
        setLoaded(true)
    }, [])

    // Save to localStorage on change (only after loaded)
    useEffect(() => {
        if (!loaded) return

        localStorage.setItem('screeningConfig', JSON.stringify(config))
        // Also emit event for other components to listen
        window.dispatchEvent(new CustomEvent('screeningConfigChanged', { detail: config }))
    }, [config, loaded])

    const updateConfig = (key: keyof ScreeningConfig, value: any) => {
        setConfig(prev => ({ ...prev, [key]: value }))
        setPreset('custom')
    }

    const applyPreset = (key: string) => {
        const presetCfg = PRESETS[key];
        if (!presetCfg) return;
        // Merge preset over defaults to ensure missing fields are filled
        setConfig({ ...DEFAULT_CONFIG, ...presetCfg, quality_weights: { ...DEFAULT_CONFIG.quality_weights, ...(presetCfg.quality_weights || {}) } });
        setPreset(key);
    }

    return (
        <Card className="bg-slate-900 border-slate-800 hover-lift">
            <CardHeader className="py-2 px-3 border-b border-slate-800/50 cursor-pointer min-h-[40px]" onClick={() => setExpanded(!expanded)}>
                <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-bold text-cyan-400 flex items-center gap-2">
                        <Filter className="h-4 w-4" />
                        Screening Parameters
                    </CardTitle>
                    {expanded ? <ChevronUp className="h-3 w-3 text-slate-400" /> : <ChevronDown className="h-3 w-3 text-slate-400" />}
                </div>
            </CardHeader>
            {expanded && (
                <CardContent className="p-2 space-y-3">
                    <div className="flex items-center gap-2">
                        <label className="text-xs text-slate-300 font-semibold">Preset</label>
                        <select
                            value={preset}
                            onChange={(e) => applyPreset(e.target.value)}
                            className="text-xs bg-slate-950 border border-slate-700 text-slate-100 rounded-md px-2 py-1 focus:outline-none focus:border-cyan-500"
                        >
                            <option value="momentum_moderate">Momentum Moderate (default)</option>
                            <option value="scalper_strict">Scalper Strict</option>
                            <option value="relaxed_liquidity">Relaxed Liquidity</option>
                            <option value="testnet_lenient">Testnet Lenient</option>
                            <option value="custom">Custom (saved)</option>
                        </select>
                        <button
                            onClick={() => applyPreset(preset)}
                            className="text-[11px] font-semibold text-cyan-300 bg-cyan-500/10 border border-cyan-500/30 rounded px-2 py-1 hover:bg-cyan-500/20 transition"
                        >
                            Apply
                        </button>
                    </div>

                    {/* Layer 1: Volume */}
                    <div className="p-2 bg-slate-950/50 rounded-lg border border-slate-800">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-cyan-500/30 text-cyan-400 bg-cyan-500/5">
                                    L1
                                </Badge>
                                <span className="text-xs font-semibold text-slate-200">Volume</span>
                            </div>
                            <Switch
                                checked={config.layer1Enabled}
                                onCheckedChange={(val) => updateConfig('layer1Enabled', val)}
                                className="scale-75 data-[state=checked]:bg-cyan-500"
                            />
                        </div>
                        {config.layer1Enabled && (
                            <div className="grid grid-cols-2 gap-2">
                                <div className="col-span-2">
                                    <div className="flex justify-between items-center mb-1">
                                        <label className="text-[10px] text-slate-400">Min 24h Vol</label>
                                        <span className="text-[10px] text-slate-500 font-mono">
                                            ${(config.minVolume24h / 1_000_000).toFixed(1)}M
                                        </span>
                                    </div>
                                    <Input
                                        type="number"
                                        value={config.minVolume24h}
                                        onChange={(e) => updateConfig('minVolume24h', Number(e.target.value))}
                                        className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        step="100000"
                                    />
                                </div>
                                <div>
                                    <div className="flex justify-between items-center mb-1">
                                        <label className="text-[10px] text-slate-400">Recent Vol</label>
                                        <span className="text-[10px] text-slate-500 font-mono">
                                            ${(config.minRecentVolume / 1_000).toFixed(0)}k
                                        </span>
                                    </div>
                                    <Input
                                        type="number"
                                        value={config.minRecentVolume}
                                        onChange={(e) => updateConfig('minRecentVolume', Number(e.target.value))}
                                        className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        step="10000"
                                    />
                                </div>
                                <div>
                                    <div className="flex justify-between items-center mb-1">
                                        <label className="text-[10px] text-slate-400">Window (m)</label>
                                    </div>
                                    <Input
                                        type="number"
                                        value={config.recentVolumeMinutes}
                                        onChange={(e) => updateConfig('recentVolumeMinutes', Number(e.target.value))}
                                        className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        step="1"
                                        min="1"
                                        max="60"
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Layer 2: Liquidity */}
                    <div className="p-2 bg-slate-950/50 rounded-lg border border-slate-800">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-blue-500/30 text-blue-400 bg-blue-500/5">
                                    L2
                                </Badge>
                                <span className="text-xs font-semibold text-slate-200">Liquidity</span>
                            </div>
                            <Switch
                                checked={config.layer2Enabled}
                                onCheckedChange={(val) => updateConfig('layer2Enabled', val)}
                                className="scale-75 data-[state=checked]:bg-blue-500"
                            />
                        </div>
                        {config.layer2Enabled && (
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[10px] text-slate-400 block mb-1">Max Spread (bps)</label>
                                    <Input
                                        type="number"
                                        value={config.maxSpreadBps}
                                        onChange={(e) => updateConfig('maxSpreadBps', Number(e.target.value))}
                                        className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        step="5"
                                    />
                                    <div className="flex items-center gap-2 mt-2">
                                        <Switch
                                            checked={config.dynamicSpreadEnabled}
                                            onCheckedChange={(val) => updateConfig('dynamicSpreadEnabled', val)}
                                            className="scale-75 data-[state=checked]:bg-blue-500"
                                        />
                                        <label className="text-[10px] text-slate-400">Dynamic Scaling</label>
                                    </div>
                                </div>
                                <div>
                                    <div className="flex justify-between items-center mb-1">
                                        <label className="text-[10px] text-slate-400">Min Depth</label>
                                        <span className="text-[10px] text-slate-500 font-mono">
                                            ${(config.minDepthUsd / 1000).toFixed(0)}k
                                        </span>
                                    </div>
                                    <Input
                                        type="number"
                                        value={config.minDepthUsd}
                                        onChange={(e) => updateConfig('minDepthUsd', Number(e.target.value))}
                                        className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        step="1000"
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Layer 3: Volatility */}
                    <div className="p-2 bg-slate-950/50 rounded-lg border border-slate-800">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-purple-500/30 text-purple-400 bg-purple-500/5">
                                    L3
                                </Badge>
                                <span className="text-xs font-semibold text-slate-200">Volatility</span>
                            </div>
                            <Switch
                                checked={config.layer3Enabled}
                                onCheckedChange={(val) => updateConfig('layer3Enabled', val)}
                                className="scale-75 data-[state=checked]:bg-purple-500"
                            />
                        </div>
                        {config.layer3Enabled && (
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[10px] text-slate-400 block mb-1">Min Vol Z</label>
                                    <Input
                                        type="number"
                                        value={config.minVolZscore}
                                        onChange={(e) => updateConfig('minVolZscore', Number(e.target.value))}
                                        className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        step="0.1"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] text-slate-400 block mb-1">Min Ret Z</label>
                                    <Input
                                        type="number"
                                        value={config.minRetZscore}
                                        onChange={(e) => updateConfig('minRetZscore', Number(e.target.value))}
                                        className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        step="0.1"
                                    />
                                </div>
                                <div className="col-span-2">
                                    <div className="flex justify-between items-center mb-1">
                                        <label className="text-[10px] text-slate-400">Min Realized Vol</label>
                                        <span className="text-[10px] text-slate-500 font-mono">
                                            {(config.minRealizedVol * 100).toFixed(2)}%
                                        </span>
                                    </div>
                                    <Input
                                        type="number"
                                        value={config.minRealizedVol}
                                        onChange={(e) => updateConfig('minRealizedVol', Number(e.target.value))}
                                        className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        step="0.0001"
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Layer 4: Scoring */}
                    <div className="p-2 bg-slate-950/50 rounded-lg border border-slate-800">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-green-500/30 text-green-400 bg-green-500/5">
                                    L4
                                </Badge>
                                <span className="text-xs font-semibold text-slate-200">Selection</span>
                            </div>
                            <Switch
                                checked={config.layer4Enabled}
                                onCheckedChange={(val) => updateConfig('layer4Enabled', val)}
                                className="scale-75 data-[state=checked]:bg-green-500"
                            />
                        </div>
                        {config.layer4Enabled && (
                            <div className="space-y-3">
                                <div>
                                    <label className="text-[10px] text-slate-400 block mb-1">Max Symbols</label>
                                    <Input
                                        type="number"
                                        value={config.topN}
                                        onChange={(e) => updateConfig('topN', Number(e.target.value))}
                                        className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        step="1"
                                        min="1"
                                        max="50"
                                    />
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="text-[10px] text-slate-400 block mb-1">Vol Weight</label>
                                        <Input
                                            type="number"
                                            step="0.1"
                                            value={config.quality_weights.vol_score}
                                            onChange={(e) => updateConfig('quality_weights', { ...config.quality_weights, vol_score: Number(e.target.value) })}
                                            className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400 block mb-1">Move Weight</label>
                                        <Input
                                            type="number"
                                            step="0.1"
                                            value={config.quality_weights.move_score}
                                            onChange={(e) => updateConfig('quality_weights', { ...config.quality_weights, move_score: Number(e.target.value) })}
                                            className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400 block mb-1">Trend Align Bonus</label>
                                        <Input
                                            type="number"
                                            step="0.1"
                                            value={config.quality_weights.trend_align}
                                            onChange={(e) => updateConfig('quality_weights', { ...config.quality_weights, trend_align: Number(e.target.value) })}
                                            className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400 block mb-1">Spread Penalty</label>
                                        <Input
                                            type="number"
                                            step="0.1"
                                            value={config.quality_weights.spread_penalty}
                                            onChange={(e) => updateConfig('quality_weights', { ...config.quality_weights, spread_penalty: Number(e.target.value) })}
                                            className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400 block mb-1">Illiquidity Penalty</label>
                                        <Input
                                            type="number"
                                            step="0.1"
                                            value={config.quality_weights.illiquidity_penalty}
                                            onChange={(e) => updateConfig('quality_weights', { ...config.quality_weights, illiquidity_penalty: Number(e.target.value) })}
                                            className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </CardContent>
            )}
        </Card>
    )
}
