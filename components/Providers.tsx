"use client"

import { TradingProvider } from "@/context/TradingContext"
import { Web3Provider as Web3ProviderWrapper } from "@/components/Web3Provider"

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <Web3ProviderWrapper>
            <TradingProvider>
                {children}
            </TradingProvider>
        </Web3ProviderWrapper>
    )
}
