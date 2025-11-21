"use client"

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { getMeta, AssetMeta } from '@/lib/hyperliquid'

type TradingContextType = {
    selectedPair: string
    setSelectedPair: (pair: string) => void
    marketState: { pair: string, price: number }
    setMarketState: (state: { pair: string, price: number }) => void
    isTestnet: boolean
    setIsTestnet: (isTestnet: boolean) => void
    assetMetadata: Record<string, AssetMeta & { index: number }>
}

const TradingContext = createContext<TradingContextType | undefined>(undefined)

export function TradingProvider({ children }: { children: ReactNode }) {
    const [selectedPair, setSelectedPair] = useState<string>("BTC")
    const [marketState, setMarketState] = useState<{ pair: string, price: number }>({ pair: "BTC", price: 0 })
    const [isTestnet, setIsTestnet] = useState<boolean>(false)
    const [assetMetadata, setAssetMetadata] = useState<Record<string, AssetMeta & { index: number }>>({})
    const [metadataCache, setMetadataCache] = useState<{ mainnet: AssetMeta[] | null, testnet: AssetMeta[] | null }>({
        mainnet: null,
        testnet: null
    })

    // Fetch metadata on mount and when network changes
    React.useEffect(() => {
        const fetchMetadata = async () => {
            const cacheKey = isTestnet ? 'testnet' : 'mainnet'

            // Check cache first
            if (metadataCache[cacheKey]) {
                console.log(`Using cached metadata for ${cacheKey}`)
                processMetadata(metadataCache[cacheKey]!)
                return
            }

            console.log(`Fetching metadata for ${cacheKey}...`)
            const universe = await getMeta(isTestnet)

            if (universe.length > 0) {
                // Update cache
                setMetadataCache(prev => ({ ...prev, [cacheKey]: universe }))
                processMetadata(universe)
            }
        }

        const processMetadata = (universe: AssetMeta[]) => {
            const map: Record<string, AssetMeta & { index: number }> = {}
            universe.forEach((asset, index) => {
                map[asset.name] = { ...asset, index }
            })
            setAssetMetadata(map)
            console.log("Asset metadata loaded:", Object.keys(map).length, "assets")
        }

        fetchMetadata()
    }, [isTestnet]) // Depend on isTestnet to refetch/switch cache

    return (
        <TradingContext.Provider value={{ selectedPair, setSelectedPair, marketState, setMarketState, isTestnet, setIsTestnet, assetMetadata }}>
            {children}
        </TradingContext.Provider>
    )
}

export function useTrading() {
    const context = useContext(TradingContext)
    if (context === undefined) {
        throw new Error("useTrading must be used within a TradingProvider")
    }
    return context
}
