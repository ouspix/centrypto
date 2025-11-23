"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { History, TrendingUp, TrendingDown, Loader2, DollarSign } from "lucide-react"
import { useAccount } from "wagmi"

type Trade = {
    id: string;
    symbol: string;
    side: 'long' | 'short';
    entryPrice: number;
    exitPrice?: number;
    size: number;
    leverage: number;
    realizedPnl?: number;
    fees: number;
    status: 'open' | 'closed';
    openedAt: Date;
    closedAt?: Date;
    strategyName?: string;
};

type TradeAnalytics = {
    totalTrades: number;
    openTrades: number;
    closedTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    avgWin: number;
    avgLoss: number;
    largestWin: number;
    largestLoss: number;
    profitFactor: number;
    avgHoldTime: number;
};

export function TradeHistory() {
    const { address } = useAccount()
    const [trades, setTrades] = useState<Trade[]>([])
    const [analytics, setAnalytics] = useState<TradeAnalytics | null>(null)
    const [loading, setLoading] = useState(false)
    const [view, setView] = useState<'recent' | 'analytics'>('recent')

    useEffect(() => {
        if (address) {
            fetchTrades()
            fetchAnalytics()
        }
    }, [address])

    const fetchTrades = async () => {
        if (!address) return

        setLoading(true)
        try {
            const response = await fetch(`/api/trades?userAddress=${address}&limit=20`)
            const data = await response.json()
            if (data.trades) {
                setTrades(data.trades)
            }
        } catch (error) {
            console.error("Failed to fetch trades:", error)
        } finally {
            setLoading(false)
        }
    }

    const fetchAnalytics = async () => {
        if (!address) return

        try {
            const response = await fetch(`/api/trades?userAddress=${address}&analytics=true`)
            const data = await response.json()
            if (data.analytics) {
                setAnalytics(data.analytics)
            }
        } catch (error) {
            console.error("Failed to fetch analytics:", error)
        }
    }

    const formatDate = (date: Date) => {
        return new Date(date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        })
    }

    const formatPnl = (pnl: number) => {
        const sign = pnl >= 0 ? '+' : ''
        return `${sign}$${pnl.toFixed(2)}`
    }

    return (
        <Card className="bg-slate-900 border-slate-800 hover-lift">
            <CardHeader className="pb-3 border-b border-slate-800/50">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-xl font-bold text-emerald-400 flex items-center gap-2">
                        <History className="h-6 w-6" />
                        Trade History
                    </CardTitle>
                    <div className="flex gap-1">
                        <button
                            onClick={() => setView('recent')}
                            className={`px-2 py-1 text-[10px] rounded transition-colors ${view === 'recent'
                                ? 'bg-emerald-600 text-white'
                                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                                }`}
                        >
                            Recent
                        </button>
                        <button
                            onClick={() => setView('analytics')}
                            className={`px-2 py-1 text-[10px] rounded transition-colors ${view === 'analytics'
                                ? 'bg-emerald-600 text-white'
                                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                                }`}
                        >
                            Analytics
                        </button>
                    </div>
                </div>
            </CardHeader>

            <CardContent className="p-3">
                {loading && trades.length === 0 && (
                    <div className="flex items-center justify-center h-32 text-slate-500">
                        <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                )}

                {view === 'recent' && (
                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                        {trades.length === 0 && !loading && (
                            <div className="text-center py-8 text-slate-500 text-base">
                                No trades recorded yet
                            </div>
                        )}

                        {trades.map((trade) => (
                            <div
                                key={trade.id}
                                className="p-2 bg-slate-950/50 rounded-lg border border-slate-800 hover:border-slate-700 transition-colors"
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <div className="flex items-center gap-2">
                                        <span className="text-base font-mono font-bold text-slate-200">
                                            {trade.symbol}
                                        </span>
                                        <Badge
                                            variant="outline"
                                            className={`text-sm px-2.5 py-1 ${trade.side === 'long'
                                                ? 'border-green-500/50 text-green-400 bg-green-500/10'
                                                : 'border-red-500/50 text-red-400 bg-red-500/10'
                                                }`}
                                        >
                                            {trade.side === 'long' ? <TrendingUp className="h-2.5 w-2.5 mr-0.5" /> : <TrendingDown className="h-2.5 w-2.5 mr-0.5" />}
                                            {trade.side.toUpperCase()}
                                        </Badge>
                                        {trade.status === 'open' && (
                                            <Badge variant="outline" className="text-sm px-2.5 py-1 border-cyan-500/50 text-cyan-400">
                                                OPEN
                                            </Badge>
                                        )}
                                    </div>
                                    {trade.status === 'closed' && trade.realizedPnl !== undefined && (
                                        <span
                                            className={`text-base font-mono font-bold ${trade.realizedPnl >= 0 ? 'text-green-400' : 'text-red-400'
                                                }`}
                                        >
                                            {formatPnl(trade.realizedPnl)}
                                        </span>
                                    )}
                                </div>

                                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">Entry</span>
                                        <span className="font-mono text-slate-300">${trade.entryPrice.toFixed(2)}</span>
                                    </div>
                                    {trade.exitPrice && (
                                        <div className="flex justify-between">
                                            <span className="text-slate-500">Exit</span>
                                            <span className="font-mono text-slate-300">${trade.exitPrice.toFixed(2)}</span>
                                        </div>
                                    )}
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">Size</span>
                                        <span className="font-mono text-slate-300">{trade.size.toFixed(4)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">Leverage</span>
                                        <span className="font-mono text-purple-400">{trade.leverage}x</span>
                                    </div>
                                </div>

                                <div className="mt-1 pt-1 border-t border-slate-800/50 text-sm text-slate-500">
                                    {formatDate(trade.openedAt)}
                                    {trade.strategyName && ` • ${trade.strategyName}`}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {view === 'analytics' && analytics && (
                    <div className="space-y-3">
                        {/* Summary Cards */}
                        <div className="grid grid-cols-2 gap-2">
                            <div className="p-2.5 bg-slate-950/50 rounded-lg border border-slate-800">
                                <div className="text-sm text-slate-500 mb-1">Total P&L</div>
                                <div className={`text-lg font-bold font-mono ${analytics.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'
                                    }`}>
                                    {formatPnl(analytics.totalPnl)}
                                </div>
                            </div>
                            <div className="p-2.5 bg-slate-950/50 rounded-lg border border-slate-800">
                                <div className="text-sm text-slate-500 mb-1">Win Rate</div>
                                <div className="text-lg font-bold font-mono text-cyan-400">
                                    {analytics.winRate.toFixed(1)}%
                                </div>
                            </div>
                        </div>

                        {/* Detailed Stats */}
                        <div className="p-2.5 bg-slate-950/50 rounded-lg border border-slate-800 space-y-1.5">
                            <div className="flex justify-between text-[10px]">
                                <span className="text-slate-500">Total Trades</span>
                                <span className="font-mono text-slate-300">{analytics.totalTrades}</span>
                            </div>
                            <div className="flex justify-between text-[10px]">
                                <span className="text-slate-500">Open / Closed</span>
                                <span className="font-mono text-slate-300">
                                    {analytics.openTrades} / {analytics.closedTrades}
                                </span>
                            </div>
                            <div className="flex justify-between text-[10px]">
                                <span className="text-slate-500">Wins / Losses</span>
                                <span className="font-mono text-slate-300">
                                    <span className="text-green-400">{analytics.winningTrades}</span>
                                    {' / '}
                                    <span className="text-red-400">{analytics.losingTrades}</span>
                                </span>
                            </div>
                            <div className="flex justify-between text-[10px]">
                                <span className="text-slate-500">Avg Win</span>
                                <span className="font-mono text-green-400">+${analytics.avgWin.toFixed(2)}</span>
                            </div>
                            <div className="flex justify-between text-[10px]">
                                <span className="text-slate-500">Avg Loss</span>
                                <span className="font-mono text-red-400">-${analytics.avgLoss.toFixed(2)}</span>
                            </div>
                            <div className="flex justify-between text-[10px]">
                                <span className="text-slate-500">Profit Factor</span>
                                <span className="font-mono text-purple-400">
                                    {analytics.profitFactor === Infinity ? '∞' : analytics.profitFactor.toFixed(2)}
                                </span>
                            </div>
                            <div className="flex justify-between text-[10px]">
                                <span className="text-slate-500">Avg Hold Time</span>
                                <span className="font-mono text-slate-300">{analytics.avgHoldTime.toFixed(1)}h</span>
                            </div>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
