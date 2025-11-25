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
    layer2Enabled: boolean;
    maxSpreadBps: number;
    minDepthUsd: number;
    layer3Enabled: boolean;
    minVolZscore: number;
    minRetZscore: number;
    minRealizedVol: number;
    minRetM5: number;
    minRetM15: number;
    layer4Enabled: boolean;
    topN: number;
}

const DEFAULT_CONFIG: ScreeningConfig = {
    layer1Enabled: true,
    minVolume24h: 1_000_000,
    layer2Enabled: true,
    maxSpreadBps: 50,
    minDepthUsd: 10_000,
    layer3Enabled: true,
    minVolZscore: 0.5,
    minRetZscore: 0.5,
    minRealizedVol: 0.0005,
    minRetM5: 0.0001,
    minRetM15: 0.0001,
    layer4Enabled: true,
    topN: 20
}

export function ScreeningParameters() {
    const [config, setConfig] = useState<ScreeningConfig>(DEFAULT_CONFIG)
    const [expanded, setExpanded] = useState(true)
    const [loaded, setLoaded] = useState(false)

    // Load from localStorage on mount
    useEffect(() => {
        const saved = localStorage.getItem('screeningConfig')
        if (saved) {
            try {
                setConfig(JSON.parse(saved))
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
                <CardContent className="p-2 space-y-2">
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
                            <div className="grid grid-cols-1 gap-2">
                                <div>
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
                        )}
                    </div>
                </CardContent>
            )}
        </Card>
    )
}
