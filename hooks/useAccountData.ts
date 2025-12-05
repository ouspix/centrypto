"use client"

import { useState, useEffect } from "react"
import { useAccount } from "wagmi"
import { useTrading } from "@/context/TradingContext"

interface AccountData {
    accountValue: string
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
                const apiUrl = isTestnet
                    ? 'https://api.hyperliquid-testnet.xyz/info'
                    : 'https://api.hyperliquid.xyz/info'

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: "clearinghouseState",
                        user: address
                    })
                })

                if (!response.ok) throw new Error('Failed to fetch account data')

                const data = await response.json()

                // Calculate Account Value
                const marginSummary = data.marginSummary
                const accountVal = parseFloat(marginSummary.accountValue)

                // Calculate Unrealized PnL
                const assetPositions = data.assetPositions || []
                const unrealized = assetPositions.reduce((acc: number, pos: any) => {
                    return acc + parseFloat(pos.position.unrealizedPnl)
                }, 0)

                // Calculate Total Exposure %
                const openPositions = assetPositions
                    .filter((pos: any) => parseFloat(pos.position.szi) !== 0)
                    .map((pos: any) => ({
                        coin: pos.position.coin,
                        size: parseFloat(pos.position.szi),
                        entryPx: parseFloat(pos.position.entryPx),
                        leverage: parseFloat(pos.position.leverage?.value ?? "1")
                    }))

                let priceData: Record<string, string> = {}
                if (openPositions.length > 0) {
                    const priceRes = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: "allMids" })
                    })

                    if (priceRes.ok) {
                        priceData = await priceRes.json()
                    }
                }

                const totals = openPositions.reduce((acc, pos) => {
                    const price = priceData[pos.coin] ? parseFloat(priceData[pos.coin]) : pos.entryPx
                    if (!Number.isFinite(price)) return acc

                    const exposureUsd = Math.abs(pos.size) * price
                    const lev = Number.isFinite(pos.leverage) && pos.leverage > 0 ? pos.leverage : 1
                    const marginUsd = exposureUsd / lev

                    acc.exposureUsd += exposureUsd
                    acc.marginUsd += marginUsd
                    return acc
                }, { exposureUsd: 0, marginUsd: 0 })

                const exposurePct = accountVal > 0 ? (totals.exposureUsd / accountVal) * 100 : 0
                const marginPct = accountVal > 0 ? (totals.marginUsd / accountVal) * 100 : 0

                setAccountValue(accountVal.toFixed(2))
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
            setUnrealizedPnl("0.00")
            setTotalExposurePct("0.00")
            setMarginUsagePct("0.00")
            setLoading(false)
            setError(null)
        }
    }, [address, isConnected, isTestnet])

    return {
        accountValue,
        unrealizedPnl,
        totalExposurePct,
        marginUsagePct,
        loading,
        error
    }
}
