"use client"

import { useState, useEffect } from "react"
import { useAccount } from "wagmi"
import { useTrading } from "@/context/TradingContext"

interface AccountData {
    accountValue: string
    unrealizedPnl: string
    loading: boolean
    error: string | null
}

export function useAccountData(): AccountData {
    const { address, isConnected } = useAccount()
    const { isTestnet } = useTrading()
    const [accountValue, setAccountValue] = useState<string>("0.00")
    const [unrealizedPnl, setUnrealizedPnl] = useState<string>("0.00")
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
                const unrealized = data.assetPositions.reduce((acc: number, pos: any) => {
                    return acc + parseFloat(pos.position.unrealizedPnl)
                }, 0)

                setAccountValue(accountVal.toFixed(2))
                setUnrealizedPnl(unrealized.toFixed(2))

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
            setLoading(false)
            setError(null)
        }
    }, [address, isConnected, isTestnet])

    return {
        accountValue,
        unrealizedPnl,
        loading,
        error
    }
}
