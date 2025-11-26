
"use client"

import { useState, useEffect } from "react"
import { useAccount, useWalletClient, useSwitchChain } from "wagmi"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, ArrowUpRight, ArrowDownRight, Zap } from "lucide-react"

import { useTrading } from "@/context/TradingContext"
import { placeOrderAction } from "@/app/actions/trade"

export function TradeForm() {
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState<any>(null)
    const { selectedPair, marketState, isTestnet, assetMetadata } = useTrading()
    const [formData, setFormData] = useState({
        asset: 0,
        isBuy: true,
        price: 0,
        size: 0.01,
        leverage: 5
    })

    // Get metadata for selected pair
    const currentMeta = assetMetadata[selectedPair]

    // Reset price and update asset when pair changes
    useEffect(() => {
        if (currentMeta) {
            setFormData(prev => ({
                ...prev,
                asset: currentMeta.index,
                price: 0 // Reset to 0 to indicate loading/unset
            }))
        }
    }, [selectedPair, currentMeta])

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

        if (!currentMeta) {
            setResult({ success: false, error: "Market data not loaded. Please wait." })
            return
        }

        // Minimum order value check
        const totalValue = formData.size * formData.price
        if (totalValue < 10) {
            setResult({
                success: false,
                error: `Order value must be at least $10. Current value: $${totalValue.toFixed(2)}`
            })
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

            const actionResponse = await placeOrderAction(order, isTestnet)
            console.log("Server Action Response:", actionResponse)

            if (actionResponse.success) {
                const response = actionResponse.data

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
                        // Status can be { resting: { oid: ... } } or { filled: { oid: ... } }
                        const oid = orderStatus.resting?.oid || orderStatus.filled?.oid || orderStatus.oid

                        setResult({
                            success: true,
                            orderId: oid,
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
            } else {
                setResult({
                    success: false,
                    error: actionResponse.error
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

    // Calculate step based on decimals (e.g. 3 decimals -> 0.001)
    const sizeStep = currentMeta ? Math.pow(10, -currentMeta.szDecimals).toFixed(currentMeta.szDecimals) : "0.01"
    const minSize = currentMeta ? currentMeta.minSz : 0

    return (
        <div className="space-y-4">
            {!currentMeta && (
                <div className="bg-yellow-900/20 border border-yellow-700 text-yellow-400 text-xs p-2 rounded">
                    Loading market data...
                </div>
            )}
            <div className="grid grid-cols-2 gap-3">
                <Button
                    variant={formData.isBuy ? "default" : "outline"}
                    className={`transition-all ${formData.isBuy ? 'bg-gradient-to-r from-green-600 to-green-500 hover:from-green-700 hover:to-green-600 shadow-lg shadow-green-500/20' : 'border-green-900/50 text-green-400 hover:bg-green-950/20 hover:border-green-700/50'}`}
                    onClick={() => setFormData({ ...formData, isBuy: true })}
                >
                    <ArrowUpRight className="mr-2 h-4 w-4" /> Long
                </Button>
                <Button
                    variant={!formData.isBuy ? "default" : "outline"}
                    className={`transition-all ${!formData.isBuy ? 'bg-gradient-to-r from-red-600 to-red-500 hover:from-red-700 hover:to-red-600 shadow-lg shadow-red-500/20' : 'border-red-900/50 text-red-400 hover:bg-red-950/20 hover:border-red-700/50'}`}
                    onClick={() => setFormData({ ...formData, isBuy: false })}
                >
                    <ArrowDownRight className="mr-2 h-4 w-4" /> Short
                </Button>
            </div>

            <div className="space-y-2">
                <div className="flex justify-between">
                    <Label htmlFor="price" className="text-slate-400/60 text-xs">Price (USDC)</Label>
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
                    className="bg-slate-950 border-slate-700 text-slate-200 focus:border-blue-500 transition-colors"
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

            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                    <Label htmlFor="size" className="text-slate-400/60 text-xs">Size ({selectedPair})</Label>
                    <Input
                        id="size"
                        type="number"
                        step={sizeStep}
                        min={minSize}
                        className="bg-slate-950 border-slate-700 text-slate-200 focus:border-blue-500 transition-colors"
                        value={formData.size}
                        onChange={(e) => setFormData({ ...formData, size: parseFloat(e.target.value) })}
                    />
                    {currentMeta && (
                        <div className="text-[10px] text-slate-500 text-right">
                            Min: {currentMeta.minSz}
                        </div>
                    )}
                </div>
                <div className="space-y-2">
                    <Label htmlFor="leverage" className="text-slate-400/60 text-xs">Leverage</Label>
                    <Input
                        id="leverage"
                        type="number"
                        max="20"
                        className="bg-slate-950 border-slate-700 text-slate-200 focus:border-blue-500 transition-colors"
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
                <Button
                    className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 shadow-lg shadow-blue-500/20 transition-all"
                    onClick={executeTrade}
                    disabled={loading}
                >
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    <Zap className="mr-2 h-4 w-4" />
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
        </div>
    )
}
