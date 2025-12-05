"use client"

import { useState, useEffect } from "react"
import { useAccount } from "wagmi"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { Loader2, RefreshCw, X, TrendingUp, Clock, History, TrendingDown, DollarSign } from "lucide-react"
import { useTrading } from "@/context/TradingContext"
import { placeOrderAction, cancelOrderAction } from "@/app/actions/trade"
import { getCloseOrderParams } from "@/lib/trade-utils"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

type Position = {
    coin: string
    szi: string
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
    type?: string;
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

const TRADE_RANGES = ['24h', '3d', '7d', '1m', '1y'] as const;
type TradeRange = typeof TRADE_RANGES[number];

// PnL Chart Component
function PnlChart({ trades }: { trades: Trade[] }) {
    // Process trades to create cumulative PnL data
    const chartData = trades
        .filter(trade => trade.status === 'closed' && trade.realizedPnl !== undefined)
        .sort((a, b) => new Date(a.closedAt || a.openedAt).getTime() - new Date(b.closedAt || b.openedAt).getTime())
        .reduce((acc, trade, index) => {
            const prevPnl = index > 0 ? acc[index - 1].cumulativePnl : 0;
            const currentPnl = trade.realizedPnl || 0;
            const cumulativePnl = prevPnl + currentPnl;

            acc.push({
                date: new Date(trade.closedAt || trade.openedAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric'
                }),
                cumulativePnl: parseFloat(cumulativePnl.toFixed(2)),
                tradePnl: parseFloat(currentPnl.toFixed(2))
            });
            return acc;
        }, [] as { date: string; cumulativePnl: number; tradePnl: number }[]);

    if (chartData.length === 0) {
        return (
            <div className="flex items-center justify-center h-full bg-slate-950/50 rounded-lg border border-slate-800">
                <div className="text-center text-slate-500 text-sm">
                    No closed trades to display
                </div>
            </div>
        );
    }

    const CustomTooltip = ({ active, payload }: any) => {
        if (active && payload && payload.length) {
            const data = payload[0].payload;
            return (
                <div className="bg-slate-900 border border-slate-700 rounded-lg p-2 shadow-lg">
                    <p className="text-xs text-slate-400 mb-1">{data.date}</p>
                    <p className={`text-sm font-mono font-bold ${data.cumulativePnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {data.cumulativePnl >= 0 ? '+' : ''}${data.cumulativePnl}
                    </p>
                    <p className={`text-xs font-mono ${data.tradePnl >= 0 ? 'text-green-400/70' : 'text-red-400/70'}`}>
                        Trade: {data.tradePnl >= 0 ? '+' : ''}${data.tradePnl}
                    </p>
                </div>
            );
        }
        return null;
    };

    const finalPnl = chartData[chartData.length - 1]?.cumulativePnl || 0;

    return (
        <div className="bg-slate-950/50 rounded-lg border border-slate-800 p-3">
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-medium text-slate-400">PnL Over Time</h3>
                <div className={`text-sm font-mono font-bold ${finalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {finalPnl >= 0 ? '+' : ''}${finalPnl}
                </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
                <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis
                        dataKey="date"
                        stroke="#64748b"
                        style={{ fontSize: '10px' }}
                        tick={{ fill: '#64748b' }}
                    />
                    <YAxis
                        stroke="#64748b"
                        style={{ fontSize: '10px' }}
                        tick={{ fill: '#64748b' }}
                        tickFormatter={(value) => `$${value}`}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Line
                        type="monotone"
                        dataKey="cumulativePnl"
                        stroke={finalPnl >= 0 ? '#4ade80' : '#f87171'}
                        strokeWidth={2}
                        dot={{ fill: finalPnl >= 0 ? '#4ade80' : '#f87171', r: 3 }}
                        activeDot={{ r: 5 }}
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}

export function PositionsTable() {
    const { address, isConnected } = useAccount()
    const { isTestnet, assetMetadata } = useTrading()
    const [positions, setPositions] = useState<Position[]>([])
    const [orders, setOrders] = useState<OpenOrder[]>([])
    const [trades, setTrades] = useState<Trade[]>([])
    const [analytics, setAnalytics] = useState<TradeAnalytics | null>(null)
    const [loading, setLoading] = useState(false)
    const [historyLoading, setHistoryLoading] = useState(false)
    const [actionLoading, setActionLoading] = useState<string | null>(null)
    const [currentPrices, setCurrentPrices] = useState<Record<string, number>>({})
    const [leverageMap, setLeverageMap] = useState<Record<string, number>>({})
    const [mounted, setMounted] = useState(false)
    const [activeTab, setActiveTab] = useState("positions")
    const [selectedRange, setSelectedRange] = useState<TradeRange>('7d')

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
                // Extract leverage for all assets
                const levMap: Record<string, number> = {}
                data.assetPositions.forEach((ap: any) => {
                    levMap[ap.position.coin] = ap.position.leverage.value
                })
                setLeverageMap(levMap)

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

                // Fetch current prices
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

    const fetchTrades = async (range: TradeRange = selectedRange) => {
        if (!address) return

        setHistoryLoading(true)
        try {
            const network = isTestnet ? 'testnet' : 'mainnet'
            const response = await fetch(`/api/trades?userAddress=${address}&limit=1000&network=${network}&range=${range}`)
            const data = await response.json()
            if (data.trades) {
                setTrades(data.trades)
            }
        } catch (error) {
            console.error("Failed to fetch trades:", error)
        } finally {
            setHistoryLoading(false)
        }
    }

    const fetchAnalytics = async () => {
        if (!address) return

        try {
            const network = isTestnet ? 'testnet' : 'mainnet'
            const response = await fetch(`/api/trades?userAddress=${address}&analytics=true&network=${network}`)
            const data = await response.json()
            if (data.analytics) {
                setAnalytics(data.analytics)
            }
        } catch (error) {
            console.error("Failed to fetch analytics:", error)
        }
    }

    useEffect(() => {
        if (isConnected && address) {
            fetchData()
            fetchTrades(selectedRange)
            fetchAnalytics()
            const interval = setInterval(() => {
                fetchData()
                // Only refresh trades/analytics every 30s to save resources
                if (Date.now() % 30000 < 5000) {
                    fetchTrades(selectedRange)
                    fetchAnalytics()
                }
            }, 5000)
            return () => clearInterval(interval)
        } else {
            setPositions([])
            setOrders([])
            setTrades([])
            setAnalytics(null)
        }
    }, [address, isConnected, isTestnet, selectedRange])

    const handleClosePosition = async (coin: string, size: string, entryPrice: number) => {
        if (!assetMetadata[coin]) {
            console.error("Metadata missing for", coin)
            return
        }

        const assetIndex = assetMetadata[coin].index
        const sizeNum = parseFloat(size)
        const isLong = sizeNum > 0

        const currentPrice = currentPrices[coin] || entryPrice

        setActionLoading(`close-${coin}`)
        try {
            const order = getCloseOrderParams(assetIndex, sizeNum, currentPrice, isLong)

            const res = await placeOrderAction(order, isTestnet)
            if (res.success) {
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

    if (!mounted) return null

    if (!isConnected) {
        return (
            <Card className="bg-slate-900 border-slate-800">
                <CardHeader>
                    <CardTitle className="text-lg font-semibold text-slate-100 flex items-center gap-2">
                        <TrendingUp className="h-5 w-5" />
                        Portfolio
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="text-center text-slate-500 py-8 text-sm">
                        Connect wallet to view positions
                    </div>
                </CardContent>
            </Card>
        )
    }

    return (
        <Card className="bg-slate-900 border-slate-800">
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-lg font-semibold text-slate-100 flex items-center gap-2">
                        <TrendingUp className="h-5 w-5" />
                        Portfolio
                    </CardTitle>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                            fetchData()
                            fetchTrades()
                            fetchAnalytics()
                        }}
                        disabled={loading || historyLoading}
                        className="hover:bg-slate-800 h-8 w-8"
                    >
                        {loading || historyLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    </Button>
                </div>
            </CardHeader>
            <CardContent>
                <Tabs defaultValue="positions" value={activeTab} onValueChange={setActiveTab} className="w-full">
                    <TabsList className="grid w-full grid-cols-4 bg-slate-950 mb-4">
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
                        <TabsTrigger value="history" className="data-[state=active]:bg-slate-800 data-[state=active]:text-purple-400">
                            History
                        </TabsTrigger>
                        <TabsTrigger value="analytics" className="data-[state=active]:bg-slate-800 data-[state=active]:text-amber-400">
                            Analytics
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="positions" className="mt-0">
                        {positions.length === 0 ? (
                            <div className="text-center text-slate-500 py-8 text-sm">
                                No open positions
                            </div>
                        ) : (
                            <div className="rounded-lg border border-slate-800 overflow-hidden">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="border-slate-800 hover:bg-slate-900/50">
                                            <TableHead className="text-slate-400 font-medium text-base py-4">Asset</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base py-4">Side</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-center py-4">Lev</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-right py-4">Size</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-right py-4">Entry</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-right py-4">Exposure</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-right py-4">PnL</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-right py-4">ROE</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-center py-4">Action</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {positions.map((position, index) => {
                                            const size = parseFloat(position.szi)
                                            const isLong = size > 0
                                            const entryPrice = parseFloat(position.entryPx)
                                            const currentPrice = currentPrices[position.coin] || entryPrice
                                            const pnl = parseFloat(position.unrealizedPnl)
                                            const isClosing = actionLoading === `close-${position.coin}`
                                            const exposure = Math.abs(size) * currentPrice
                                            const margin = position.leverage.value ? exposure / position.leverage.value : 0
                                            const roeFromApi = parseFloat(position.returnOnEquity)
                                            const roePct = Number.isFinite(roeFromApi)
                                                ? roeFromApi * 100
                                                : (margin === 0 ? 0 : (pnl / margin) * 100)

                                            return (
                                                <TableRow key={index} className="border-slate-800 hover:bg-slate-950/50">
                                                    <TableCell className="font-semibold text-slate-100 text-lg py-4">
                                                        {position.coin}
                                                    </TableCell>
                                                    <TableCell className="py-4">
                                                        <Badge
                                                            variant="outline"
                                                            className={`text-sm ${isLong ? 'border-green-500 text-green-400 bg-green-500/10' : 'border-red-500 text-red-400 bg-red-500/10'}`}
                                                        >
                                                            {isLong ? 'LONG' : 'SHORT'}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="text-center font-mono text-slate-300 text-base py-4">
                                                        {position.leverage.value}x
                                                    </TableCell>
                                                    <TableCell className="text-right font-mono text-slate-200 text-base py-4">
                                                        {Math.abs(size).toFixed(4)}
                                                    </TableCell>
                                                    <TableCell className="text-right font-mono text-slate-200 text-base py-4">
                                                        ${entryPrice.toFixed(2)}
                                                    </TableCell>
                                                    <TableCell className="text-right font-mono text-slate-200 text-base py-4">
                                                        ${exposure.toFixed(2)}
                                                    </TableCell>
                                                    <TableCell className={`text-right font-mono font-semibold text-base py-4 ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                        {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                                                    </TableCell>
                                                    <TableCell className={`text-right font-mono font-semibold text-base py-4 ${roePct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                        {roePct >= 0 ? '+' : ''}{roePct.toFixed(2)}%
                                                    </TableCell>
                                                    <TableCell className="text-center py-4">
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-8 px-3 text-sm hover:bg-red-500/20 hover:text-red-400 text-slate-400"
                                                            onClick={() => handleClosePosition(position.coin, position.szi, entryPrice)}
                                                            disabled={!!actionLoading}
                                                        >
                                                            {isClosing ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            )
                                        })}
                                    </TableBody>
                                </Table>
                            </div>
                        )}
                    </TabsContent>

                    <TabsContent value="orders" className="mt-0">
                        {orders.length === 0 ? (
                            <div className="text-center text-slate-500 py-8 text-sm">
                                No open orders
                            </div>
                        ) : (
                            <div className="rounded-lg border border-slate-800 overflow-hidden">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="border-slate-800 hover:bg-slate-900/50">
                                            <TableHead className="text-slate-400 font-medium text-base py-4">Asset</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base py-4">Side</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-center py-4">Lev</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-right py-4">Size</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-right py-4">Limit Price</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-right py-4">Time</TableHead>
                                            <TableHead className="text-slate-400 font-medium text-base text-center py-4">Action</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {orders.map((order) => {
                                            const isCancelling = actionLoading === `cancel-${order.oid}`
                                            return (
                                                <TableRow key={order.oid} className="border-slate-800 hover:bg-slate-950/50">
                                                    <TableCell className="font-semibold text-slate-100 text-lg py-4">
                                                        {order.coin}
                                                    </TableCell>
                                                    <TableCell className="py-4">
                                                        <Badge
                                                            variant="outline"
                                                            className={`text-sm ${order.side === 'B' ? 'border-green-500 text-green-400 bg-green-500/10' : 'border-red-500 text-red-400 bg-red-500/10'}`}
                                                        >
                                                            {order.side === 'B' ? 'BUY' : 'SELL'}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="text-center font-mono text-slate-300 text-base py-4">
                                                        {leverageMap[order.coin] || '-'}x
                                                    </TableCell>
                                                    <TableCell className="text-right font-mono text-slate-200 text-base py-4">
                                                        {order.sz}
                                                    </TableCell>
                                                    <TableCell className="text-right font-mono text-slate-200 text-base py-4">
                                                        ${order.limitPx}
                                                    </TableCell>
                                                    <TableCell className="text-right font-mono text-slate-300 text-base py-4">
                                                        <div className="flex items-center justify-end gap-1">
                                                            <Clock className="h-4 w-4" />
                                                            {new Date(order.timestamp).toLocaleTimeString()}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-center py-4">
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-8 px-3 text-sm hover:bg-red-500/20 hover:text-red-400 text-slate-400"
                                                            onClick={() => handleCancelOrder(order.oid, order.coin)}
                                                            disabled={!!actionLoading}
                                                        >
                                                            {isCancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            )
                                        })}
                                    </TableBody>
                                </Table>
                            </div>
                        )}
                    </TabsContent>

                    <TabsContent value="history" className="mt-0">
                        {historyLoading && trades.length === 0 && (
                            <div className="flex items-center justify-center h-32 text-slate-500">
                                <Loader2 className="h-5 w-5 animate-spin" />
                            </div>
                        )}

                        {trades.length === 0 && !historyLoading && (
                            <div className="text-center text-slate-500 py-8 text-sm">
                                No trades recorded yet
                            </div>
                        )}

                        {trades.length > 0 && (
                            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                                {trades.map((trade) => (
                                    <div
                                        key={trade.id}
                                        className={`group relative overflow-hidden rounded-xl border border-slate-800 bg-gradient-to-br from-slate-950/80 to-slate-900/80 p-4 transition-all hover:border-slate-700 hover:from-slate-900 hover:to-slate-900 ${trade.realizedPnl && trade.realizedPnl >= 0
                                            ? 'border-l-4 border-l-emerald-500'
                                            : 'border-l-4 border-l-red-500'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between">
                                            {/* Left: Symbol & Side */}
                                            <div className="flex flex-col gap-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xl font-bold text-slate-100 tracking-tight">
                                                        {trade.symbol}
                                                    </span>
                                                    <Badge
                                                        variant="outline"
                                                        className={`text-xs font-bold px-2 py-0.5 ${trade.side === 'long'
                                                            ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/5'
                                                            : 'border-red-500/30 text-red-400 bg-red-500/5'
                                                            }`}
                                                    >
                                                        {trade.side === 'long' ? 'LONG' : 'SHORT'}
                                                    </Badge>
                                                </div>
                                                <div className="flex items-center gap-2 text-xs text-slate-500">
                                                    <span>{formatDate(trade.openedAt)}</span>
                                                    {trade.strategyName && (
                                                        <>
                                                            <span>•</span>
                                                            <span className="text-slate-400">{trade.strategyName}</span>
                                                        </>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Middle: Stats Grid */}
                                            <div className="hidden sm:grid grid-cols-3 gap-x-8 gap-y-1 text-right">
                                                <div>
                                                    <span className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">Entry</span>
                                                    <div className="font-mono text-slate-300 text-sm">${trade.entryPrice.toFixed(2)}</div>
                                                </div>
                                                <div>
                                                    <span className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">Size</span>
                                                    <div className="font-mono text-slate-300 text-sm">{trade.size.toFixed(4)}</div>
                                                </div>
                                                <div>
                                                    <span className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">Exit</span>
                                                    <div className="font-mono text-slate-300 text-sm">
                                                        {trade.exitPrice ? `$${trade.exitPrice.toFixed(2)}` : '-'}
                                                    </div>
                                                </div>
                                                <div>
                                                    <span className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">Lev</span>
                                                    <div className="font-mono text-purple-400 text-sm">{trade.leverage}x</div>
                                                </div>
                                            </div>

                                            {/* Right: PnL */}
                                            <div className="text-right min-w-[100px]">
                                                {trade.status === 'closed' && trade.realizedPnl !== undefined ? (
                                                    <>
                                                        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium mb-0.5">Realized P&L</div>
                                                        <div className={`text-2xl font-bold font-mono tracking-tight ${trade.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                                                            }`}>
                                                            {formatPnl(trade.realizedPnl)}
                                                        </div>
                                                    </>
                                                ) : (
                                                    <Badge variant="outline" className="border-cyan-500/50 text-cyan-400 px-3 py-1">
                                                        OPEN
                                                    </Badge>
                                                )}
                                            </div>
                                        </div>

                                        {/* Mobile Stats (visible only on small screens) */}
                                        <div className="mt-4 grid grid-cols-2 gap-4 border-t border-slate-800/50 pt-3 sm:hidden">
                                            <div className="flex justify-between">
                                                <span className="text-xs text-slate-500">Entry</span>
                                                <span className="font-mono text-slate-300">${trade.entryPrice.toFixed(2)}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-xs text-slate-500">Exit</span>
                                                <span className="font-mono text-slate-300">{trade.exitPrice ? `$${trade.exitPrice.toFixed(2)}` : '-'}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-xs text-slate-500">Size</span>
                                                <span className="font-mono text-slate-300">{trade.size.toFixed(4)}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-xs text-slate-500">Lev</span>
                                                <span className="font-mono text-purple-400">{trade.leverage}x</span>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </TabsContent>

                    <TabsContent value="analytics" className="mt-0">
                        {!analytics ? (
                            <div className="text-center text-slate-500 py-8 text-sm">
                                {historyLoading ? <Loader2 className="h-5 w-5 animate-spin mx-auto" /> : "No analytics available"}
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-4">
                                {/* Left Half - Statistics */}
                                <div className="flex flex-col space-y-3">
                                    {/* Summary Cards */}
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="p-3 bg-slate-950/50 rounded-lg border border-slate-800">
                                            <div className="text-sm text-slate-500 mb-1">Total P&L</div>
                                            <div className={`text-xl font-bold font-mono ${analytics.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'
                                                }`}>
                                                {formatPnl(analytics.totalPnl)}
                                            </div>
                                        </div>
                                        <div className="p-3 bg-slate-950/50 rounded-lg border border-slate-800">
                                            <div className="text-sm text-slate-500 mb-1">Win Rate</div>
                                            <div className="text-xl font-bold font-mono text-cyan-400">
                                                {analytics.winRate.toFixed(1)}%
                                            </div>
                                        </div>
                                    </div>

                                    {/* Detailed Stats */}
                                    <div className="flex-1 p-3 bg-slate-950/50 rounded-lg border border-slate-800 flex flex-col justify-center space-y-3">
                                        <div className="flex justify-between items-center">
                                            <span className="text-slate-500 text-base">Total Trades</span>
                                            <span className="font-mono text-slate-300 text-lg font-semibold">{positions.length + analytics.closedTrades}</span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-slate-500 text-base">Open / Closed</span>
                                            <span className="font-mono text-slate-300 text-lg font-semibold">
                                                {positions.length} / {analytics.closedTrades}
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-slate-500 text-base">Wins / Losses</span>
                                            <span className="font-mono text-slate-300 text-lg font-semibold">
                                                <span className="text-green-400">{analytics.winningTrades}</span>
                                                {' / '}
                                                <span className="text-red-400">{analytics.losingTrades}</span>
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-slate-500 text-base">Avg Win</span>
                                            <span className="font-mono text-green-400 text-lg font-semibold">+${analytics.avgWin.toFixed(2)}</span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-slate-500 text-base">Avg Loss</span>
                                            <span className="font-mono text-red-400 text-lg font-semibold">-${analytics.avgLoss.toFixed(2)}</span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-slate-500 text-base" title="Gross Profit / Gross Loss">Profit Factor</span>
                                            <span className="font-mono text-purple-400 text-lg font-semibold">
                                                {analytics.profitFactor === Infinity ? '∞' : analytics.profitFactor.toFixed(2)}
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-slate-500 text-base">Avg Hold Time</span>
                                            <span className="font-mono text-slate-300 text-lg font-semibold">
                                                {analytics.avgHoldTime < 1
                                                    ? `${(analytics.avgHoldTime * 60).toFixed(1)}m`
                                                    : `${analytics.avgHoldTime.toFixed(1)}h`
                                                }
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                {/* Right Half - PnL Over Time Chart */}
                                <div className="flex flex-col space-y-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide">Range</h3>
                                        <div className="flex flex-wrap gap-2">
                                            {TRADE_RANGES.map((range) => {
                                                const isActive = selectedRange === range
                                                return (
                                                    <Button
                                                        key={range}
                                                        variant="ghost"
                                                        size="sm"
                                                        className={`h-7 px-2 text-[11px] rounded-md border transition-colors ${
                                                            isActive
                                                                ? 'border-amber-400/80 text-amber-200 bg-amber-500/10 hover:bg-amber-500/15'
                                                                : 'border-slate-800 text-slate-300 bg-slate-900/40 hover:bg-slate-800/60'
                                                        }`}
                                                        onClick={() => setSelectedRange(range)}
                                                    >
                                                        {range.toUpperCase()}
                                                    </Button>
                                                )
                                            })}
                                        </div>
                                    </div>
                                    <PnlChart trades={trades} />
                                </div>
                            </div>
                        )}
                    </TabsContent>
                </Tabs>
            </CardContent>
        </Card>
    )
}
