"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Filter, RefreshCw } from "lucide-react"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from "@/components/ui/sheet"
import { ScreeningParameters } from "@/components/ScreeningParameters"
import { useTrading } from "@/context/TradingContext"

type TokenData = {
    symbol: string
    price: number
    change24h: number
    volume24h: number
}

export function LeftNavigation() {
    const { selectedPair, setSelectedPair, isTestnet } = useTrading()
    const [tokens, setTokens] = useState<TokenData[]>([])
    const [filterOpen, setFilterOpen] = useState(false)
    const [screeningConfig, setScreeningConfig] = useState<any>(null)
    const [isLoading, setIsLoading] = useState(false)
    const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const lastFetchRef = useRef<number>(0)

    // Load screening config
    useEffect(() => {
        const loadConfig = () => {
            try {
                const saved = localStorage.getItem('screeningConfig')
                if (saved) {
                    setScreeningConfig(JSON.parse(saved))
                }
            } catch (e) {
                console.error('Failed to load screening config', e)
            }
        }

        loadConfig()

        const handleConfigChange = (e: any) => {
            setScreeningConfig(e.detail)
        }

        window.addEventListener('screeningConfigChanged', handleConfigChange)
        return () => window.removeEventListener('screeningConfigChanged', handleConfigChange)
    }, [])

    // Debounced fetch function
    const fetchTokens = useCallback(async (force = false) => {
        if (!screeningConfig) return

        // Prevent too frequent fetches (minimum 2 seconds between fetches)
        const now = Date.now()
        if (!force && now - lastFetchRef.current < 2000) {
            return
        }

        setIsLoading(true)
        lastFetchRef.current = now

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
                setIsLoading(false)
                return
            }

            const data = await response.json()

            // Fetch current prices for these symbols
            const apiUrl = isTestnet
                ? 'https://api.hyperliquid-testnet.xyz/info'
                : 'https://api.hyperliquid.xyz/info'

            const priceResponse = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: "allMids" })
            })

            if (!priceResponse.ok) {
                console.warn('[LeftNav] Price API failed:', priceResponse.status)
                setIsLoading(false)
                return
            }

            const priceData = await priceResponse.json()

            // Get enriched data
            const enrichedResponse = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: "metaAndAssetCtxs" })
            })

            if (!enrichedResponse.ok) {
                console.warn('[LeftNav] Enriched data API failed:', enrichedResponse.status)
                setIsLoading(false)
                return
            }

            const enrichedData = await enrichedResponse.json()

            // Validate data structure
            if (!priceData || !enrichedData || !Array.isArray(enrichedData) || enrichedData.length < 2) {
                console.warn('[LeftNav] Invalid API response structure')
                setIsLoading(false)
                return
            }

            const tokenList: TokenData[] = data.symbols.map((s: any) => {
                const price = parseFloat(priceData[s.symbol] || "0")
                const assetIndex = enrichedData[0].universe.findIndex((u: any) => u.name === s.symbol)
                const ctx = assetIndex >= 0 ? enrichedData[1][assetIndex] : null
                const prevPrice = ctx ? parseFloat(ctx.prevDayPx) : price
                const change24h = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0
                const volume24h = ctx ? parseFloat(ctx.dayNtlVlm) : 0

                return {
                    symbol: s.symbol,
                    price,
                    change24h,
                    volume24h
                }
            })

            setTokens(tokenList)
        } catch (error) {
            console.error('Failed to fetch tokens', error)
        } finally {
            setIsLoading(false)
        }
    }, [screeningConfig, isTestnet])

    // Separate effect for network changes - immediate fetch, no debounce
    useEffect(() => {
        if (!screeningConfig) return

        // Clear tokens immediately when network changes to prevent showing wrong data
        setTokens([])
        setIsLoading(true)

        // Fetch immediately on network change (bypass rate limiting)
        lastFetchRef.current = 0 // Reset rate limit
        fetchTokens(true)
    }, [isTestnet]) // ONLY isTestnet - no other dependencies

    // Debounced effect for config changes only
    useEffect(() => {
        if (!screeningConfig) return

        // Clear any pending fetch
        if (fetchTimeoutRef.current) {
            clearTimeout(fetchTimeoutRef.current)
        }

        // Debounce: wait 1 second after config change before fetching
        fetchTimeoutRef.current = setTimeout(() => {
            fetchTokens(true)
        }, 1000)

        return () => {
            if (fetchTimeoutRef.current) {
                clearTimeout(fetchTimeoutRef.current)
            }
        }
    }, [screeningConfig]) // ONLY screeningConfig - no network dependency



    return (
        <nav className="fixed left-0 top-0 z-40 flex h-screen w-20 flex-col items-center border-r border-slate-800 bg-slate-950/95 backdrop-blur-sm py-4 gap-2 overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-slate-800 [&::-webkit-scrollbar-thumb]:rounded-full">
            {/* Logo/Brand */}
            {/* Logo/Brand */}
            <div className="mb-4 flex h-10 w-10 items-center justify-center shrink-0">
                <img src="/icon.png" alt="Centrypto" className="h-10 w-10 rounded-lg object-cover" />
            </div>

            {/* Filter Button */}
            <div className="flex flex-col gap-2">
                <Button
                    variant="ghost"
                    size="sm"
                    className="w-14 h-10 hover:bg-slate-800 text-slate-400 hover:text-slate-100 shrink-0 transition-colors"
                    onClick={() => fetchTokens(true)}
                    title="Refresh Feed"
                >
                    <RefreshCw className={`h-5 w-5 ${isLoading ? 'animate-spin' : ''}`} />
                </Button>

                <Sheet open={filterOpen} onOpenChange={setFilterOpen}>
                    <SheetTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="w-14 h-10 hover:bg-slate-800 text-slate-400 hover:text-slate-100 shrink-0 transition-colors"
                        >
                            <Filter className="h-5 w-5" />
                        </Button>
                    </SheetTrigger>
                    <SheetContent side="left" className="w-[400px] sm:w-[540px] bg-slate-950 border-slate-800 overflow-y-auto" hideClose={true}>
                        <SheetHeader>
                            <SheetTitle className="text-slate-100">Screening Parameters</SheetTitle>
                            <SheetDescription className="text-slate-400">
                                Configure filters to narrow down the market feed
                            </SheetDescription>
                        </SheetHeader>
                        <div className="mt-6">
                            <ScreeningParameters />
                        </div>
                    </SheetContent>
                </Sheet>
            </div>

            <div className="h-px w-12 bg-slate-800 my-2 shrink-0" />

            {/* Loading indicator */}
            {isLoading && tokens.length === 0 && (
                <div className="text-xs text-slate-500 px-2 text-center">
                    Loading...
                </div>
            )}

            {/* Token List */}
            <div className="flex flex-col gap-1 w-full px-2">
                {tokens.map((token) => (
                    <Popover key={token.symbol}>
                        <PopoverTrigger asChild>
                            <button
                                onClick={() => setSelectedPair(token.symbol)}
                                className={`
                                    w-full px-2 py-2 rounded-lg text-xs font-mono font-semibold
                                    transition-all duration-200
                                    ${selectedPair === token.symbol
                                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/50'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                                    }
                                `}
                            >
                                {token.symbol}
                            </button>
                        </PopoverTrigger>
                        <PopoverContent side="right" className="w-64 bg-slate-900 border-slate-800 p-3">
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-bold text-slate-100">{token.symbol}</span>
                                    <span
                                        className={`text-xs font-mono ${token.change24h >= 0 ? 'text-green-400' : 'text-red-400'}`}
                                    >
                                        {token.change24h >= 0 ? '+' : ''}{token.change24h.toFixed(2)}%
                                    </span>
                                </div>
                                <div className="space-y-1">
                                    <div className="flex justify-between text-xs">
                                        <span className="text-slate-500">Price</span>
                                        <span className="text-slate-200 font-mono">${token.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                    </div>
                                    <div className="flex justify-between text-xs">
                                        <span className="text-slate-500">24h Volume</span>
                                        <span className="text-slate-200 font-mono">${(token.volume24h / 1_000_000).toFixed(1)}M</span>
                                    </div>
                                </div>
                            </div>
                        </PopoverContent>
                    </Popover>
                ))}
            </div>

            {tokens.length === 0 && !isLoading && (
                <div className="text-center text-xs text-slate-500 px-2 mt-4">
                    No tokens screened
                </div>
            )}
        </nav>
    )
}
