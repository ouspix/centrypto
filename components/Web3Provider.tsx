"use client"

import { WagmiProvider, createConfig, http } from "wagmi"
import { mainnet, arbitrum, arbitrumSepolia } from "wagmi/chains"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { injected } from "wagmi/connectors"
import { ReactNode } from "react"
import { defineChain } from "viem"

const queryClient = new QueryClient()

// Define localhost chain with chainId 1337 for Hyperliquid signing
const localhost = defineChain({
    id: 1337,
    name: 'Localhost',
    nativeCurrency: {
        decimals: 18,
        name: 'Ether',
        symbol: 'ETH',
    },
    rpcUrls: {
        default: { http: ['http://127.0.0.1:8545'] },
    },
})

export const config = createConfig({
    chains: [arbitrum, arbitrumSepolia, mainnet, localhost],
    connectors: [
        injected(),
    ],
    transports: {
        [arbitrum.id]: http(),
        [arbitrumSepolia.id]: http(),
        [mainnet.id]: http(),
        [localhost.id]: http(),
    },
})

export function Web3Provider({ children }: { children: ReactNode }) {
    return (
        <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
                {children}
            </QueryClientProvider>
        </WagmiProvider>
    )
}
