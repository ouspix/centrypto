
"use client"

import { useState, useEffect } from "react"
import { useAccount, useWalletClient, useSwitchChain } from "wagmi"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Loader2, ArrowUpRight, ArrowDownRight } from "lucide-react"

import { useTrading } from "@/context/TradingContext"
import { placeOrder } from "@/lib/hyperliquid"

export function TradeForm() {
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState<any>(null)
    const { selectedPair, marketState, isTestnet } = useTrading()
    const [formData, setFormData] = useState({
        asset: 0, // This should map from selectedPair
        isBuy: true,
        price: 0,
        size: 0.01,
        leverage: 5
    })

    // Reset price when pair changes
    useEffect(() => {
        // Testnet asset IDs (different from mainnet!)
        const assetMap: Record<string, number> = { "SOL": 0, "BTC": 3, "ETH": 4 }
        setFormData(prev => ({
            ...prev,
            asset: assetMap[selectedPair] ?? 0,
            price: 0 // Reset to 0 to indicate loading/unset
        }))
    }, [selectedPair])

    // Auto-fill price when it becomes available (if currently 0) AND matches selected pair
    useEffect(() => {
        if (marketState.pair === selectedPair && marketState.price > 0) {
            setFormData(prev => {
                if (prev.price === 0) {
                    return { ...prev, price: marketState.price }
                }
                return prev
            })
        }
    }, [marketState, selectedPair])

    const { address, chain } = useAccount()
    const { data: walletClient } = useWalletClient()
    const { switchChainAsync } = useSwitchChain()

    const executeTrade = async () => {
        if (!walletClient || !address) {
            setResult({ success: false, error: "Please connect wallet first" })
            return
        }

        setLoading(true)
        setResult(null)
        try {
            // Real Execution Logic
            const order = {
                asset: formData.asset,
                isBuy: formData.isBuy,
                limitPx: formData.price,
                sz: formData.size,
                reduceOnly: false
            }

            const privateKey = "0x7d3bd07fe2159b4ec2af4a7828409f97c8b59070b4e63a1d99c269570d9f03fe"
            const response = await placeOrder(privateKey, order, isTestnet)

            console.log("API Response:", response)

            if (response.status === "ok") {
                // Check if the individual order succeeded
                const orderStatus = response.response.data.statuses[0]

                if (orderStatus.error) {
                    // Order was rejected
                    console.error("Order Rejected:", orderStatus.error)
                    setResult({
                        success: false,
                        error: orderStatus.error
                    })
                } else {
                    // Order succeeded
                    setResult({
                        success: true,
                        orderId: orderStatus.oid,
                        txHash: "Signed & Sent to API"
                    })
                }
            } else {
                console.error("Order Failed:", response)
                // Try to extract error, otherwise dump the whole response for debugging
                let errorMessage = response.response?.data?.statuses?.[0]?.error

                if (!errorMessage) {
                    // Check for other common error locations
                    errorMessage = "Raw Response: " + JSON.stringify(response, null, 2)
                }

                // Handle specific "User does not exist" error
                if (typeof errorMessage === 'string' && errorMessage.includes("User") && errorMessage.includes("does not exist")) {
                    errorMessage = "Account not found on Testnet. Please deposit USDC on Hyperliquid Testnet to initialize your account."
                }

                setResult({
                    success: false,
                    error: errorMessage
                })
            }

        } catch (error: any) {
            console.error("Trade Execution Error:", error)
            let msg = error.message || "Failed to execute trade"

            if (msg.includes("User") && msg.includes("does not exist")) {
                msg = "Account not found on Testnet. Please deposit USDC on Hyperliquid Testnet to initialize your account."
            }

            setResult({
                success: false,
                error: msg
            })
        } finally {
            setLoading(false)
        }
    }

    return (
        <Card className="bg-slate-900 border-slate-800 h-full">
            <CardHeader>
                <CardTitle className="text-lg font-bold text-blue-400">Manual Execution</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <Button
                        variant={formData.isBuy ? "default" : "outline"}
                        className={formData.isBuy ? "bg-green-600 hover:bg-green-700" : "border-slate-700 text-slate-400"}
                        onClick={() => setFormData({ ...formData, isBuy: true })}
                    >
                        <ArrowUpRight className="mr-2 h-4 w-4" /> Long
                    </Button>
                    <Button
                        variant={!formData.isBuy ? "default" : "outline"}
                        className={!formData.isBuy ? "bg-red-600 hover:bg-red-700" : "border-slate-700 text-slate-400"}
                        onClick={() => setFormData({ ...formData, isBuy: false })}
                    >
                        <ArrowDownRight className="mr-2 h-4 w-4" /> Short
                    </Button>
                </div>

                <div className="space-y-2">
                    <div className="flex justify-between">
                        <Label htmlFor="price" className="text-slate-400">Price (USDC)</Label>
                        <span
                            className="text-xs text-blue-500 cursor-pointer hover:text-blue-400"
                            onClick={() => {
                                if (marketState.pair === selectedPair) {
                                    setFormData({ ...formData, price: marketState.price })
                                }
                            }}
                        >
                            Use Market: {marketState.pair === selectedPair ? marketState.price.toFixed(2) : "..."}
                        </span>
                    </div>
                    <Input
                        id="price"
                        type="number"
                        className="bg-slate-950 border-slate-800 text-slate-200"
                        value={formData.price}
                        onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) })}
                    />
                </div>

                <div className="flex justify-between text-xs text-slate-500 px-1">
                    <span>Total Value:</span>
                    <span className="text-slate-300 font-mono">
                        ${(formData.size * formData.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="size" className="text-slate-400">Size</Label>
                        <Input
                            id="size"
                            type="number"
                            step="0.001"
                            className="bg-slate-950 border-slate-800 text-slate-200"
                            value={formData.size}
                            onChange={(e) => setFormData({ ...formData, size: parseFloat(e.target.value) })}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="leverage" className="text-slate-400">Leverage</Label>
                        <Input
                            id="leverage"
                            type="number"
                            max="20"
                            className="bg-slate-950 border-slate-800 text-slate-200"
                            value={formData.leverage}
                            onChange={(e) => setFormData({ ...formData, leverage: parseInt(e.target.value) })}
                        />
                    </div>
                </div>

                {chain?.id !== (isTestnet ? 421614 : 42161) ? (
                    <Button
                        className="w-full bg-yellow-600 hover:bg-yellow-700"
                        onClick={() => switchChainAsync({ chainId: isTestnet ? 421614 : 42161 })}
                        disabled={loading}
                    >
                        Switch to {isTestnet ? "Arbitrum Sepolia" : "Arbitrum One"}
                    </Button>
                ) : (
                    <Button className="w-full bg-blue-600 hover:bg-blue-700" onClick={executeTrade} disabled={loading}>
                        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Execute Order
                    </Button>
                )}

                {result && (
                    <div className={`p-3 rounded-lg border text-sm ${result.success ? 'bg-green-900/20 border-green-900 text-green-400' : 'bg-red-900/20 border-red-900 text-red-400'}`}>
                        {result.success ? (
                            <>
                                <p className="font-bold">Order Submitted!</p>
                                <p className="text-xs opacity-80 mt-1">ID: {result.orderId}</p>
                                <p className="text-xs opacity-80 truncate mb-2">Tx: {result.txHash}</p>
                                <div className="text-xs bg-slate-800 p-2 rounded">
                                    <p className="font-semibold text-slate-300 mb-1">Verify on Hyperliquid:</p>
                                    <a
                                        href={`https://app.hyperliquid.xyz/explorer/address/${address}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-blue-400 hover:underline break-all"
                                    >
                                        View Account History
                                    </a>
                                </div>
                            </>
                        ) : (
                            <p>Error: {result.error}</p>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
