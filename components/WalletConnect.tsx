"use client"

import { useAccount, useConnect, useDisconnect, useBalance, useSwitchChain } from "wagmi"
import { Button } from "@/components/ui/button"
import { Loader2, Wallet } from "lucide-react"
import { injected } from "wagmi/connectors"
import { useEffect, useState } from "react"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { useTrading } from "@/context/TradingContext"

export function WalletConnect() {
    const { address, isConnected } = useAccount()
    const { connect, isPending } = useConnect()
    const { disconnect } = useDisconnect()
    const { data: balance } = useBalance({ address })
    const { switchChainAsync } = useSwitchChain()
    const { isTestnet, setIsTestnet } = useTrading()

    // Prevent hydration errors by only rendering after client-side mount
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
        setMounted(true)
    }, [])

    if (!mounted) {
        return null
    }

    if (isConnected) {
        return (
            <div className="flex items-center gap-4">
                <div className="flex items-center space-x-2 border border-slate-700 rounded-md px-3 py-1">
                    <Switch
                        id="testnet-mode"
                        checked={isTestnet}
                        onCheckedChange={async (checked: boolean) => {
                            console.log(`🔄 Network toggle clicked: ${checked ? 'TESTNET' : 'MAINNET'}`)
                            setIsTestnet(checked)
                            try {
                                await switchChainAsync({ chainId: checked ? 421614 : 42161 })
                            } catch (e) {
                                console.error("Failed to switch network:", e)
                            }
                        }}
                    />
                    <Label htmlFor="testnet-mode" className="text-xs font-medium cursor-pointer">
                        {isTestnet ? (
                            <span className="text-orange-400">Testnet</span>
                        ) : (
                            <span className="text-blue-400">Mainnet</span>
                        )}
                    </Label>
                </div>
                <div className="flex flex-col items-end">
                    <span className="text-sm font-bold text-slate-200">
                        {address?.slice(0, 6)}...{address?.slice(-4)}
                    </span>
                    {balance && (
                        <span className="text-xs text-slate-400">
                            {parseFloat(balance.formatted).toFixed(4)} {balance.symbol}
                        </span>
                    )}
                </div>
                <Button variant="outline" size="sm" onClick={() => disconnect()} className="border-red-900/50 text-red-400 hover:bg-red-900/20">
                    Disconnect
                </Button>
            </div>
        )
    }

    return (
        <Button
            variant="default"
            size="sm"
            onClick={() => connect({ connector: injected() })}
            disabled={isPending}
            className="bg-blue-600 hover:bg-blue-500 text-white"
        >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Wallet className="h-4 w-4 mr-2" />}
            Connect Wallet
        </Button>
    )
}
