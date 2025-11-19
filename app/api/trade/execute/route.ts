import { NextResponse } from 'next/server';
import { ethers } from 'ethers';

// Types for Hyperliquid
type OrderRequest = {
    asset: number;
    isBuy: boolean;
    limitPx: number;
    sz: number;
    reduceOnly: boolean;
    orderType: { limit: { tif: "Gtc" } } | { market: {} };
};

type Action = {
    type: "order";
    orders: OrderRequest[];
    grouping: "na";
};

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { asset, isBuy, price, size, leverage } = body;

        // 1. Auth & Risk Check
        // In a real app, verify session here.

        if (leverage > 20) {
            return NextResponse.json({ success: false, error: "Leverage exceeds 20x limit" }, { status: 400 });
        }

        // 2. Initialize API Agent Wallet
        // WARNING: NEVER expose this key. Use process.env.API_WALLET_PRIVATE_KEY
        const privateKey = process.env.API_WALLET_PRIVATE_KEY || "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const wallet = new ethers.Wallet(privateKey);

        // 3. Construct Hyperliquid Payload
        // Note: Hyperliquid uses a specific signing format (EIP-712 or similar custom packing).
        // For this demo, we'll simulate the payload construction.

        const action: Action = {
            type: "order",
            orders: [
                {
                    asset: asset, // Asset index (e.g., 0 for BTC)
                    isBuy: isBuy,
                    limitPx: price,
                    sz: size,
                    reduceOnly: false,
                    orderType: { limit: { tif: "Gtc" } } // Limit order GTC
                }
            ],
            grouping: "na"
        };

        const nonce = Date.now();
        const payload = {
            action,
            nonce,
            signature: { r: "0x...", s: "0x...", v: 27 } // Mock signature
        };

        // 4. Sign the payload (Mocked for demo)
        // In reality: const signature = await wallet.signMessage(...) or signTypedData
        console.log(`[Trade] Signing order for ${isBuy ? "Buy" : "Sell"} ${size} of Asset ${asset} at ${price}`);

        // 5. Post to Hyperliquid
        // const response = await fetch("https://api.hyperliquid.xyz/exchange", {
        //   method: "POST",
        //   headers: { "Content-Type": "application/json" },
        //   body: JSON.stringify(payload)
        // });
        // const result = await response.json();

        const mockResult = {
            status: "ok",
            response: {
                type: "order",
                data: {
                    statuses: [{ resting: { oid: 12345 } }]
                }
            }
        };

        return NextResponse.json({
            success: true,
            txHash: "0xmocktxhash...",
            orderId: 12345
        });

    } catch (error) {
        console.error('Trade Execution Error:', error);
        return NextResponse.json({ success: false, error: 'Trade Failed' }, { status: 500 });
    }
}
