"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, Activity, Loader2 } from "lucide-react"
import { useTrading } from "@/context/TradingContext"

type TechnicalIndicators = {
    rsi: {
        value: number;
        signal: 'overbought' | 'oversold' | 'neutral';
    };
    macd: {
        macd: number;
        signal: number;
        histogram: number;
        trend: 'bullish' | 'bearish' | 'neutral';
    };
    bollingerBands: {
        upper: number;
        middle: number;
        lower: number;
        percentB: number;
        bandwidth: number;
    };
    ema: {
        ema9: number;
        ema21: number;
        ema50: number;
        ema200: number;
    };
    sma: {
        sma20: number;
        sma50: number;
        sma200: number;
    };
    atr: {
        value: number;
        normalized: number;
    };
};

export function AdvancedIndicators({ symbol }: { symbol?: string }) {
    const { isTestnet, selectedPair } = useTrading()
    const [indicators, setIndicators] = useState<TechnicalIndicators | null>(null)
    const [loading, setLoading] = useState(false)

    // Use selectedPair from context, fallback to prop or BTC
    const currentSymbol = selectedPair || symbol || "BTC"

    useEffect(() => {
        const fetchIndicators = async () => {
            setLoading(true)
            try {
                const response = await fetch(
                    `/api/indicators?symbol=${currentSymbol}&isTestnet=${isTestnet}`
                )
                const data = await response.json()
                if (data.indicators) {
                    setIndicators(data.indicators)
                }
            } catch (error) {
                console.error("Failed to fetch indicators:", error)
            } finally {
                setLoading(false)
            }
        }

        fetchIndicators()
        const interval = setInterval(fetchIndicators, 30000) // Update every 30s

        return () => clearInterval(interval)
    }, [currentSymbol, isTestnet])

    const getRSIColor = (value: number) => {
        if (value >= 70) return "text-red-400"
        if (value <= 30) return "text-green-400"
        return "text-slate-400"
    }

    const getMACDTrendColor = (trend: string) => {
        if (trend === 'bullish') return "text-green-400"
        if (trend === 'bearish') return "text-red-400"
        return "text-slate-400"
    }

    return (
        <Card className="bg-slate-900 border-slate-800 hover-lift">
            <CardHeader className="pb-3 border-b border-slate-800/50">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-xl font-bold text-cyan-400 flex items-center gap-2">
                        <Activity className="h-6 w-6" />
                        Technical Indicators
                    </CardTitle>
                    <Badge variant="outline" className="text-base border-cyan-500/30 text-cyan-400">
                        {currentSymbol}
                    </Badge>
                </div>
            </CardHeader>

            <CardContent className="p-3 space-y-3">
                {loading && !indicators && (
                    <div className="flex items-center justify-center h-32 text-slate-500">
                        <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                )}

                {indicators && (
                    <div className="space-y-3">
                        {/* RSI */}
                        <div className="p-2.5 bg-slate-950/50 rounded-lg border border-slate-800">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-base font-semibold text-slate-300">RSI (14)</span>
                                <Badge
                                    variant="outline"
                                    className={`text-sm px-2.5 py-1 ${indicators.rsi.signal === 'overbought'
                                        ? 'border-red-500/50 text-red-400 bg-red-500/10'
                                        : indicators.rsi.signal === 'oversold'
                                            ? 'border-green-500/50 text-green-400 bg-green-500/10'
                                            : 'border-slate-500/50 text-slate-400'
                                        }`}
                                >
                                    {indicators.rsi.signal.toUpperCase()}
                                </Badge>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full transition-all ${indicators.rsi.value >= 70 ? 'bg-red-500' :
                                            indicators.rsi.value <= 30 ? 'bg-green-500' :
                                                'bg-cyan-500'
                                            }`}
                                        style={{ width: `${indicators.rsi.value}%` }}
                                    />
                                </div>
                                <span className={`text-lg font-mono font-bold ${getRSIColor(indicators.rsi.value)}`}>
                                    {indicators.rsi.value.toFixed(1)}
                                </span>
                            </div>
                        </div>

                        {/* MACD */}
                        <div className="p-2.5 bg-slate-950/50 rounded-lg border border-slate-800">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-base font-semibold text-slate-300">MACD</span>
                                <Badge
                                    variant="outline"
                                    className={`text-sm px-2.5 py-1 ${indicators.macd.trend === 'bullish'
                                        ? 'border-green-500/50 text-green-400 bg-green-500/10'
                                        : indicators.macd.trend === 'bearish'
                                            ? 'border-red-500/50 text-red-400 bg-red-500/10'
                                            : 'border-slate-500/50 text-slate-400'
                                        }`}
                                >
                                    {indicators.macd.trend === 'bullish' && <TrendingUp className="h-3 w-3 mr-0.5" />}
                                    {indicators.macd.trend === 'bearish' && <TrendingDown className="h-3 w-3 mr-0.5" />}
                                    {indicators.macd.trend.toUpperCase()}
                                </Badge>
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-sm">
                                <div>
                                    <span className="text-slate-500 block">MACD</span>
                                    <span className={`font-mono font-bold ${getMACDTrendColor(indicators.macd.trend)}`}>
                                        {indicators.macd.macd.toFixed(2)}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-slate-500 block">Signal</span>
                                    <span className="font-mono font-bold text-slate-300">
                                        {indicators.macd.signal.toFixed(2)}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-slate-500 block">Hist</span>
                                    <span className={`font-mono font-bold ${indicators.macd.histogram > 0 ? 'text-green-400' : 'text-red-400'
                                        }`}>
                                        {indicators.macd.histogram.toFixed(2)}
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* Bollinger Bands */}
                        <div className="p-2.5 bg-slate-950/50 rounded-lg border border-slate-800">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-base font-semibold text-slate-300">Bollinger Bands</span>
                                <span className="text-sm text-slate-500">
                                    %B: {(indicators.bollingerBands.percentB * 100).toFixed(0)}%
                                </span>
                            </div>
                            <div className="space-y-1 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-slate-500">Upper</span>
                                    <span className="font-mono text-red-400">{indicators.bollingerBands.upper.toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-slate-500">Middle</span>
                                    <span className="font-mono text-slate-300">{indicators.bollingerBands.middle.toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-slate-500">Lower</span>
                                    <span className="font-mono text-green-400">{indicators.bollingerBands.lower.toFixed(2)}</span>
                                </div>
                            </div>
                        </div>

                        {/* Moving Averages */}
                        <div className="p-2.5 bg-slate-950/50 rounded-lg border border-slate-800">
                            <span className="text-base font-semibold text-slate-300 block mb-2">Moving Averages</span>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                                <div className="space-y-1">
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">EMA 9</span>
                                        <span className="font-mono text-cyan-400">{indicators.ema.ema9.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">EMA 21</span>
                                        <span className="font-mono text-cyan-400">{indicators.ema.ema21.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">EMA 50</span>
                                        <span className="font-mono text-cyan-400">{indicators.ema.ema50.toFixed(2)}</span>
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">SMA 20</span>
                                        <span className="font-mono text-purple-400">{indicators.sma.sma20.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">SMA 50</span>
                                        <span className="font-mono text-purple-400">{indicators.sma.sma50.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">ATR</span>
                                        <span className="font-mono text-orange-400">{indicators.atr.normalized.toFixed(2)}%</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card >
    )
}
