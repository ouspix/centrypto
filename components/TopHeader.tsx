"use client"

import { WalletConnect } from "@/components/WalletConnect"
import { useTrading } from "@/context/TradingContext"
import { useAccountData } from "@/hooks/useAccountData"
import { Loader2, Percent, TrendingUp, Wallet } from "lucide-react"

export function TopHeader() {
    const { isTestnet } = useTrading()
    const { accountValue, unrealizedPnl, totalExposurePct, loading } = useAccountData()

    const pnlValue = parseFloat(unrealizedPnl)
    const isPnlPositive = pnlValue >= 0

    return (
        <header className="fixed left-20 right-0 top-0 z-30 border-b border-slate-800 bg-slate-950/95 backdrop-blur-sm">
            <div className="flex h-16 items-center justify-between px-6">
                {/* Left: Branding */}
                <div className="flex items-center gap-2">
                    <span className="font-orbitron text-xl font-bold bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-500 bg-clip-text text-transparent">
                        Centrypto
                    </span>
                </div>

                {/* Center: Account Stats */}
                <div className="flex items-center gap-8">
                    {/* Account Value */}
                    <div className="flex items-center gap-3">
                        <Wallet className="h-5 w-5 text-slate-400" />
                        <div className="flex flex-col">
                            <span className="text-xs text-slate-400/60">Account Value</span>
                            {loading && accountValue === "0.00" ? (
                                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                            ) : (
                                <span className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
                                    ${accountValue}
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Total Exposure */}
                    <div className="flex items-center gap-3">
                        <Percent className="h-5 w-5 text-slate-400" />
                        <div className="flex flex-col">
                            <span className="text-xs text-slate-400/60">Total Exposure</span>
                            {loading && totalExposurePct === "0.00" ? (
                                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                            ) : (
                                <span className="text-2xl font-bold text-cyan-300">
                                    {totalExposurePct}%
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Unrealized PnL */}
                    <div className="flex items-center gap-3">
                        <TrendingUp className="h-5 w-5 text-slate-400" />
                        <div className="flex flex-col">
                            <span className="text-xs text-slate-400/60">Unrealized PnL</span>
                            {loading && unrealizedPnl === "0.00" ? (
                                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                            ) : (
                                <span className={`text-2xl font-bold ${isPnlPositive ? 'text-green-400' : 'text-red-400'}`}>
                                    {isPnlPositive ? '+' : ''}${unrealizedPnl}
                                </span>
                            )}
                        </div>
                    </div>


                </div>

                {/* Right: Wallet Connection */}
                <WalletConnect />
            </div>
        </header>
    )
}
