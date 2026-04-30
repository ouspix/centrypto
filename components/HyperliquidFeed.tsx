"use client"

import { useEffect, useState, useRef, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useTrading } from "@/context/TradingContext"
import { cn } from "@/lib/utils"
import { readActiveScreeningConfig, SCREENING_CONFIG_APPLIED_EVENT } from "@/lib/screening-storage"
import { TrendingUp, TrendingDown } from "lucide-react"

type Ticker = {
    coin: string
    mid: number
    volume24h?: number
    spreadBps?: number
    depthUsd?: number
    volZscore?: number
    retZscore?: number
    change24h?: number
    funding?: number
    openInterest?: number
}

export function HyperliquidFeed() {
    const [allTickers, setAllTickers] = useState<Ticker[]>([]) // Raw data from WS
    const [tickers, setTickers] = useState<Ticker[]>([]) // Filtered data
    const [status, setStatus] = useState<"connected" | "disconnected" | "connecting">("disconnected")
    const enrichedDataRef = useRef<Record<string, any>>({})
    const [screeningConfig, setScreeningConfig] = useState<any>(null)
    const wsRef = useRef<WebSocket | null>(null)
    const pingIntervalRef = useRef<NodeJS.Timeout | null>(null)
    const { selectedPair, setSelectedPair, setMarketState, isTestnet } = useTrading()

    // Load applied screening config. Draft edits do not trigger screening.
    useEffect(() => {
        setScreeningConfig(readActiveScreeningConfig())

        const handleConfigApplied = (e: any) => {
            console.log('[HyperliquidFeed] Config applied event received', e.detail)
            setScreeningConfig(e.detail)
        }

        window.addEventListener(SCREENING_CONFIG_APPLIED_EVENT, handleConfigApplied)
        return () => window.removeEventListener(SCREENING_CONFIG_APPLIED_EVENT, handleConfigApplied)
    }, [])

    // Fetch enriched market data (screening metrics)
    useEffect(() => {
        const fetchEnrichedData = async () => {
            try {
                const apiUrl = isTestnet
                    ? "https://api.hyperliquid-testnet.xyz/info"
                    : "https://api.hyperliquid.xyz/info"

                const response = await fetch(apiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ type: "metaAndAssetCtxs" })
                })

                if (!response.ok) return

                const data = await response.json()
                const enriched: Record<string, any> = {}

                data[0].universe.forEach((asset: any, idx: number) => {
                    const ctx = data[1][idx]
                    enriched[asset.name] = {
                        volume24h: parseFloat(ctx.dayNtlVlm),
                        funding: parseFloat(ctx.funding),
                        openInterest: parseFloat(ctx.openInterest),
                        prevDayPx: parseFloat(ctx.prevDayPx)
                    }
                })

                enrichedDataRef.current = enriched
            } catch (error) {
                console.error("Failed to fetch enriched data", error)
            }
        }

        fetchEnrichedData()
        const interval = setInterval(fetchEnrichedData, 30000) // Refresh every 30s
        return () => clearInterval(interval)
    }, [isTestnet])

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
                    const mids = data.data.mids
                    const tickerList = Object.entries(mids)
                        .filter(([coin]) => enrichedDataRef.current[coin]) // Only include known perps
                        .map(([coin, mid]) => {
                            const enrichment = enrichedDataRef.current[coin] || {}
                            const currentPrice = parseFloat(mid as string)
                            const prevPrice = enrichment.prevDayPx || currentPrice
                            const change24h = ((currentPrice - prevPrice) / prevPrice) * 100

                            return {
                                coin,
                                mid: currentPrice,
                                volume24h: enrichment.volume24h,
                                change24h,
                                funding: enrichment.funding,
                                openInterest: enrichment.openInterest
                            }
                        })

                    // Sort by volume (highest first)
                    tickerList.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
                    setAllTickers(tickerList) // Store raw WS data

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
    }, [selectedPair, setMarketState, isTestnet]) // WebSocket only needs to reconnect on network or pair change, NOT config

    // Fetch screened symbols from the screener API (applies all layers)
    const [allowedSymbols, setAllowedSymbols] = useState<Set<string> | null>(null)

    // Fetch screened symbols from the screener API
    useEffect(() => {
        console.log('[HyperliquidFeed] Screener effect triggered', {
            hasConfig: !!screeningConfig,
            isTestnet,
            configKeys: screeningConfig ? Object.keys(screeningConfig) : []
        })

        if (!screeningConfig) {
            setAllowedSymbols(null)
            return
        }

        const fetchScreenedSymbols = async () => {
            console.log('[HyperliquidFeed] Fetching screened symbols...', { isTestnet })
            try {
                const response = await fetch('/api/screener', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        isTestnet,
                        screeningConfig
                    })
                })

                if (!response.ok) {
                    console.error('Failed to fetch screened symbols:', response.statusText)
                    setAllowedSymbols(null)
                    return
                }

                const data = await response.json()
                console.log('[HyperliquidFeed] Screened symbols fetched:', data.symbols.length)
                setAllowedSymbols(new Set(data.symbols.map((s: any) => s.symbol)))
            } catch (error) {
                console.error('Failed to fetch screened symbols', error)
                setAllowedSymbols(null)
            }
        }

        // Debounce config changes only, fetch immediately on network change
        const timeout = setTimeout(fetchScreenedSymbols, 500)

        return () => {
            clearTimeout(timeout)
        }
    }, [screeningConfig, isTestnet])

    // Filter tickers whenever raw data or allowed symbols change
    useEffect(() => {
        if (!allowedSymbols) {
            setTickers(allTickers)
        } else {
            setTickers(allTickers.filter(t => allowedSymbols.has(t.coin)))
        }
    }, [allTickers, allowedSymbols])

    // No need for client-side filtering anymore - the screener API handles it
    const filteredTickers = tickers;

    return (
        <Card className="bg-slate-900 text-slate-100 border-slate-800 flex flex-col" style={{ maxHeight: '80vh' }}>
            <CardHeader className="flex flex-row items-center justify-between pb-3 border-b border-slate-800/50 shrink-0">
                <div className="flex items-center gap-2">
                    <CardTitle className="text-xl font-bold text-blue-400">Market Feed</CardTitle>
                    {screeningConfig && filteredTickers.length < allTickers.length && (
                        <Badge variant="outline" className="text-xs border-cyan-500/30 text-cyan-400 bg-cyan-500/5">
                            {filteredTickers.length} / {allTickers.length}
                        </Badge>
                    )}
                </div>
                <div className="flex gap-2">
                    <Badge variant={isTestnet ? "outline" : "default"} className={isTestnet ? "border-orange-500 text-orange-400 text-sm" : "border-blue-500 text-blue-400 text-sm"}>
                        {isTestnet ? "Testnet" : "Mainnet"}
                    </Badge>
                    <Badge variant={status === "connected" ? "default" : "destructive"} className={status === "connected" ? "bg-green-600 text-sm" : "bg-red-600 text-sm"}>
                        {status}
                    </Badge>
                </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto p-3 min-h-0">
                <div className="space-y-1">
                    {/* Header */}
                    <div className="grid grid-cols-12 gap-2 text-sm font-semibold text-slate-400 mb-2 px-2 sticky top-0 bg-slate-900 pb-2 z-10">
                        <span className="col-span-3">Asset</span>
                        <span className="col-span-3 text-right">Price</span>
                        <span className="col-span-3 text-right">24h %</span>
                        <span className="col-span-3 text-right">Volume 24h</span>
                    </div>

                    {/* Ticker Rows */}
                    {filteredTickers.map((ticker) => (
                        <div
                            key={ticker.coin}
                            className={cn(
                                "grid grid-cols-12 gap-2 text-sm items-center border-b border-slate-800/50 py-2.5 px-2 last:border-0 cursor-pointer hover:bg-slate-800/50 rounded transition-colors",
                                selectedPair === ticker.coin && "bg-slate-800 border-l-4 border-l-blue-500"
                            )}
                            onClick={() => setSelectedPair(ticker.coin)}
                        >
                            <span className="col-span-3 font-bold text-slate-200 text-base">{ticker.coin}</span>
                            <span className="col-span-3 text-right font-mono text-blue-300 text-base">
                                ${ticker.mid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                            <span className={cn(
                                "col-span-3 text-right font-semibold flex items-center justify-end gap-1 text-sm",
                                ticker.change24h && ticker.change24h > 0 ? "text-green-400" : "text-red-400"
                            )}>
                                {ticker.change24h && ticker.change24h > 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                                {ticker.change24h ? `${ticker.change24h > 0 ? '+' : ''}${ticker.change24h.toFixed(2)}%` : 'N/A'}
                            </span>
                            <span className="col-span-3 text-right font-mono text-slate-300 text-sm">
                                {ticker.volume24h ? `$${(ticker.volume24h / 1_000_000).toFixed(1)}M` : 'N/A'}
                            </span>
                        </div>
                    ))}
                    {filteredTickers.length === 0 && status === "connected" && (
                        <div className="text-center text-base text-slate-500 py-4">
                            {tickers.length > 0 ? 'No markets match screening criteria' : 'Waiting for data...'}
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}
