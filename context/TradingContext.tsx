"use client"

import React, { createContext, useContext, useState, ReactNode } from 'react'

type TradingContextType = {
    selectedPair: string
    setSelectedPair: (pair: string) => void
    marketState: { pair: string, price: number }
    setMarketState: (state: { pair: string, price: number }) => void
    isTestnet: boolean
    setIsTestnet: (isTestnet: boolean) => void
}

const TradingContext = createContext<TradingContextType | undefined>(undefined)

export function TradingProvider({ children }: { children: ReactNode }) {
    const [selectedPair, setSelectedPair] = useState<string>("BTC")
    const [marketState, setMarketState] = useState<{ pair: string, price: number }>({ pair: "BTC", price: 0 })
    const [isTestnet, setIsTestnet] = useState<boolean>(false)

    return (
        <TradingContext.Provider value={{ selectedPair, setSelectedPair, marketState, setMarketState, isTestnet, setIsTestnet }}>
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
