"use server"

import { placeOrder, cancelOrder } from "@/lib/hyperliquid"
import type { PlaceOrderRequest } from "@/lib/hyperliquid"

export async function placeOrderAction(
    order: PlaceOrderRequest,
    isTestnet: boolean
) {
    const privateKey = isTestnet
        ? process.env.HYPERLIQUID_TESTNET_PRIVATE_KEY
        : process.env.HYPERLIQUID_PRIVATE_KEY

    if (!privateKey) {
        throw new Error(
            isTestnet
                ? "HYPERLIQUID_TESTNET_PRIVATE_KEY is not set"
                : "HYPERLIQUID_PRIVATE_KEY is not set"
        )
    }

    try {
        const result = await placeOrder(privateKey, order, isTestnet)
        return { success: true, data: result }
    } catch (error: any) {
        console.error("Server Action placeOrder failed:", error)
        return { success: false, error: error.message || "Failed to place order" }
    }
}

export async function cancelOrderAction(
    cancelRequest: {
        asset: number
        oid: number
    },
    isTestnet: boolean
) {
    const privateKey = isTestnet
        ? process.env.HYPERLIQUID_TESTNET_PRIVATE_KEY
        : process.env.HYPERLIQUID_PRIVATE_KEY

    if (!privateKey) {
        throw new Error(
            isTestnet
                ? "HYPERLIQUID_TESTNET_PRIVATE_KEY is not set"
                : "HYPERLIQUID_PRIVATE_KEY is not set"
        )
    }

    try {
        const result = await cancelOrder(privateKey, cancelRequest, isTestnet)
        return { success: true, data: result }
    } catch (error: any) {
        console.error("Server Action cancelOrder failed:", error)
        return { success: false, error: error.message || "Failed to cancel order" }
    }
}
