"use client"

import { useState, useEffect } from "react"
import { useAccount } from "wagmi"
import { useTrading } from "@/context/TradingContext"

interface AccountData {
    accountValue: string
    perpAccountValue: string
    spotUsdc: string
    equitySource: "perps" | "spot_usdc" | null
    unrealizedPnl: string
    totalExposurePct: string
    marginUsagePct: string
    loading: boolean
    error: string | null
}

export function useAccountData(): AccountData {
    const { address, isConnected } = useAccount()
    const { isTestnet } = useTrading()
    const [accountValue, setAccountValue] = useState<string>("0.00")
    const [perpAccountValue, setPerpAccountValue] = useState<string>("0.00")
    const [spotUsdc, setSpotUsdc] = useState<string>("0.00")
    const [equitySource, setEquitySource] = useState<"perps" | "spot_usdc" | null>(null)
    const [unrealizedPnl, setUnrealizedPnl] = useState<string>("0.00")
    const [totalExposurePct, setTotalExposurePct] = useState<string>("0.00")
    const [marginUsagePct, setMarginUsagePct] = useState<string>("0.00")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const fetchAccountData = async () => {
            if (!address) return

            setLoading(true)
            setError(null)

            try {
                const network = isTestnet ? "testnet" : "mainnet"
                const response = await fetch(`/api/hyperliquid/account?network=${network}&address=${encodeURIComponent(address)}`, {
                    cache: "no-store",
                    credentials: "same-origin"
                })

                const data = await response.json().catch(() => ({}))
                if (!response.ok) throw new Error(data.error || 'Failed to fetch account data')

                const accountVal = numberFrom(data.accountValue)
                const perpAccountVal = numberFrom(data.perpAccountValue)
                const spotUsdcValue = numberFrom(data.spotUsdc)
                const unrealized = numberFrom(data.unrealizedPnl)
                const exposurePct = numberFrom(data.totalExposurePct)
                const marginPct = numberFrom(data.marginUsagePct)
                setAccountValue(accountVal.toFixed(2))
                setPerpAccountValue(perpAccountVal.toFixed(2))
                setSpotUsdc(spotUsdcValue.toFixed(2))
                setEquitySource(data.equitySource === "spot_usdc" ? "spot_usdc" : "perps")
                setUnrealizedPnl(unrealized.toFixed(2))
                setTotalExposurePct(exposurePct.toFixed(2))
                setMarginUsagePct(marginPct.toFixed(2))

            } catch (err) {
                console.error("Failed to fetch account data", err)
                setError(err instanceof Error ? err.message : "Unknown error")
            } finally {
                setLoading(false)
            }
        }

        if (isConnected && address) {
            fetchAccountData()
            // Poll every 10 seconds
            const interval = setInterval(fetchAccountData, 10000)
            return () => clearInterval(interval)
        } else {
            setAccountValue("0.00")
            setPerpAccountValue("0.00")
            setSpotUsdc("0.00")
            setEquitySource(null)
            setUnrealizedPnl("0.00")
            setTotalExposurePct("0.00")
            setMarginUsagePct("0.00")
            setLoading(false)
            setError(null)
        }
    }, [address, isConnected, isTestnet])

    return {
        accountValue,
        perpAccountValue,
        spotUsdc,
        equitySource,
        unrealizedPnl,
        totalExposurePct,
        marginUsagePct,
        loading,
        error
    }
}

function numberFrom(value: unknown): number {
    const parsed = typeof value === "number" ? value : parseFloat(String(value ?? "0"))
    return Number.isFinite(parsed) ? parsed : 0
}
