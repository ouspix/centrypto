"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Loader2, Play, Download, BarChart3 } from "lucide-react"
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'

type BacktestResult = {
    run_id: string
    metrics: {
        net_pnl_usd: number
        trade_count: number
        win_rate: number
    }
    equity_curve?: Array<{ ts: string; equity_usd: number }>
}

export function Backtester() {
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState<BacktestResult | null>(null)
    const [config, setConfig] = useState({
        start: "",
        end: "",
        initialCapital: 10000,
        policyName: "take_top_rank"
    })

    const runBacktest = async () => {
        setLoading(true)
        setResult(null)
        try {
            const response = await fetch('/api/backtest/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            })

            if (!response.ok) {
                throw new Error('Backtest failed')
            }

            const data = await response.json()
            setResult(data)
        } catch (error) {
            console.error("Backtest error:", error)
        } finally {
            setLoading(false)
        }
    }

    const downloadResults = () => {
        if (!result) return
        const dataStr = JSON.stringify(result, null, 2)
        const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr)
        const exportFileDefaultName = `backtest_${result.run_id}_${Date.now()}.json`

        const linkElement = document.createElement('a')
        linkElement.setAttribute('href', dataUri)
        linkElement.setAttribute('download', exportFileDefaultName)
        linkElement.click()
    }

    const chartData = result?.equity_curve?.map((point, index) => ({
        index,
        value: point.equity_usd
    })) || []

    const pnl = result ? result.metrics.net_pnl_usd : 0
    const winRate = result ? result.metrics.win_rate * 100 : 0
    const finalEquity = result?.equity_curve?.[result.equity_curve.length - 1]?.equity_usd ?? config.initialCapital

    return (
        <Card className="bg-slate-900 border-slate-800 hover-lift">
            <CardHeader>
                <CardTitle className="text-lg font-bold text-cyan-400 flex items-center gap-2">
                    <BarChart3 className="h-5 w-5" />
                    Strategy Backtester
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="start" className="text-slate-400">Start</Label>
                        <Input
                            id="start"
                            type="datetime-local"
                            className="bg-slate-950 border-slate-800 text-slate-200"
                            value={config.start}
                            onChange={(e) => setConfig({ ...config, start: e.target.value })}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="end" className="text-slate-400">End</Label>
                        <Input
                            id="end"
                            type="datetime-local"
                            className="bg-slate-950 border-slate-800 text-slate-200"
                            value={config.end}
                            onChange={(e) => setConfig({ ...config, end: e.target.value })}
                        />
                    </div>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="capital" className="text-slate-400">Initial Capital (USDC)</Label>
                    <Input
                        id="capital"
                        type="number"
                        className="bg-slate-950 border-slate-800 text-slate-200"
                        value={config.initialCapital}
                        onChange={(e) => setConfig({ ...config, initialCapital: parseFloat(e.target.value) })}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="policy" className="text-slate-400">Policy</Label>
                    <select
                        id="policy"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-md text-slate-200"
                        value={config.policyName}
                        onChange={(e) => setConfig({ ...config, policyName: e.target.value })}
                    >
                        <option value="take_top_rank">Top Rank</option>
                        <option value="take_best_edge_cost">Best Edge/Cost</option>
                        <option value="clean_only">Clean Only</option>
                        <option value="take_none">Take None</option>
                    </select>
                </div>

                <Button
                    className="w-full bg-cyan-600 hover:bg-cyan-700"
                    onClick={runBacktest}
                    disabled={loading || !config.start || !config.end}
                >
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    <Play className="mr-2 h-4 w-4" />
                    Run Backtest
                </Button>

                {result && (
                    <div className="space-y-4 animate-fade-in">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                                <span className="text-xs text-slate-500">Total P&L</span>
                                <p className={`text-xl font-bold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                                </p>
                            </div>
                            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                                <span className="text-xs text-slate-500">Win Rate</span>
                                <p className={`text-xl font-bold ${winRate >= 50 ? 'text-green-400' : 'text-yellow-400'}`}>
                                    {winRate.toFixed(2)}%
                                </p>
                            </div>
                            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                                <span className="text-xs text-slate-500">Total Trades</span>
                                <p className="text-xl font-bold text-slate-200">
                                    {result.metrics.trade_count}
                                </p>
                            </div>
                            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                                <span className="text-xs text-slate-500">Final Capital</span>
                                <p className="text-xl font-bold text-slate-200">
                                    ${finalEquity.toFixed(2)}
                                </p>
                            </div>
                        </div>

                        {chartData.length > 0 && (
                            <div className="p-4 rounded-lg bg-slate-950 border border-slate-800">
                                <h4 className="text-sm font-semibold text-slate-400 mb-3">Equity Curve</h4>
                                <ResponsiveContainer width="100%" height={150}>
                                    <LineChart data={chartData}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                        <XAxis
                                            dataKey="index"
                                            stroke="#64748b"
                                            tick={{ fill: '#64748b', fontSize: 10 }}
                                        />
                                        <YAxis
                                            stroke="#64748b"
                                            tick={{ fill: '#64748b', fontSize: 10 }}
                                        />
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: '#0f172a',
                                                border: '1px solid #334155',
                                                borderRadius: '8px'
                                            }}
                                            itemStyle={{ color: '#94a3b8' }}
                                            labelStyle={{ color: '#cbd5e1' }}
                                        />
                                        <Line
                                            type="monotone"
                                            dataKey="value"
                                            stroke="#06b6d4"
                                            strokeWidth={2}
                                            dot={false}
                                        />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        )}

                        <Button
                            variant="outline"
                            className="w-full border-slate-700 hover:bg-slate-800"
                            onClick={downloadResults}
                        >
                            <Download className="mr-2 h-4 w-4" />
                            Export Results
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
