"use client"

import { useState, useEffect } from "react"
import { useAccount } from "wagmi"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, TrendingUp, TrendingDown, X, RefreshCw } from "lucide-react"
import { useTrading } from "@/context/TradingContext"

type Position = {
    coin: string
    szi: string // Size (positive for long, negative for short)
    entryPx: string
    positionValue: string
    unrealizedPnl: string
    returnOnEquity: string
    leverage: {
        value: number
    }
}

export function OpenPositions() {
    const { address, isConnected } = useAccount()
    const { isTestnet } = useTrading()
    const [positions, setPositions] = useState<Position[]>([])
    const [loading, setLoading] = useState(false)
    const [currentPrices, setCurrentPrices] = useState<Record<string, number>>({})
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
        setMounted(true)
    }, [])

    const fetchPositions = async () => {
        if (!address) return
        setLoading(true)
        try {
            const apiUrl = isTestnet
                ? 'https://api.hyperliquid-testnet.xyz/info'
                : 'https://api.hyperliquid.xyz/info'

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: "clearinghouseState",
                    user: address
                })
            })

            if (!response.ok) throw new Error('Failed to fetch positions')

            const data = await response.json()

            // Extract positions from assetPositions
            const openPositions = data.assetPositions
                .filter((ap: any) => parseFloat(ap.position.szi) !== 0)
                .map((ap: any) => ({
                    coin: ap.position.coin,
                    szi: ap.position.szi,
                    entryPx: ap.position.entryPx,
                    positionValue: ap.position.positionValue,
                    unrealizedPnl: ap.position.unrealizedPnl,
                    returnOnEquity: ap.position.returnOnEquity,
                    leverage: ap.position.leverage
                }))

            setPositions(openPositions)

            // Fetch current prices for all positions
            const pricePromises = openPositions.map(async (pos: Position) => {
                const priceRes = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: "allMids"
                    })
                })
                const priceData = await priceRes.json()
                return { coin: pos.coin, price: parseFloat(priceData[pos.coin] || "0") }
            })

            const prices = await Promise.all(pricePromises)
            const priceMap = prices.reduce((acc, { coin, price }) => {
                acc[coin] = price
                return acc
            }, {} as Record<string, number>)

            setCurrentPrices(priceMap)

        } catch (error) {
            console.error("Failed to fetch positions", error)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        if (isConnected && address) {
            fetchPositions()
            const interval = setInterval(fetchPositions, 5000)
            return () => clearInterval(interval)
        } else {
            setPositions([])
        }
    }, [address, isConnected, isTestnet])

    const closePosition = async (coin: string) => {
        // TODO: Implement close position logic
        console.log(`Closing position for ${coin}`)
    }

    if (!mounted) {
        return (
            <Card className="bg-slate-900 border-slate-800">
                <CardHeader>
                    <CardTitle className="text-lg font-bold text-emerald-400">Open Positions</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="text-center text-slate-500 py-8">
                        Loading...
                    </div>
                </CardContent>
            </Card>
        )
    }

    if (!isConnected) {
        return (
            <Card className="bg-slate-900 border-slate-800">
                <CardHeader>
                    <CardTitle className="text-lg font-bold text-emerald-400">Open Positions</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="text-center text-slate-500 py-8">
                        Connect wallet to view positions
                    </div>
                </CardContent>
            </Card>
        )
    }

    return (
        <Card className="bg-slate-900 border-slate-800 hover-lift">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-lg font-bold text-emerald-400 flex items-center gap-2">
                    <TrendingUp className="h-5 w-5" />
                    Open Positions
                    {positions.length > 0 && (
                        <Badge variant="outline" className="ml-2 border-emerald-500 text-emerald-400">
                            {positions.length}
                        </Badge>
                    )}
                </CardTitle>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={fetchPositions}
                    disabled={loading}
                    className="hover:bg-slate-800"
                >
                    {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <RefreshCw className="h-4 w-4" />
                    )}
                </Button>
            </CardHeader>
            <CardContent>
                {loading && positions.length === 0 ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
                    </div>
                ) : positions.length === 0 ? (
                    <div className="text-center text-slate-500 py-8">
                        No open positions
                    </div>
                ) : (
                    <div className="space-y-3">
                        {positions.map((position, index) => {
                            const size = parseFloat(position.szi)
                            const isLong = size > 0
                            const entryPrice = parseFloat(position.entryPx)
                            const currentPrice = currentPrices[position.coin] || entryPrice
                            const pnl = parseFloat(position.unrealizedPnl)
                            const roe = parseFloat(position.returnOnEquity) * 100
                            const posValue = parseFloat(position.positionValue)

                            return (
                                <div
                                    key={index}
                                    className="p-4 rounded-lg border border-slate-800 bg-slate-950/50 hover:bg-slate-950 transition-all animate-fade-in"
                                    style={{ animationDelay: `${index * 0.1}s` }}
                                >
                                    <div className="flex items-start justify-between mb-3">
                                        <div className="flex items-center gap-2">
                                            <span className="text-lg font-bold text-slate-100">
                                                {position.coin}
                                            </span>
                                            <Badge
                                                variant="outline"
                                                className={`${isLong
                                                    ? 'border-green-500 text-green-400 bg-green-500/10'
                                                    : 'border-red-500 text-red-400 bg-red-500/10'
                                                    }`}
                                            >
                                                {isLong ? (
                                                    <><TrendingUp className="h-3 w-3 mr-1" /> LONG</>
                                                ) : (
                                                    <><TrendingDown className="h-3 w-3 mr-1" /> SHORT</>
                                                )}
                                            </Badge>
                                            <Badge variant="outline" className="border-slate-700 text-slate-400">
                                                {position.leverage.value}x
                                            </Badge>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 hover:bg-red-500/20 hover:text-red-400"
                                            onClick={() => closePosition(position.coin)}
                                        >
                                            <X className="h-4 w-4" />
                                        </Button>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3 text-sm">
                                        <div>
                                            <span className="text-slate-500">Size</span>
                                            <p className="text-slate-200 font-mono">
                                                {Math.abs(size).toFixed(4)}
                                            </p>
                                        </div>
                                        <div>
                                            <span className="text-slate-500">Value</span>
                                            <p className="text-slate-200 font-mono">
                                                ${posValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                            </p>
                                        </div>
                                        <div>
                                            <span className="text-slate-500">Entry</span>
                                            <p className="text-slate-200 font-mono">
                                                ${entryPrice.toFixed(2)}
                                            </p>
                                        </div>
                                        <div>
                                            <span className="text-slate-500">Current</span>
                                            <p className="text-slate-200 font-mono">
                                                ${currentPrice.toFixed(2)}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="mt-3 pt-3 border-t border-slate-800 flex items-center justify-between">
                                        <div>
                                            <span className="text-xs text-slate-500">Unrealized P&L</span>
                                            <p className={`text-lg font-bold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <span className="text-xs text-slate-500">ROE</span>
                                            <p className={`text-lg font-bold ${roe >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                {roe >= 0 ? '+' : ''}{roe.toFixed(2)}%
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
