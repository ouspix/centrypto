"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts'
import { Loader2, Wallet, TrendingUp, BarChart3 } from "lucide-react"
import { useAccountData } from "@/hooks/useAccountData"

export function Dashboard() {
    const { accountValue, spotUsdc, equitySource, unrealizedPnl: pnl, loading, error } = useAccountData()
    const spotUsdcValue = parseFloat(spotUsdc)
    const spotLabel = equitySource === "spot_usdc" ? "Unified/spot USDC" : "Spot USDC"

    // Mock history for chart (Hyperliquid doesn't give history easily in one call)
    const data = [
        { name: 'Jan', value: 4000 },
        { name: 'Feb', value: 3000 },
        { name: 'Mar', value: 2000 },
        { name: 'Apr', value: 2780 },
        { name: 'May', value: 1890 },
        { name: 'Jun', value: 2390 },
        { name: 'Jul', value: 3490 },
    ]

    return (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-slate-700 hover-lift">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-slate-400 flex items-center gap-2">
                        <Wallet className="h-4 w-4" />
                        Account Value
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold text-slate-100">
                        {loading && accountValue === "0.00" ? (
                            <Loader2 className="h-6 w-6 animate-spin" />
                        ) : error ? (
                            <span className="text-amber-300" title={error}>
                                Unavailable
                            </span>
                        ) : (
                            <span className="bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
                                ${accountValue}
                            </span>
                        )}
                        {!error && spotUsdcValue > 0 && (
                            <div className="mt-1 text-xs font-normal text-slate-400">
                                {spotLabel} ${spotUsdc}
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>
            <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-slate-700 hover-lift">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-slate-400 flex items-center gap-2">
                        <TrendingUp className="h-4 w-4" />
                        Unrealized PnL
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className={`text-2xl font-bold ${parseFloat(pnl) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {loading && pnl === "0.00" ? (
                            <Loader2 className="h-6 w-6 animate-spin" />
                        ) : error ? (
                            <span className="text-slate-500" title={error}>
                                --
                            </span>
                        ) : (
                            `${parseFloat(pnl) >= 0 ? '+' : ''}$${pnl}`
                        )}
                    </div>
                </CardContent>
            </Card>
            <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-slate-700 col-span-2 lg:col-span-1 hover-lift">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-slate-400 flex items-center gap-2">
                        <BarChart3 className="h-4 w-4" />
                        Equity History (Mock)
                    </CardTitle>
                </CardHeader>
                <CardContent className="h-[80px]">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={data}>
                            <Line
                                type="monotone"
                                dataKey="value"
                                stroke="url(#colorGradient)"
                                strokeWidth={2}
                                dot={false}
                            />
                            <defs>
                                <linearGradient id="colorGradient" x1="0" y1="0" x2="1" y2="0">
                                    <stop offset="0%" stopColor="#3b82f6" />
                                    <stop offset="100%" stopColor="#8b5cf6" />
                                </linearGradient>
                            </defs>
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: '#0f172a',
                                    border: '1px solid #334155',
                                    borderRadius: '8px'
                                }}
                                itemStyle={{ color: '#94a3b8' }}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>
        </div>
    )
}
