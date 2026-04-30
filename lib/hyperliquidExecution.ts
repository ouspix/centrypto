import "server-only";

import { placeOrderWithPrivateKey as hlPlaceOrder, cancelOrderWithPrivateKey as hlCancelOrder } from "./hyperliquid-execution";
import { ApprovedOrder } from "@/types/trading";

// Re-export for backward compatibility
export type { ApprovedOrder } from "@/types/trading";

export type ExecutionResult = {
    success: boolean;
    orderId?: string;
    status: string;
    filledQty?: number;
    avgFillPx?: number;
    error?: string;
};

export class ExecutionEngine {
    private privateKey: string;
    private isTestnet: boolean;

    constructor(privateKey: string, isTestnet: boolean = true) {
        this.privateKey = privateKey;
        this.isTestnet = isTestnet;
    }

    public async placeOrder(order: ApprovedOrder, currentPrice: number, assetIndex: number): Promise<ExecutionResult> {
        try {
            // Convert sizeUsd to size in tokens
            const size = order.sizeUsd / currentPrice;

            // Determine price (Market or Limit)
            // For market buy, we usually set a high limit, for sell a low limit, or use specific "market" order types if supported.
            // Hyperliquid uses Limit orders with Gtc/Ioc/Alo.
            // For "Market" behavior, we can set a price with slippage.
            const slippage = 0.05; // 5%
            const limitPx = order.limitPx || (order.side === 'buy' ? currentPrice * (1 + slippage) : currentPrice * (1 - slippage));

            const response = await hlPlaceOrder(
                this.privateKey,
                {
                    asset: assetIndex,
                    isBuy: order.side === 'buy',
                    limitPx: limitPx,
                    sz: size,
                    reduceOnly: false
                },
                this.isTestnet
            );

            if (response.status === "ok") {
                const status = response.response.type;
                const orderId = response.response.data.statuses[0]?.oid; // Check structure

                return {
                    success: true,
                    orderId: orderId?.toString(),
                    status: "submitted", // or filled based on response
                };
            } else {
                return {
                    success: false,
                    status: "failed",
                    error: response.response || "Unknown error"
                };
            }

        } catch (error: any) {
            console.error("ExecutionEngine Error:", error);
            return {
                success: false,
                status: "error",
                error: error.message
            };
        }
    }

    public async cancelOrder(assetIndex: number, orderId: number): Promise<ExecutionResult> {
        try {
            const response = await hlCancelOrder(
                this.privateKey,
                {
                    asset: assetIndex,
                    oid: orderId
                },
                this.isTestnet
            );

            if (response.status === "ok") {
                return {
                    success: true,
                    status: "cancelled"
                };
            } else {
                return {
                    success: false,
                    status: "failed",
                    error: response.response || "Unknown error"
                };
            }
        } catch (error: any) {
            return {
                success: false,
                status: "error",
                error: error.message
            };
        }
    }
}
