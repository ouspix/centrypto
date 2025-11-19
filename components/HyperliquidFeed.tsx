"use client"

import { useEffect, useState, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useTrading } from "@/context/TradingContext"
import { cn } from "@/lib/utils"

type Ticker = {
    coin: string
    mid: number
}

type L2Book = {
    coin: string
    levels: [number, number][] // [price, size]
    time: number
}

export function HyperliquidFeed() {
    const [tickers, setTickers] = useState<Ticker[]>([])
    const [status, setStatus] = useState<"connected" | "disconnected" | "connecting">("disconnected")
    const wsRef = useRef<WebSocket | null>(null)
    const pingIntervalRef = useRef<NodeJS.Timeout | null>(null)
    const { selectedPair, setSelectedPair, setMarketState, isTestnet } = useTrading()

    useEffect(() => {
        const connect = () => {
            setStatus("connecting")
            const wsUrl = isTestnet
                ? "wss://api.hyperliquid-testnet.xyz/ws"
                : "wss://api.hyperliquid.xyz/ws"
            const ws = new WebSocket(wsUrl)
            wsRef.current = ws

            ws.onopen = () => {
                setStatus("connected")
                console.log(`Connected to Hyperliquid WS (${isTestnet ? 'TESTNET' : 'MAINNET'}): ${wsUrl}`)

                // Subscribe to allMids
                ws.send(JSON.stringify({
                    method: "subscribe",
                    subscription: { type: "allMids" }
                }))

                // Setup heartbeat
                pingIntervalRef.current = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ method: "ping" }))
                    }
                }, 30000)
            }

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data)

                if (data.channel === "allMids") {
                    // data.data.mids is an object { "BTC": "65000.5", ... }
                    const mids = data.data.mids
                    const tickerList = Object.entries(mids).map(([coin, mid]) => ({
                        coin,
                        mid: parseFloat(mid as string)
                    }))
                    // Sort by coin name or priority (e.g., BTC, ETH first)
                    tickerList.sort((a, b) => {
                        const priority = ["BTC", "ETH", "SOL", "ARB", "SUI"]
                        const idxA = priority.indexOf(a.coin)
                        const idxB = priority.indexOf(b.coin)
                        if (idxA !== -1 && idxB !== -1) return idxA - idxB
                        if (idxA !== -1) return -1
                        if (idxB !== -1) return 1
                        return a.coin.localeCompare(b.coin)
                    })
                    setTickers(tickerList.slice(0, 10)) // Show top 10 for now

                    // Update current price in context if selected pair is found
                    const currentTicker = tickerList.find(t => t.coin === selectedPair)
                    if (currentTicker) {
                        setMarketState({ pair: selectedPair, price: currentTicker.mid })
                    }
                } else if (data.channel === "pong") {
                    // Pong received
                }
            }

            ws.onclose = () => {
                setStatus("disconnected")
                console.log("Disconnected from Hyperliquid WS")
                if (pingIntervalRef.current) clearInterval(pingIntervalRef.current)
                // Only auto-reconnect if we didn't intentionally close (e.g., not during cleanup)
                if (wsRef.current === ws) {
                    console.log("Auto-reconnecting in 5s...")
                    setTimeout(connect, 5000)
                }
            }

            ws.onerror = (error) => {
                console.error("WS Error:", error)
                ws.close()
            }
        }

        console.log(`Initiating connection to ${isTestnet ? 'TESTNET' : 'MAINNET'}...`)
        connect()

        return () => {
            console.log("Cleaning up WebSocket connection for network switch...")
            // Clear the ref first to prevent auto-reconnect
            const currentWs = wsRef.current
            wsRef.current = null

            if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                currentWs.close()
            }
            if (pingIntervalRef.current) {
                clearInterval(pingIntervalRef.current)
                pingIntervalRef.current = null
            }
        }
    }, [selectedPair, setMarketState, isTestnet])

    return (
        <Card className="w-full max-w-md bg-slate-900 text-slate-100 border-slate-800">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-lg font-bold text-blue-400">Market Feed</CardTitle>
                <div className="flex gap-2">
                    <Badge variant={isTestnet ? "outline" : "default"} className={isTestnet ? "border-orange-500 text-orange-400" : "border-blue-500 text-blue-400"}>
                        {isTestnet ? "Testnet" : "Mainnet"}
                    </Badge>
                    <Badge variant={status === "connected" ? "default" : "destructive"} className={status === "connected" ? "bg-green-600" : "bg-red-600"}>
                        {status}
                    </Badge>
                </div>
            </CardHeader>
            <CardContent>
                <div className="space-y-2">
                    <div className="grid grid-cols-2 text-sm font-medium text-slate-400 mb-2">
                        <span>Asset</span>
                        <span className="text-right">Price (USDC)</span>
                    </div>
                    {tickers.map((ticker) => (
                        <div
                            key={ticker.coin}
                            className={cn(
                                "grid grid-cols-2 text-sm items-center border-b border-slate-800 py-2 px-2 last:border-0 cursor-pointer hover:bg-slate-800 rounded transition-colors",
                                selectedPair === ticker.coin && "bg-slate-800 border-l-4 border-l-blue-500"
                            )}
                            onClick={() => setSelectedPair(ticker.coin)}
                        >
                            <span className="font-bold text-slate-200">{ticker.coin}</span>
                            <span className="text-right font-mono text-blue-300">
                                {ticker.mid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                            </span>
                        </div>
                    ))}
                    {tickers.length === 0 && status === "connected" && (
                        <div className="text-center text-sm text-slate-500 py-4">Waiting for data...</div>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

