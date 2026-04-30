import "server-only";

import { signL1Action } from "@nktkas/hyperliquid/signing";
import { OrderRequest, CancelRequest, UpdateLeverageRequest, parser } from "@nktkas/hyperliquid/api/exchange";
import { privateKeyToAccount } from "viem/accounts";
import { hyperliquidExchangePost } from "@/lib/rate-limit/hyperliquid-limiter";
import { getMeta, hyperliquidInfoUrl } from "@/lib/hyperliquid-info";
import { debugLog, safeError } from "@/lib/log/safeLogger";

type Hex = `0x${string}`;

export type PlaceOrderRequest = {
    asset: number;
    isBuy: boolean;
    limitPx: number;
    sz: number;
    reduceOnly: boolean;
    tif?: "Gtc" | "Ioc" | "Alo" | "FrontendMarket" | "LiquidationMarket";
    stopLossPrice?: number;
    takeProfitPrice?: number;
    leverage?: number;
};

export function exchangeUrl(isTestnet: boolean): string {
    return hyperliquidInfoUrl(isTestnet).replace("/info", "/exchange");
}

export async function getAssetMeta(asset: number, isTestnet: boolean) {
    const universe = await getMeta(isTestnet);
    return universe[asset];
}

export function roundToTickSize(price: number, szDecimals: number): number {
    const maxDecimals = 6 - szDecimals;
    const maxSigFigs = 5;
    const factor = Math.pow(10, maxDecimals);
    let rounded = Math.round(price * factor) / factor;
    const priceStr = rounded.toString().replace(".", "").replace(/^-/, "");
    const leadingZeros = priceStr.match(/^0*/)?.[0].length || 0;
    const sigFigs = priceStr.length - leadingZeros;

    if (sigFigs > maxSigFigs) {
        const magnitude = Math.floor(Math.log10(Math.abs(rounded)));
        const scale = Math.pow(10, magnitude - maxSigFigs + 1);
        rounded = Math.round(rounded / scale) * scale;
    }

    return parseFloat(rounded.toFixed(maxDecimals));
}

export async function placeOrderWithPrivateKey(
    privateKey: string,
    order: PlaceOrderRequest,
    isTestnet = false
) {
    const nonce = Date.now();
    const assetMeta = await getAssetMeta(order.asset, isTestnet);
    if (!assetMeta) throw new Error(`Asset metadata not found for index ${order.asset}`);

    const szDecimals = assetMeta.szDecimals;
    const priceDecimals = 6 - szDecimals;
    const roundedPrice = roundToTickSize(order.limitPx, szDecimals);
    const roundedSize = parseFloat(order.sz.toFixed(szDecimals));
    const priceStr = roundedPrice.toFixed(priceDecimals);
    const sizeStr = roundedSize.toFixed(szDecimals);
    const notional = roundedPrice * roundedSize;
    const minNotionalUsd = 10;

    if (!order.reduceOnly && notional < minNotionalUsd) {
        throw new Error(`Order notional ${notional.toFixed(4)} is below venue minimum $${minNotionalUsd}.`);
    }

    const orders: any[] = [{
        a: order.asset,
        b: order.isBuy,
        p: priceStr,
        s: sizeStr,
        r: order.reduceOnly,
        t: { limit: { tif: order.tif ?? "Gtc" as const } }
    }];

    const pushTriggerOrder = (px: number, type: "tp" | "sl") => {
        const triggerPxStr = roundToTickSize(px, szDecimals).toFixed(priceDecimals);
        orders.push({
            a: order.asset,
            b: !order.isBuy,
            p: triggerPxStr,
            s: sizeStr,
            r: true,
            t: {
                trigger: {
                    isMarket: true,
                    triggerPx: triggerPxStr,
                    tpsl: type
                }
            }
        });
    };

    if (order.stopLossPrice) pushTriggerOrder(order.stopLossPrice, "sl");
    if (order.takeProfitPrice) pushTriggerOrder(order.takeProfitPrice, "tp");

    const action = parser(OrderRequest.entries.action)({
        type: "order" as const,
        orders,
        grouping: (order.stopLossPrice || order.takeProfitPrice) ? "normalTpsl" as const : "na" as const
    });
    const wallet = privateKeyToAccount(formatPrivateKey(privateKey));
    const signature = await signL1Action({ wallet, action, nonce, isTestnet });
    const payload = { action, nonce, signature };

    debugLog("Submitting Hyperliquid order", {
        asset: order.asset,
        reduceOnly: order.reduceOnly,
        orderCount: orders.length,
        wallet: wallet.address
    });

    const data = await hyperliquidExchangePost<any>(
        "hl:exchange:order",
        exchangeUrl(isTestnet),
        payload,
        { walletKey: wallet.address, retryOrders: false }
    );

    if (data.status === "err") {
        safeError("Hyperliquid order rejected", data.response);
        throw new Error(`Order rejected: ${JSON.stringify(data.response)}`);
    }

    return data;
}

export async function updateLeverageWithPrivateKey(
    privateKey: string,
    request: { asset: number; isCross: boolean; leverage: number },
    isTestnet = false
) {
    const nonce = Date.now();
    const action = parser(UpdateLeverageRequest.entries.action)({
        type: "updateLeverage" as const,
        asset: request.asset,
        isCross: request.isCross,
        leverage: Math.max(1, Math.floor(request.leverage))
    });
    const wallet = privateKeyToAccount(formatPrivateKey(privateKey));
    const signature = await signL1Action({ wallet, action, nonce, isTestnet });
    const payload = { action, nonce, signature };
    const data = await hyperliquidExchangePost<any>(
        "hl:exchange:updateLeverage",
        exchangeUrl(isTestnet),
        payload,
        { walletKey: wallet.address, retryOrders: false }
    );

    if (data.status === "err") {
        throw new Error(`Update leverage rejected: ${JSON.stringify(data.response)}`);
    }

    return data;
}

export async function cancelOrderWithPrivateKey(
    privateKey: string,
    cancelRequest: { asset: number; oid: number },
    isTestnet = false
) {
    const nonce = Date.now();
    const action = parser(CancelRequest.entries.action)({
        type: "cancel" as const,
        cancels: [{ a: cancelRequest.asset, o: cancelRequest.oid }],
        grouping: "na" as const
    });
    const wallet = privateKeyToAccount(formatPrivateKey(privateKey));
    const signature = await signL1Action({ wallet, action, nonce, isTestnet });
    const payload = { action, nonce, signature };
    return hyperliquidExchangePost<any>(
        "hl:exchange:cancel",
        exchangeUrl(isTestnet),
        payload,
        { walletKey: wallet.address, retryOrders: false }
    );
}

function formatPrivateKey(privateKey: string): Hex {
    let cleanKey = privateKey.trim();
    if ((cleanKey.startsWith('"') && cleanKey.endsWith('"')) || (cleanKey.startsWith("'") && cleanKey.endsWith("'"))) {
        cleanKey = cleanKey.slice(1, -1);
    }
    return (cleanKey.startsWith("0x") ? cleanKey : `0x${cleanKey}`) as Hex;
}
