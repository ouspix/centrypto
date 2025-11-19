"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, BrainCircuit } from "lucide-react"
import { useTrading } from "@/context/TradingContext"

type AnalysisResult = {
    action: "LONG" | "SHORT" | "HOLD"
    confidence: number
    reasoning: string
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
                confidence: 0,
                reasoning: "Could not connect to AI Orchestrator. Ensure Ollama is running locally with 'deepseek-r1:14b'."
            })
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        setAnalysis(null)
    }, [selectedPair])

    return (
        <Card className="bg-slate-900 border-slate-800 h-full">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-lg font-bold text-purple-400 flex items-center gap-2">
                    <BrainCircuit className="h-5 w-5" />
                    AI Advisor
                </CardTitle>
                <Button variant="outline" size="sm" onClick={analyzeMarket} disabled={loading} className="border-purple-500/50 text-purple-400 hover:bg-purple-900/20">
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
                    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <div className="flex items-center justify-between p-4 bg-slate-950 rounded-lg border border-slate-800">
                            <div className="flex flex-col">
                                <span className="text-sm text-slate-400">Recommendation</span>
                                <span className={`text-2xl font-bold ${analysis.action === 'LONG' ? 'text-green-500' : analysis.action === 'SHORT' ? 'text-red-500' : 'text-yellow-500'}`}>
                                    {analysis.action}
                                </span>
                            </div>
                            <div className="flex flex-col items-end">
                                <span className="text-sm text-slate-400">Confidence</span>
                                <Badge variant="outline" className={`text-lg ${analysis.confidence > 80 ? 'border-green-500 text-green-500' : 'border-yellow-500 text-yellow-500'}`}>
                                    {analysis.confidence}%
                                </Badge>
                            </div>
                        </div>

                        <div className="p-4 bg-purple-900/10 rounded-lg border border-purple-900/20">
                            <h4 className="text-xs font-semibold text-purple-400 uppercase tracking-wider mb-2">Reasoning</h4>
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
