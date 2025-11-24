"use client"

import { useState, useEffect } from "react"
import { useAccount } from "wagmi"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { Loader2, RefreshCw, X, TrendingUp } from "lucide-react"
import { useTrading } from "@/context/TradingContext"
import { placeOrderAction } from "@/app/actions/trade"

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

export function PositionsTable() {
    const { address, isConnected } = useAccount()
    const { isTestnet, assetMetadata } = useTrading()
    const [positions, setPositions] = useState<Position[]>([])
    const [loading, setLoading] = useState(false)
    const [actionLoading, setActionLoading] = useState<string | null>(null)
    const [currentPrices, setCurrentPrices] = useState<Record<string, number>>({})
    const [mounted, setMounted] = useState(false)

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

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: "clearinghouseState", user: address })
            })

            if (response.ok) {
                const data = await response.json()
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
        } catch (error) {
            console.error("Failed to fetch positions", error)
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
        }
    }, [address, isConnected, isTestnet])

    const handleClosePosition = async (coin: string, size: string, entryPrice: number) => {
        if (!assetMetadata[coin]) {
            console.error("Metadata missing for", coin)
            return
        }

        const assetIndex = assetMetadata[coin].index
        const sizeNum = parseFloat(size)
        const isLong = sizeNum > 0

        const currentPrice = currentPrices[coin] || entryPrice
        const aggressivePrice = isLong
            ? currentPrice * 0.9
            : currentPrice * 1.1

        setActionLoading(`close-${coin}`)
        try {
            const order = {
                asset: assetIndex,
                isBuy: !isLong,
                limitPx: aggressivePrice,
                sz: Math.abs(sizeNum),
                reduceOnly: true
            }

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

    if (!mounted) return null

    if (!isConnected) {
        return (
            <Card className="bg-slate-900 border-slate-800">
                <CardHeader>
                    <CardTitle className="text-lg font-semibold text-slate-100 flex items-center gap-2">
                        <TrendingUp className="h-5 w-5" />
                        Open Positions
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
                        Open Positions
                        {positions.length > 0 && (
                            <Badge variant="secondary" className="ml-2 bg-slate-800 text-xs">
                                {positions.length}
                            </Badge>
                        )}
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
                {positions.length === 0 ? (
                    <div className="text-center text-slate-500 py-8 text-sm">
                        No open positions
                    </div>
                ) : (
                    <div className="rounded-lg border border-slate-800 overflow-hidden">
                        <Table>
                            <TableHeader>
                                <TableRow className="border-slate-800 hover:bg-slate-900/50">
                                    <TableHead className="text-slate-400/60 font-medium">Asset</TableHead>
                                    <TableHead className="text-slate-400/60 font-medium">Side</TableHead>
                                    <TableHead className="text-slate-400/60 font-medium text-right">Size</TableHead>
                                    <TableHead className="text-slate-400/60 font-medium text-right">Entry</TableHead>
                                    <TableHead className="text-slate-400/60 font-medium text-right">Mark</TableHead>
                                    <TableHead className="text-slate-400/60 font-medium text-right">PnL</TableHead>
                                    <TableHead className="text-slate-400/60 font-medium text-right">ROE</TableHead>
                                    <TableHead className="text-slate-400/60 font-medium text-center">Action</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {positions.map((position, index) => {
                                    const size = parseFloat(position.szi)
                                    const isLong = size > 0
                                    const entryPrice = parseFloat(position.entryPx)
                                    const currentPrice = currentPrices[position.coin] || entryPrice
                                    const pnl = parseFloat(position.unrealizedPnl)
                                    const roe = parseFloat(position.returnOnEquity) * 100
                                    const isClosing = actionLoading === `close-${position.coin}`

                                    return (
                                        <TableRow key={index} className="border-slate-800 hover:bg-slate-950/50">
                                            <TableCell className="font-semibold text-slate-100">
                                                {position.coin}
                                            </TableCell>
                                            <TableCell>
                                                <Badge
                                                    variant="outline"
                                                    className={`text-xs ${isLong ? 'border-green-500 text-green-400 bg-green-500/10' : 'border-red-500 text-red-400 bg-red-500/10'}`}
                                                >
                                                    {isLong ? 'LONG' : 'SHORT'}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-slate-200">
                                                {Math.abs(size).toFixed(4)}
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-slate-200">
                                                ${entryPrice.toFixed(2)}
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-slate-200">
                                                ${currentPrice.toFixed(2)}
                                            </TableCell>
                                            <TableCell className={`text-right font-mono font-semibold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                                            </TableCell>
                                            <TableCell className={`text-right font-mono font-semibold ${roe >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                {roe >= 0 ? '+' : ''}{roe.toFixed(2)}%
                                            </TableCell>
                                            <TableCell className="text-center">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-7 px-3 text-xs hover:bg-red-500/20 hover:text-red-400 text-slate-500"
                                                    onClick={() => handleClosePosition(position.coin, position.szi, entryPrice)}
                                                    disabled={!!actionLoading}
                                                >
                                                    {isClosing ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
