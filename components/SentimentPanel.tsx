"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, RefreshCw, TrendingUp, TrendingDown, Minus } from "lucide-react"
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts'

type SentimentData = {
    success: boolean
    sentiment_index: number
    details: { title: string; score: number }[]
    trend?: "improving" | "declining" | "stable"
}

import { useTrading } from "@/context/TradingContext"

export function SentimentPanel() {
    const [loading, setLoading] = useState(false)
    const [data, setData] = useState<SentimentData | null>(null)
    const [history, setHistory] = useState<{ time: number, value: number }[]>([])
    const { selectedPair } = useTrading()

    const fetchSentiment = async () => {
        setLoading(true)
        try {
            const res = await fetch(`/api/cron/sentiment?coin=${selectedPair}`)
            const json = await res.json()

            // Calculate trend based on history
            if (history.length > 0) {
                const lastValue = history[history.length - 1].value
                const currentValue = json.sentiment_index
                const diff = currentValue - lastValue
                json.trend = Math.abs(diff) < 0.02 ? "stable" : diff > 0 ? "improving" : "declining"
            }

            setData(json)

            // Update history (keep last 10 points)
            setHistory(prev => {
                const newHistory = [...prev, { time: Date.now(), value: json.sentiment_index }]
                return newHistory.slice(-10)
            })
        } catch (error) {
            console.error("Failed to fetch sentiment", error)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchSentiment()
        // Auto-refresh every 60 seconds
        const interval = setInterval(fetchSentiment, 60000)
        return () => clearInterval(interval)
    }, [selectedPair])

    const getTrendIcon = () => {
        if (!data?.trend) return <Minus className="h-4 w-4" />
        if (data.trend === "improving") return <TrendingUp className="h-4 w-4 text-green-400" />
        if (data.trend === "declining") return <TrendingDown className="h-4 w-4 text-red-400" />
        return <Minus className="h-4 w-4 text-yellow-400" />
    }

    return (
        <Card className="bg-slate-900 border-slate-800 h-full hover-lift">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-lg font-bold text-blue-400">Sentiment: {selectedPair}</CardTitle>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={fetchSentiment}
                    disabled={loading}
                    className="hover:bg-slate-800"
                >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                </Button>
            </CardHeader>
            <CardContent>
                {!data ? (
                    <div className="text-center text-slate-500 py-8">
                        <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
                        Analyzing market sentiment...
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="flex items-center justify-between p-3 bg-gradient-to-br from-slate-950 to-slate-900 rounded-lg border border-slate-800 shadow-lg">
                            <div className="flex flex-col">
                                <span className="text-sm text-slate-400">Sentiment Index</span>
                                <span className={`text-2xl font-bold ${data.sentiment_index > 0.05 ? 'text-green-400' :
                                        data.sentiment_index < -0.05 ? 'text-red-400' :
                                            'text-yellow-400'
                                    }`}>
                                    {data.sentiment_index.toFixed(4)}
                                </span>
                            </div>
                            <div className="flex flex-col items-end gap-2">
                                <Badge
                                    variant="outline"
                                    className={`${data.sentiment_index > 0.05 ? 'border-green-500 text-green-400 bg-green-500/10' :
                                            data.sentiment_index < -0.05 ? 'border-red-500 text-red-400 bg-red-500/10' :
                                                'border-yellow-500 text-yellow-400 bg-yellow-500/10'
                                        }`}
                                >
                                    {data.sentiment_index > 0.05 ? 'BULLISH' : data.sentiment_index < -0.05 ? 'BEARISH' : 'NEUTRAL'}
                                </Badge>
                                {data.trend && (
                                    <div className="flex items-center gap-1 text-xs text-slate-400">
                                        {getTrendIcon()}
                                        <span className="capitalize">{data.trend}</span>
                                    </div>
                                )}
                            </div>
                        </div>

                        {history.length > 2 && (
                            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Trend</h4>
                                <ResponsiveContainer width="100%" height={60}>
                                    <LineChart data={history}>
                                        <Line
                                            type="monotone"
                                            dataKey="value"
                                            stroke="#3b82f6"
                                            strokeWidth={2}
                                            dot={false}
                                        />
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: '#0f172a',
                                                border: '1px solid #334155',
                                                borderRadius: '8px'
                                            }}
                                            itemStyle={{ color: '#94a3b8' }}
                                            formatter={(value: any) => value.toFixed(4)}
                                        />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        )}

                        <div className="space-y-2">
                            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Latest Headlines</h4>
                            {data.details.map((item, i) => (
                                <div
                                    key={i}
                                    className="text-sm border-l-2 border-slate-800 pl-3 py-1 hover:border-blue-500 transition-colors animate-slide-in"
                                    style={{ animationDelay: `${i * 0.1}s` }}
                                >
                                    <p className="text-slate-300 line-clamp-1">{item.title}</p>
                                    <p className={`text-xs ${item.score > 0 ? 'text-green-400' :
                                            item.score < 0 ? 'text-red-400' :
                                                'text-slate-500'
                                        }`}>
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
