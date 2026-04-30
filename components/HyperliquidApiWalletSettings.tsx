"use client"

import { useCallback, useEffect, useState } from "react"
import { useAccount } from "wagmi"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CheckCircle2, KeyRound, Loader2, Trash2 } from "lucide-react"

type ApiWalletStatus = {
    configured: boolean
    apiWalletAddress: string | null
    delegationValidUntil: string | null
    updatedAt: string | null
}

export function HyperliquidApiWalletSettings({ isTestnet }: { isTestnet: boolean }) {
    const { isConnected } = useAccount()
    const [status, setStatus] = useState<ApiWalletStatus | null>(null)
    const [privateKey, setPrivateKey] = useState("")
    const [loading, setLoading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const network = isTestnet ? "testnet" : "mainnet"

    const loadStatus = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const response = await fetch(`/api/hyperliquid/api-wallet?network=${network}`)
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload.error || "Failed to load API wallet")
            setStatus(payload)
        } catch (err) {
            setStatus(null)
            setError(err instanceof Error ? err.message : "Failed to load API wallet")
        } finally {
            setLoading(false)
        }
    }, [network])

    useEffect(() => {
        if (!isConnected) {
            setStatus(null)
            return
        }
        void loadStatus()
    }, [isConnected, loadStatus])

    const saveWallet = async () => {
        setSaving(true)
        setError(null)
        try {
            const response = await fetch("/api/hyperliquid/api-wallet", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ privateKey, isTestnet })
            })
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload.error || "Failed to save API wallet")
            setStatus(payload)
            setPrivateKey("")
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save API wallet")
        } finally {
            setSaving(false)
        }
    }

    const deleteWallet = async () => {
        setSaving(true)
        setError(null)
        try {
            const response = await fetch("/api/hyperliquid/api-wallet", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ isTestnet })
            })
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload.error || "Failed to delete API wallet")
            setStatus({ configured: false, apiWalletAddress: null, delegationValidUntil: null, updatedAt: null })
            setPrivateKey("")
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to delete API wallet")
        } finally {
            setSaving(false)
        }
    }

    if (!isConnected) return null

    const configured = !!status?.configured
    const maskedAddress = status?.apiWalletAddress
        ? `${status.apiWalletAddress.slice(0, 6)}...${status.apiWalletAddress.slice(-4)}`
        : null

    return (
        <div className="space-y-3 rounded border border-slate-800 bg-slate-950/70 p-3">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                    {configured ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    ) : (
                        <KeyRound className="h-4 w-4 text-amber-400" />
                    )}
                    Hyperliquid API Wallet
                </div>
                <span className={`text-[11px] ${configured ? "text-emerald-400" : "text-amber-400"}`}>
                    {loading ? "Checking..." : configured ? "Ready" : "Required"}
                </span>
            </div>

            {configured && maskedAddress && (
                <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                    <span className="font-mono">{maskedAddress}</span>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-400 hover:bg-red-950/30 hover:text-red-300"
                        onClick={deleteWallet}
                        disabled={saving}
                        aria-label="Delete API wallet"
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            )}

            <div className="space-y-2">
                <Label htmlFor={`hl-api-wallet-key-${network}`} className="text-xs text-slate-400">
                    Delegated API Wallet Private Key
                </Label>
                <div className="flex gap-2">
                    <Input
                        id={`hl-api-wallet-key-${network}`}
                        type="password"
                        autoComplete="off"
                        placeholder="0x..."
                        className="bg-slate-950 border-slate-700 text-slate-200"
                        value={privateKey}
                        onChange={(event) => setPrivateKey(event.target.value)}
                    />
                    <Button
                        type="button"
                        size="sm"
                        className="shrink-0 bg-slate-800 text-slate-100 hover:bg-slate-700"
                        onClick={saveWallet}
                        disabled={saving || !privateKey.trim()}
                    >
                        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                        Save
                    </Button>
                </div>
            </div>

            {status?.delegationValidUntil && (
                <div className="text-[11px] text-slate-500">
                    Approved until {new Date(status.delegationValidUntil).toLocaleString()}
                </div>
            )}

            {error && (
                <div className="rounded border border-red-900/70 bg-red-950/30 p-2 text-xs text-red-300">
                    {error}
                </div>
            )}
        </div>
    )
}
