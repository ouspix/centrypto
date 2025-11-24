"use client"

import { useState, useEffect } from "react"
import { useAccount } from "wagmi"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, TrendingUp, TrendingDown, X, RefreshCw, Clock, AlertCircle } from "lucide-react"
import { useTrading } from "@/context/TradingContext"
import { placeOrderAction, cancelOrderAction } from "@/app/actions/trade"

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

type OpenOrder = {
    oid: number
    coin: string
    limitPx: string
    sz: string
    side: "B" | "A" // Bid (Buy) or Ask (Sell)
    timestamp: number
}

export function OpenPositions() {
    const { address, isConnected } = useAccount()
    const { isTestnet, assetMetadata } = useTrading()
    const [positions, setPositions] = useState<Position[]>([])
    const [orders, setOrders] = useState<OpenOrder[]>([])
    const [loading, setLoading] = useState(false)
    const [actionLoading, setActionLoading] = useState<string | null>(null) // Track loading state for specific actions
    const [currentPrices, setCurrentPrices] = useState<Record<string, number>>({})
    const [mounted, setMounted] = useState(false)
    const [activeTab, setActiveTab] = useState("positions")

    useEffect(() => {
        setMounted(true)
    }, [])

    const fetchData = async () => {
        if (!address) return
        setLoading(true)
        try {
            const apiUrl = isTestnet
                ? 'https://api.hyperliquid-testnet.xyz/info'
                : 'https://api.hyperliquid.xyz/info'

            // Parallel fetch for positions and orders
            const [positionsRes, ordersRes] = await Promise.all([
                fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: "clearinghouseState", user: address })
                }),
                fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: "openOrders", user: address })
                })
            ])

            if (positionsRes.ok) {
                const data = await positionsRes.json()
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

                // Fetch prices for positions
                if (openPositions.length > 0) {
                    const priceRes = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: "allMids" })
                    })
                    const priceData = await priceRes.json()
                    const priceMap: Record<string, number> = {}
                    openPositions.forEach((p: Position) => {
                        priceMap[p.coin] = parseFloat(priceData[p.coin] || "0")
                    })
                    setCurrentPrices(priceMap)
                }
            }

            if (ordersRes.ok) {
                const data = await ordersRes.json()
                setOrders(data)
            }

        } catch (error) {
            console.error("Failed to fetch data", error)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        if (isConnected && address) {
            fetchData()
            const interval = setInterval(fetchData, 5000)
            return () => clearInterval(interval)
        } else {
            setPositions([])
            setOrders([])
        }
    }, [address, isConnected, isTestnet])

    const handleClosePosition = async (coin: string, size: string) => {
        if (!assetMetadata[coin]) {
            console.error("Metadata missing for", coin)
            return
        }

        const assetIndex = assetMetadata[coin].index
        const sizeNum = parseFloat(size)
        const isLong = sizeNum > 0

        // Market Close: Place a reduce-only order in the opposite direction
        // For Buy (Long), we Sell. For Sell (Short), we Buy.
        // We use a very aggressive price to ensure market execution.
        // Long -> Sell at 0. Short -> Buy at 1,000,000 (or very high).

        const aggressivePrice = isLong ? 0 : 1000000 // Simple market close logic

        setActionLoading(`close-${coin}`)
        try {
            const order = {
                asset: assetIndex,
                isBuy: !isLong, // Opposite side
                limitPx: aggressivePrice,
                sz: Math.abs(sizeNum),
                reduceOnly: true
            }

            const res = await placeOrderAction(order, isTestnet)
            console.log("Close Position Response:", res)

            if (res.success) {
                // Refresh immediately
                setTimeout(fetchData, 1000)
            } else {
                console.error("Close Position Failed:", res.error)
            }
        } catch (error) {
            console.error("Failed to close position:", error)
        } finally {
            setActionLoading(null)
        }
    }

    const handleCancelOrder = async (oid: number, coin: string) => {
        if (!assetMetadata[coin]) return

        setActionLoading(`cancel-${oid}`)
        try {
            const assetIndex = assetMetadata[coin].index

            const res = await cancelOrderAction({ asset: assetIndex, oid }, isTestnet)
            console.log("Cancel Order Response:", res)

            if (res.success) {
                setTimeout(fetchData, 1000)
            } else {
                console.error("Cancel Order Failed:", res.error)
            }
        } catch (error) {
            console.error("Failed to cancel order:", error)
        } finally {
            setActionLoading(null)
        }
    }

    if (!mounted) return null

    if (!isConnected) {
        return (
            <Card className="bg-slate-900 border-slate-800">
                <CardHeader>
                    <CardTitle className="text-lg font-bold text-emerald-400">Positions & Orders</CardTitle>
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
        <Card className="bg-slate-900 border-slate-800 hover-lift h-full">
            <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-lg font-bold text-emerald-400 flex items-center gap-2">
                        <TrendingUp className="h-5 w-5" />
                        Portfolio
                    </CardTitle>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={fetchData}
                        disabled={loading}
                        className="hover:bg-slate-800 h-8 w-8"
                    >
                        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    </Button>
                </div>
            </CardHeader>
            <CardContent>
                <Tabs defaultValue="positions" value={activeTab} onValueChange={setActiveTab} className="w-full">
                    <TabsList className="grid w-full grid-cols-2 bg-slate-950 mb-4">
                        <TabsTrigger value="positions" className="data-[state=active]:bg-slate-800 data-[state=active]:text-emerald-400">
                            Positions
                            {positions.length > 0 && (
                                <Badge variant="secondary" className="ml-2 bg-slate-800 text-xs h-5 px-1.5">
                                    {positions.length}
                                </Badge>
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="orders" className="data-[state=active]:bg-slate-800 data-[state=active]:text-blue-400">
                            Orders
                            {orders.length > 0 && (
                                <Badge variant="secondary" className="ml-2 bg-slate-800 text-xs h-5 px-1.5">
                                    {orders.length}
                                </Badge>
                            )}
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="positions" className="space-y-3 mt-0">
                        {positions.length === 0 ? (
                            <div className="text-center text-slate-500 py-8 text-sm">
                                No open positions
                            </div>
                        ) : (
                            positions.map((position, index) => {
                                const size = parseFloat(position.szi)
                                const isLong = size > 0
                                const entryPrice = parseFloat(position.entryPx)
                                const currentPrice = currentPrices[position.coin] || entryPrice
                                const pnl = parseFloat(position.unrealizedPnl)
                                const roe = parseFloat(position.returnOnEquity) * 100
                                const posValue = parseFloat(position.positionValue)
                                const isClosing = actionLoading === `close-${position.coin}`

                                return (
                                    <div key={index} className="p-4 rounded-lg border border-slate-800 bg-slate-950/50 hover:bg-slate-950 transition-all">
                                        <div className="flex items-start justify-between mb-3">
                                            <div className="flex items-center gap-2">
                                                <span className="text-lg font-bold text-slate-100">{position.coin}</span>
                                                <Badge variant="outline" className={`text-xs h-6 px-2 ${isLong ? 'border-green-500 text-green-400 bg-green-500/10' : 'border-red-500 text-red-400 bg-red-500/10'}`}>
                                                    {isLong ? 'LONG' : 'SHORT'}
                                                </Badge>
                                                <Badge variant="outline" className="text-xs h-6 px-2 border-slate-700 text-slate-400">
                                                    {position.leverage.value}x
                                                </Badge>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 px-3 text-xs hover:bg-red-500/20 hover:text-red-400 text-slate-500"
                                                onClick={() => handleClosePosition(position.coin, position.szi)}
                                                disabled={!!actionLoading}
                                            >
                                                {isClosing ? <Loader2 className="h-3 w-3 animate-spin" /> : "Close"}
                                            </Button>
                                        </div>

                                        <div className="grid grid-cols-2 gap-3 text-sm mb-3">
                                            <div>
                                                <span className="text-slate-500 block text-xs uppercase tracking-wider">Size</span>
                                                <span className="text-slate-200 font-mono text-base">{Math.abs(size).toFixed(4)}</span>
                                            </div>
                                            <div className="text-right">
                                                <span className="text-slate-500 block text-xs uppercase tracking-wider">Entry</span>
                                                <span className="text-slate-200 font-mono text-base">${entryPrice.toFixed(2)}</span>
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-between pt-3 border-t border-slate-800/50">
                                            <div>
                                                <span className="text-xs text-slate-500 block uppercase tracking-wider">Unrealized P&L</span>
                                                <span className={`text-base font-bold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                    {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                                                </span>
                                            </div>
                                            <div className="text-right">
                                                <span className="text-xs text-slate-500 block uppercase tracking-wider">ROE</span>
                                                <span className={`text-base font-bold ${roe >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                    {roe >= 0 ? '+' : ''}{roe.toFixed(2)}%
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                )
                            })
                        )}
                    </TabsContent>

                    <TabsContent value="orders" className="space-y-3 mt-0">
                        {orders.length === 0 ? (
                            <div className="text-center text-slate-500 py-8 text-sm">
                                No open orders
                            </div>
                        ) : (
                            orders.map((order) => {
                                const isCancelling = actionLoading === `cancel-${order.oid}`
                                return (
                                    <div key={order.oid} className="p-4 rounded-lg border border-slate-800 bg-slate-950/50 hover:bg-slate-950 transition-all">
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="flex items-center gap-2">
                                                <span className="text-lg font-bold text-slate-100">{order.coin}</span>
                                                <Badge variant="outline" className={`text-xs h-6 px-2 ${order.side === 'B' ? 'border-green-500 text-green-400' : 'border-red-500 text-red-400'}`}>
                                                    {order.side === 'B' ? 'BUY' : 'SELL'}
                                                </Badge>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 px-3 text-xs hover:bg-red-500/20 hover:text-red-400 text-slate-500"
                                                onClick={() => handleCancelOrder(order.oid, order.coin)}
                                                disabled={!!actionLoading}
                                            >
                                                {isCancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : "Cancel"}
                                            </Button>
                                        </div>
                                        <div className="grid grid-cols-2 gap-3 text-sm">
                                            <div>
                                                <span className="text-slate-500 block text-xs uppercase tracking-wider">Size</span>
                                                <span className="text-slate-200 font-mono text-base">{order.sz}</span>
                                            </div>
                                            <div className="text-right">
                                                <span className="text-slate-500 block text-xs uppercase tracking-wider">Limit Price</span>
                                                <span className="text-slate-200 font-mono text-base">${order.limitPx}</span>
                                            </div>
                                        </div>
                                        <div className="mt-3 pt-3 border-t border-slate-800/50 flex items-center gap-1 text-xs text-slate-600">
                                            <Clock className="h-3 w-3" />
                                            <span>{new Date(order.timestamp).toLocaleTimeString()}</span>
                                        </div>
                                    </div>
                                )
                            })
                        )}
                    </TabsContent>
                </Tabs>
            </CardContent>
        </Card>
    )
}
