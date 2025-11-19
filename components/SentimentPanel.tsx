"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, RefreshCw } from "lucide-react"

type SentimentData = {
    success: boolean
    sentiment_index: number
    details: { title: string; score: number }[]
}

import { useTrading } from "@/context/TradingContext"

export function SentimentPanel() {
    const [loading, setLoading] = useState(false)
    const [data, setData] = useState<SentimentData | null>(null)
    const { selectedPair } = useTrading()

    const fetchSentiment = async () => {
        setLoading(true)
        try {
            // In reality, pass selectedPair as query param
            const res = await fetch(`/api/cron/sentiment?coin=${selectedPair}`)
            const json = await res.json()
            setData(json)
        } catch (error) {
            console.error("Failed to fetch sentiment", error)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchSentiment()
    }, [selectedPair])

    return (
        <Card className="bg-slate-900 border-slate-800 h-full">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-lg font-bold text-blue-400">Sentiment: {selectedPair}</CardTitle>
                <Button variant="ghost" size="icon" onClick={fetchSentiment} disabled={loading}>
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                </Button>
            </CardHeader>
            <CardContent>
                {!data ? (
                    <div className="text-center text-slate-500 py-8">
                        Click refresh to analyze market sentiment
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="flex items-center justify-between p-3 bg-slate-950 rounded-lg border border-slate-800">
                            <span className="text-sm text-slate-400">Sentiment Index</span>
                            <div className="flex items-center gap-2">
                                <span className={`text-2xl font-bold ${data.sentiment_index > 0.05 ? 'text-green-500' : data.sentiment_index < -0.05 ? 'text-red-500' : 'text-yellow-500'}`}>
                                    {data.sentiment_index.toFixed(4)}
                                </span>
                                <Badge variant="outline" className="border-slate-700">
                                    {data.sentiment_index > 0.05 ? 'BULLISH' : data.sentiment_index < -0.05 ? 'BEARISH' : 'NEUTRAL'}
                                </Badge>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Latest Headlines</h4>
                            {data.details.map((item, i) => (
                                <div key={i} className="text-sm border-l-2 border-slate-800 pl-3 py-1">
                                    <p className="text-slate-300 line-clamp-1">{item.title}</p>
                                    <p className={`text-xs ${item.score > 0 ? 'text-green-500' : item.score < 0 ? 'text-red-500' : 'text-slate-500'}`}>
                                        Score: {item.score.toFixed(2)}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
