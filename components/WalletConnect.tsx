"use client"

import { useAccount, useConnect, useDisconnect, useBalance, useSwitchChain, useWalletClient } from "wagmi"
import { Button } from "@/components/ui/button"
import { Loader2, Wallet } from "lucide-react"
import { injected } from "wagmi/connectors"
import { useEffect, useState } from "react"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { useTrading } from "@/context/TradingContext"

const SESSION_REFRESH_SKEW_MS = 60 * 1000;

export function WalletConnect() {
    const { address, isConnected } = useAccount()
    const { connect, isPending } = useConnect()
    const { disconnect } = useDisconnect()
    const { data: balance } = useBalance({ address })
    const { data: walletClient } = useWalletClient()
    const { switchChainAsync } = useSwitchChain()
    const trading = useTrading()
    const { isTestnet, setIsTestnet, walletSessionAddress } = trading
    const setWalletSessionAddress = trading.setWalletSessionAddress ?? (() => {})

    // Prevent hydration errors by only rendering after client-side mount
    const [mounted, setMounted] = useState(false)
    const [authenticating, setAuthenticating] = useState(false)
    const [authError, setAuthError] = useState<string | null>(null)
    const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null)

    useEffect(() => {
        setMounted(true)
    }, [])

    useEffect(() => {
        if (!mounted || !isConnected || !address || !walletClient) return;
        const normalized = address.toLowerCase();
        const hasFreshSession = walletSessionAddress === normalized
            && sessionExpiresAt !== null
            && sessionExpiresAt - Date.now() > SESSION_REFRESH_SKEW_MS;
        if (authError && walletSessionAddress !== normalized) return;
        if (hasFreshSession || authenticating) return;
        void ensureWalletSession(false);
    }, [mounted, isConnected, address, walletClient, walletSessionAddress, sessionExpiresAt, authenticating, authError])

    useEffect(() => {
        if (!sessionExpiresAt) return;
        const refreshInMs = Math.max(1000, sessionExpiresAt - Date.now() - SESSION_REFRESH_SKEW_MS);
        const id = window.setTimeout(() => {
            setSessionExpiresAt(null);
        }, refreshInMs);
        return () => window.clearTimeout(id);
    }, [sessionExpiresAt])

    useEffect(() => {
        setSessionExpiresAt(null)
        setAuthError(null)
    }, [address])

    useEffect(() => {
        if (!isConnected) {
            setWalletSessionAddress(null)
            setSessionExpiresAt(null)
            setAuthError(null)
        }
    }, [isConnected, setWalletSessionAddress])

    const ensureWalletSession = async (allowSignature = false) => {
        if (!address || !walletClient) return;
        setAuthenticating(true)
        setAuthError(null)
        try {
            const session = await Promise.resolve(fetch('/api/auth/session')).catch(() => null)
            if (session?.ok) {
                const payload = await session.json()
                if (payload.address?.toLowerCase() === address.toLowerCase()) {
                    const expiresAt = typeof payload.expiresAt === 'number' ? payload.expiresAt : null;
                    setWalletSessionAddress(payload.address.toLowerCase())
                    setSessionExpiresAt(expiresAt)
                    if (expiresAt !== null && expiresAt - Date.now() > SESSION_REFRESH_SKEW_MS) {
                        return
                    }
                    if (await refreshWalletSession()) {
                        return
                    }
                }
            }
            setSessionExpiresAt(null)
            if (allowSignature) {
                await authenticateWallet()
            } else {
                setWalletSessionAddress(null)
                setAuthError('Wallet authentication required')
            }
        } finally {
            setAuthenticating(false)
        }
    }

    const refreshWalletSession = async () => {
        if (!address) return false;
        const refreshed = await fetch('/api/auth/session', { method: 'POST' }).catch(() => null)
        if (!refreshed?.ok) return false;
        const payload = await refreshed.json()
        if (payload.address?.toLowerCase() !== address.toLowerCase()) return false;
        setWalletSessionAddress(payload.address.toLowerCase())
        setSessionExpiresAt(typeof payload.expiresAt === 'number' ? payload.expiresAt : null)
        return true;
    }

    const authenticateWallet = async () => {
        if (!address || !walletClient) return;
        setAuthError(null)
        try {
            const challenge = await fetch('/api/auth/challenge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address })
            })
            if (!challenge.ok) throw new Error('Wallet challenge failed')
            const { message } = await challenge.json()
            const signature = await walletClient.signMessage({
                account: address as `0x${string}`,
                message
            })
            const verified = await fetch('/api/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, signature })
            })
            if (!verified.ok) {
                const payload = await verified.json().catch(() => ({}))
                throw new Error(payload.error || 'Wallet authentication failed')
            }
            const payload = await verified.json()
            setWalletSessionAddress(payload.address?.toLowerCase() ?? null)
            setSessionExpiresAt(typeof payload.expiresAt === 'number' ? payload.expiresAt : null)
        } catch (error) {
            setWalletSessionAddress(null)
            setSessionExpiresAt(null)
            setAuthError(error instanceof Error ? error.message : 'Wallet authentication failed')
        }
    }

    const disconnectWallet = () => {
        void fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
        setWalletSessionAddress(null)
        setSessionExpiresAt(null)
        disconnect()
    }

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
                    {authenticating && (
                        <span className="text-xs text-amber-400">Signing session...</span>
                    )}
                    {!authenticating && authError && (
                        <button className="text-xs text-red-400 hover:text-red-300" onClick={() => ensureWalletSession(true)}>
                            Auth required
                        </button>
                    )}
                    {!authenticating && !authError && walletSessionAddress && (
                        <span className="text-xs text-emerald-400">Authenticated</span>
                    )}
                    {balance && (
                        <span className="text-xs text-slate-400">
                            {parseFloat(balance.formatted).toFixed(4)} {balance.symbol}
                        </span>
                    )}
                </div>
                <Button variant="outline" size="sm" onClick={disconnectWallet} className="border-red-900/50 text-red-400 hover:bg-red-900/20">
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
