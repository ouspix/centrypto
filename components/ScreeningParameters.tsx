"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LabelWithTooltip } from "@/components/ui/label-with-tooltip"
import { Filter, ChevronDown, ChevronUp } from "lucide-react"
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG, SCREENER_PRESETS } from "@/lib/screener-config"

export function ScreeningParameters() {
    const [config, setConfig] = useState<ScreenerConfig>(DEFAULT_SCREENER_CONFIG)
    const [expanded, setExpanded] = useState(true)
    const [loaded, setLoaded] = useState(false)
    const [preset, setPreset] = useState<string>('Scalper Strict')

    // Load from localStorage on mount
    useEffect(() => {
        const saved = localStorage.getItem('screeningConfig')
        if (saved) {
            try {
                const loaded = JSON.parse(saved)
                // Merge with default to ensure new fields exist
                setConfig({ ...DEFAULT_SCREENER_CONFIG, ...loaded })
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

    const updateConfig = (key: keyof ScreenerConfig, value: any) => {
        setConfig(prev => ({ ...prev, [key]: value }))
        setPreset('custom')
    }

    const updateQualityWeight = (key: keyof ScreenerConfig['quality_weights'], value: number) => {
        setConfig(prev => ({
            ...prev,
            quality_weights: {
                ...prev.quality_weights,
                [key]: value
            }
        }))
        setPreset('custom')
    }

    const applyPreset = (key: string) => {
        const presetCfg = SCREENER_PRESETS[key];
        if (!presetCfg) return;
        setConfig(presetCfg);
        setPreset(key);
    }

    return (
        <TooltipProvider delayDuration={120}>
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
                            <LabelWithTooltip
                                label="Preset"
                                tooltip="Load saved screening filters, gates, and scoring weights."
                                className="text-xs text-slate-300 font-semibold"
                                labelClassName="text-xs text-slate-300 font-semibold"
                            />
                            <select
                                value={preset}
                                onChange={(e) => applyPreset(e.target.value)}
                                className="text-xs bg-slate-950 border border-slate-700 text-slate-100 rounded-md px-2 py-1 focus:outline-none focus:border-cyan-500"
                            >
                                {Object.keys(SCREENER_PRESETS).map(key => (
                                    <option key={key} value={key}>{key}</option>
                                ))}
                                <option value="custom">Custom (saved)</option>
                            </select>
                        </div>

                        {/* Layer 1: Universe */}
                        <div className="p-2 bg-slate-950/50 rounded-lg border border-slate-800">
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-cyan-500/30 text-cyan-400 bg-cyan-500/5">
                                        L1
                                    </Badge>
                                    <LabelWithTooltip
                                        label="Universe"
                                        tooltip="Enable the 24h volume gate to drop illiquid tickers before deeper screening."
                                        className="text-xs font-semibold text-slate-200"
                                        labelClassName="text-xs font-semibold text-slate-200"
                                    />
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
                                            <LabelWithTooltip
                                                label="Min 24h Vol"
                                                tooltip="Floor on trailing 24h quote volume to keep a symbol in the tradable universe."
                                                labelClassName="text-[10px] text-slate-400"
                                            />
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
                                </div>
                            )}
                        </div>

                        {/* Layer 2: Activity */}
                        <div className="p-2 bg-slate-950/50 rounded-lg border border-slate-800">
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-purple-500/30 text-purple-400 bg-purple-500/5">
                                        L2
                                    </Badge>
                                    <LabelWithTooltip
                                        label="Activity"
                                        tooltip="Short-term activity gate based on fresh volume and realized vol so we only scan names currently moving."
                                        className="text-xs font-semibold text-slate-200"
                                        labelClassName="text-xs font-semibold text-slate-200"
                                    />
                                </div>
                                <Switch
                                    checked={config.layer3Enabled} // Using layer3Enabled for Activity/Vol layer
                                    onCheckedChange={(val) => updateConfig('layer3Enabled', val)}
                                    className="scale-75 data-[state=checked]:bg-purple-500"
                                />
                            </div>
                            {config.layer3Enabled && (
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <div className="flex justify-between items-center mb-1">
                                            <LabelWithTooltip
                                                label="Recent Vol"
                                                tooltip="Minimum quote volume in the recent window to stay in-play."
                                                labelClassName="text-[10px] text-slate-400"
                                            />
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
                                            <LabelWithTooltip
                                                label="Window (m)"
                                                tooltip="Lookback window in minutes for measuring recent volume."
                                                labelClassName="text-[10px] text-slate-400"
                                            />
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
                                    <div className="col-span-2">
                                        <div className="flex justify-between items-center mb-1">
                                            <LabelWithTooltip
                                                label="Min Realized Vol"
                                                tooltip="Floor for realized volatility in the window (std of returns). Filters out totally stagnant markets."
                                                labelClassName="text-[10px] text-slate-400"
                                            />
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

                        {/* Layer 3: Liquidity */}
                        <div className="p-2 bg-slate-950/50 rounded-lg border border-slate-800">
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-blue-500/30 text-blue-400 bg-blue-500/5">
                                        L3
                                    </Badge>
                                    <LabelWithTooltip
                                        label="Liquidity"
                                        tooltip="Liquidity gates to avoid thin books: spread cap, minimum depth, and optional total cost cap."
                                        className="text-xs font-semibold text-slate-200"
                                        labelClassName="text-xs font-semibold text-slate-200"
                                    />
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
                                        <LabelWithTooltip
                                            label="Max Spread (bps)"
                                            tooltip="Hard cap on bid-ask spread in basis points to ensure executable prices."
                                            labelClassName="text-[10px] text-slate-400"
                                            className="block mb-1"
                                        />
                                        <Input
                                            type="number"
                                            value={config.maxSpreadBps}
                                            onChange={(e) => updateConfig('maxSpreadBps', Number(e.target.value))}
                                            className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                            step="5"
                                        />
                                    </div>
                                    <div>
                                        <div className="flex justify-between items-center mb-1">
                                            <LabelWithTooltip
                                                label="Min Depth"
                                                tooltip="Minimum aggregated book depth (bid and ask) required at the chosen depth bands."
                                                labelClassName="text-[10px] text-slate-400"
                                            />
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
                                    <div className="col-span-2">
                                        <div className="flex items-center justify-between mb-1">
                                            <LabelWithTooltip
                                                label="Max Cost (bps)"
                                                tooltip="Optional all-in cost ceiling (fees + spread + slippage) even when other gates pass."
                                                labelClassName="text-[10px] text-slate-400"
                                            />
                                            <span className="text-[10px] text-slate-600">(Optional)</span>
                                        </div>
                                        <Input
                                            type="number"
                                            value={config.maxCostBps || ''}
                                            placeholder="No Limit"
                                            onChange={(e) => updateConfig('maxCostBps', e.target.value ? Number(e.target.value) : undefined)}
                                            className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                            step="1"
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
                                    <LabelWithTooltip
                                        label="Quality Scoring"
                                        tooltip="Ranking weights applied after hard gates. Higher values reward or penalize the dimension more strongly."
                                        className="text-xs font-semibold text-slate-200"
                                        labelClassName="text-xs font-semibold text-slate-200"
                                    />
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
                                        <LabelWithTooltip
                                            label="Max Symbols"
                                            tooltip="Number of top-ranked symbols to keep after scoring is applied."
                                            labelClassName="text-[10px] text-slate-400"
                                            className="block mb-1"
                                        />
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
                                            <LabelWithTooltip
                                                label="Vol Weight"
                                                tooltip="Reward for realized volatility or vol ratio in the score."
                                                labelClassName="text-[10px] text-slate-400"
                                                className="block mb-1"
                                            />
                                            <Input
                                                type="number"
                                                step="0.1"
                                                value={config.quality_weights.vol_score}
                                                onChange={(e) => updateQualityWeight('vol_score', Number(e.target.value))}
                                                className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                            />
                                        </div>
                                        <div>
                                            <LabelWithTooltip
                                                label="Move Weight"
                                                tooltip="Reward for absolute move size / return sigma."
                                                labelClassName="text-[10px] text-slate-400"
                                                className="block mb-1"
                                            />
                                            <Input
                                                type="number"
                                                step="0.1"
                                                value={config.quality_weights.move_score}
                                                onChange={(e) => updateQualityWeight('move_score', Number(e.target.value))}
                                                className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                            />
                                        </div>
                                        <div>
                                            <LabelWithTooltip
                                                label="Trend Align"
                                                tooltip="Reward when m15 and h1 directions agree."
                                                labelClassName="text-[10px] text-slate-400"
                                                className="block mb-1"
                                            />
                                            <Input
                                                type="number"
                                                step="0.1"
                                                value={config.quality_weights.trend_align}
                                                onChange={(e) => updateQualityWeight('trend_align', Number(e.target.value))}
                                                className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                            />
                                        </div>
                                        <div>
                                            <LabelWithTooltip
                                                label="Spread Pen."
                                                tooltip="Penalty weight for wider spreads even if under the hard cap."
                                                labelClassName="text-[10px] text-slate-400"
                                                className="block mb-1"
                                            />
                                            <Input
                                                type="number"
                                                step="0.1"
                                                value={config.quality_weights.spread_penalty}
                                                onChange={(e) => updateQualityWeight('spread_penalty', Number(e.target.value))}
                                                className="h-7 bg-slate-900 border-slate-700 text-slate-200 text-xs px-2"
                                            />
                                        </div>
                                        <div>
                                            <LabelWithTooltip
                                                label="Illiq. Pen."
                                                tooltip="Penalty weight for shallow books even when they clear the hard minimum depth."
                                                labelClassName="text-[10px] text-slate-400"
                                                className="block mb-1"
                                            />
                                            <Input
                                                type="number"
                                                step="0.1"
                                                value={config.quality_weights.illiquidity_penalty}
                                                onChange={(e) => updateQualityWeight('illiquidity_penalty', Number(e.target.value))}
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
        </TooltipProvider>
    )
}
