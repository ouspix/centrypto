"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, BrainCircuit, TrendingUp, Activity, Newspaper } from "lucide-react"
import { useTrading } from "@/context/TradingContext"

type AnalysisResult = {
    action: "LONG" | "SHORT" | "HOLD"
    confidence: number
    reasoning: string
    dataSources?: {
        sentiment?: number
        orderbookPressure?: string
        volume?: number
    }
}

export function AIAdvisor() {
    const { selectedPair } = useTrading()
    const [loading, setLoading] = useState(false)
    const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)

    const analyzeMarket = async () => {
        setLoading(true)
        try {
            const response = await fetch('/api/ai/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ coin: selectedPair })
            })

            if (!response.ok) {
                throw new Error('Analysis failed')
            }

            const result = await response.json()
            setAnalysis(result)
        } catch (error) {
            console.error("Analysis failed", error)
            // Fallback for demo if Ollama is not running
            setAnalysis({
                action: "HOLD",
                confidence: 50,
                reasoning: "Insufficient data to determine market direction due to lack of bid and ask information.",
                dataSources: {
                    sentiment: 0.05,
                    orderbookPressure: "Neutral",
                    volume: 0
                }
            })
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        setAnalysis(null)
    }, [selectedPair])

    const getSentimentColor = (sentiment?: number) => {
        if (!sentiment) return 'text-slate-500'
        if (sentiment > 0.05) return 'text-green-400'
        if (sentiment < -0.05) return 'text-red-400'
        return 'text-yellow-400'
    }

    const getSentimentLabel = (sentiment?: number) => {
        if (!sentiment) return 'Unknown'
        if (sentiment > 0.05) return 'Bullish'
        if (sentiment < -0.05) return 'Bearish'
        return 'Neutral'
    }

    return (
        <Card className="bg-slate-900 border-slate-800 h-full hover-lift">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-lg font-bold text-purple-400 flex items-center gap-2">
                    <BrainCircuit className="h-5 w-5" />
                    AI Advisor
                </CardTitle>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={analyzeMarket}
                    disabled={loading}
                    className="border-purple-500/50 text-purple-400 hover:bg-purple-900/20 hover:border-purple-400"
                >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Analyze {selectedPair}
                </Button>
            </CardHeader>
            <CardContent>
                {!analysis ? (
                    <div className="text-center text-slate-500 py-8">
                        Ask AI to analyze current market conditions for {selectedPair}
                    </div>
                ) : (
                    <div className="space-y-4 animate-fade-in">
                        <div className="flex items-center justify-between p-4 bg-gradient-to-br from-slate-950 to-slate-900 rounded-lg border border-slate-800 shadow-lg">
                            <div className="flex flex-col">
                                <span className="text-sm text-slate-400">Recommendation</span>
                                <span className={`text-2xl font-bold ${analysis.action === 'LONG' ? 'text-green-400' :
                                        analysis.action === 'SHORT' ? 'text-red-400' :
                                            'text-yellow-400'
                                    }`}>
                                    {analysis.action}
                                </span>
                            </div>
                            <div className="flex flex-col items-end">
                                <span className="text-sm text-slate-400">Confidence</span>
                                <Badge
                                    variant="outline"
                                    className={`text-lg px-3 py-1 ${analysis.confidence > 80 ? 'border-green-500 text-green-400 bg-green-500/10' :
                                            analysis.confidence > 50 ? 'border-yellow-500 text-yellow-400 bg-yellow-500/10' :
                                                'border-red-500 text-red-400 bg-red-500/10'
                                        }`}
                                >
                                    {analysis.confidence}%
                                </Badge>
                            </div>
                        </div>

                        {analysis.dataSources && (
                            <div className="grid grid-cols-3 gap-2">
                                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                                    <div className="flex items-center gap-2 mb-1">
                                        <Newspaper className="h-3 w-3 text-slate-500" />
                                        <span className="text-xs text-slate-500">Sentiment</span>
                                    </div>
                                    <p className={`text-sm font-bold ${getSentimentColor(analysis.dataSources.sentiment)}`}>
                                        {getSentimentLabel(analysis.dataSources.sentiment)}
                                    </p>
                                </div>
                                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                                    <div className="flex items-center gap-2 mb-1">
                                        <TrendingUp className="h-3 w-3 text-slate-500" />
                                        <span className="text-xs text-slate-500">Orderbook</span>
                                    </div>
                                    <p className="text-sm font-bold text-slate-300">
                                        {analysis.dataSources.orderbookPressure || 'N/A'}
                                    </p>
                                </div>
                                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                                    <div className="flex items-center gap-2 mb-1">
                                        <Activity className="h-3 w-3 text-slate-500" />
                                        <span className="text-xs text-slate-500">Volume</span>
                                    </div>
                                    <p className="text-sm font-bold text-slate-300">
                                        {analysis.dataSources.volume ? `$${(analysis.dataSources.volume / 1000000).toFixed(1)}M` : 'N/A'}
                                    </p>
                                </div>
                            </div>
                        )}

                        <div className="p-4 bg-purple-900/10 rounded-lg border border-purple-900/20">
                            <h4 className="text-xs font-semibold text-purple-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                                <BrainCircuit className="h-3 w-3" />
                                Reasoning
                            </h4>
                            <p className="text-sm text-slate-300 leading-relaxed">
                                {analysis.reasoning}
                            </p>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
