"use server";

import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { requireWalletSessionFromCookies, WalletSessionError } from "@/lib/auth/wallet-session";
import {
    getUserHyperliquidApiWalletCredential,
    HyperliquidApiWalletError,
    markHyperliquidApiWalletUsed
} from "@/lib/hyperliquid-api-wallet";
import {
    cancelOrderWithPrivateKey,
    getAssetMeta,
    placeOrderWithPrivateKey,
    updateLeverageWithPrivateKey,
    type PlaceOrderRequest
} from "@/lib/hyperliquid-execution";
import { safeError } from "@/lib/log/safeLogger";
import { assertWalletExecutionAllowed } from "@/lib/risk/execution-safety";

export type { PlaceOrderRequest } from "@/lib/hyperliquid-execution";

type ActionResult = { success: true; data: any } | { success: false; error: string };

export async function placeOrderAction(
    order: PlaceOrderRequest,
    isTestnet: boolean
): Promise<ActionResult> {
    try {
        const session = requireWalletSessionFromCookies();
        await assertWalletExecutionAllowed(session.address, isTestnet);
        await validateLeverage(order, isTestnet);

        const credential = await resolveExecutionCredential(session.address, isTestnet);

        if (!order.reduceOnly && order.leverage) {
            await updateLeverageWithPrivateKey(
                credential.privateKey,
                {
                    asset: order.asset,
                    isCross: DEFAULT_AGENT_CONFIG.risk.margin_mode !== "isolated",
                    leverage: order.leverage
                },
                isTestnet
            );
        }

        const result = await placeOrderWithPrivateKey(credential.privateKey, order, isTestnet);
        if (credential.mode === "user_api_wallet") {
            await markHyperliquidApiWalletUsed(session.address, isTestnet);
        }
        return { success: true, data: { ...result, executionMode: credential.mode } };
    } catch (error) {
        safeError("Wallet-bound placeOrderAction failed", error);
        return { success: false, error: error instanceof Error ? error.message : "Failed to place order" };
    }
}

export async function cancelOrderAction(
    cancelRequest: { asset: number; oid: number },
    isTestnet: boolean
): Promise<ActionResult> {
    try {
        const session = requireWalletSessionFromCookies();
        await assertWalletExecutionAllowed(session.address, isTestnet);

        const credential = await resolveExecutionCredential(session.address, isTestnet);

        const result = await cancelOrderWithPrivateKey(credential.privateKey, cancelRequest, isTestnet);
        if (credential.mode === "user_api_wallet") {
            await markHyperliquidApiWalletUsed(session.address, isTestnet);
        }
        return { success: true, data: { ...result, executionMode: credential.mode } };
    } catch (error) {
        safeError("Wallet-bound cancelOrderAction failed", error);
        return { success: false, error: error instanceof WalletSessionError ? error.message : error instanceof Error ? error.message : "Failed to cancel order" };
    }
}

async function resolveExecutionCredential(userAddress: string, isTestnet: boolean): Promise<{
    privateKey: `0x${string}`;
    mode: "user_api_wallet" | "server_dev_testnet_bot";
}> {
    try {
        const credential = await getUserHyperliquidApiWalletCredential(userAddress, isTestnet);
        return { privateKey: credential.privateKey, mode: "user_api_wallet" };
    } catch (error) {
        if (!(error instanceof HyperliquidApiWalletError) || error.status !== 412) {
            throw error;
        }

        const devKey = getDevTestnetExecutionKey(isTestnet);
        if (devKey) {
            return { privateKey: devKey as `0x${string}`, mode: "server_dev_testnet_bot" };
        }

        throw error;
    }
}

function getDevTestnetExecutionKey(isTestnet: boolean): string | null {
    if (process.env.NODE_ENV === "production") return null;
    if (!isTestnet) return null;
    if (process.env.ALLOW_SERVER_DEV_BOT_EXECUTION !== "true") return null;
    return process.env.HYPERLIQUID_TESTNET_PRIVATE_KEY ?? null;
}

async function validateLeverage(order: PlaceOrderRequest, isTestnet: boolean): Promise<void> {
    if (!order.leverage) return;
    const leverage = Math.floor(order.leverage);
    if (!Number.isFinite(leverage) || leverage < 1) {
        throw new Error("Leverage must be at least 1x");
    }

    const assetMeta = await getAssetMeta(order.asset, isTestnet);
    if (!assetMeta) throw new Error(`Asset metadata not found for index ${order.asset}`);

    const appMax = DEFAULT_AGENT_CONFIG.risk.exchange_max_leverage_allowed;
    const maxAllowed = Math.min(assetMeta.maxLeverage, appMax);
    if (leverage > maxAllowed) {
        throw new Error(`Leverage ${leverage}x exceeds max ${maxAllowed}x for this asset and risk config`);
    }
}
