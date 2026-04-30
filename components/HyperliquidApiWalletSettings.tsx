"use client"

import { useCallback, useEffect, useState } from "react"
import { useAccount } from "wagmi"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, Trash2 } from "lucide-react"

type ApiWalletStatus = {
    configured: boolean
    apiWalletAddress: string | null
    delegationValidUntil: string | null
    updatedAt: string | null
}

export function HyperliquidApiWalletSettings({
    isTestnet,
    walletSessionAddress
}: {
    isTestnet: boolean
    walletSessionAddress?: string | null
}) {
    const { address, isConnected } = useAccount()
    const [status, setStatus] = useState<ApiWalletStatus | null>(null)
    const [privateKey, setPrivateKey] = useState("")
    const [loading, setLoading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [formError, setFormError] = useState<string | null>(null)
    const [deleteError, setDeleteError] = useState<string | null>(null)
    const [acknowledgedDelegatedKeyWarning, setAcknowledgedDelegatedKeyWarning] = useState(false)

    const network = isTestnet ? "testnet" : "mainnet"
    const hasWalletSession = !address || walletSessionAddress === undefined || walletSessionAddress === address.toLowerCase()

    const loadStatus = useCallback(async () => {
        setLoading(true)
        setLoadError(null)
        try {
            const response = await fetch(`/api/hyperliquid/api-wallet?network=${network}`)
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload.error || "Failed to load API wallet")
            setStatus(payload)
        } catch (err) {
            setStatus(null)
            setLoadError(err instanceof Error ? err.message : "Failed to load API wallet")
        } finally {
            setLoading(false)
        }
    }, [network])

    useEffect(() => {
        if (!isConnected || !hasWalletSession) {
            setStatus(null)
            setLoadError(null)
            setFormError(null)
            setDeleteError(null)
            return
        }
        void loadStatus()
    }, [isConnected, hasWalletSession, loadStatus])

    const saveWallet = async () => {
        if (!hasWalletSession) return
        setSaving(true)
        setFormError(null)
        try {
            const response = await fetch("/api/hyperliquid/api-wallet", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ privateKey, isTestnet, acknowledgeDelegatedKeyWarning: acknowledgedDelegatedKeyWarning })
            })
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload.error || "Failed to save API wallet")
            setStatus(payload)
            setPrivateKey("")
            setAcknowledgedDelegatedKeyWarning(false)
        } catch (err) {
            setFormError(err instanceof Error ? err.message : "Failed to save API wallet")
        } finally {
            setSaving(false)
        }
    }

    const deleteWallet = async () => {
        if (!hasWalletSession) return
        setSaving(true)
        setDeleteError(null)
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
            setAcknowledgedDelegatedKeyWarning(false)
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : "Failed to delete API wallet")
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

            {configured ? (
                <div className="space-y-2">
                    {maskedAddress && (
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
                                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            </Button>
                        </div>
                    )}
                    {status?.delegationValidUntil && (
                        <div className="text-[11px] text-slate-500">
                            Approved until {new Date(status.delegationValidUntil).toLocaleString()}
                        </div>
                    )}
                    {deleteError && (
                        <div className="rounded border border-red-900/70 bg-red-950/30 p-2 text-xs text-red-300">
                            {deleteError}
                        </div>
                    )}
                </div>
            ) : (
                <div className="space-y-2">
                    <Label htmlFor={`hl-api-wallet-key-${network}`} className="text-xs text-slate-400">
                        Delegated API Wallet Private Key
                    </Label>
                    <div className="flex gap-2 rounded border border-amber-900/70 bg-amber-950/30 p-2 text-xs text-amber-200">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            Use only a delegated Hyperliquid API wallet key. Never paste the connected wallet private key.
                        </span>
                    </div>
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
                            disabled={saving || !privateKey.trim() || !acknowledgedDelegatedKeyWarning}
                        >
                            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                            Save
                        </Button>
                    </div>
                    <label className="flex items-start gap-2 text-xs text-slate-300">
                        <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-950"
                            checked={acknowledgedDelegatedKeyWarning}
                            onChange={(event) => setAcknowledgedDelegatedKeyWarning(event.target.checked)}
                        />
                        <span>This key is delegated for Hyperliquid API trading and is not my connected wallet private key.</span>
                    </label>
                    {(loadError || formError) && (
                        <div className="rounded border border-red-900/70 bg-red-950/30 p-2 text-xs text-red-300">
                            {loadError || formError}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
