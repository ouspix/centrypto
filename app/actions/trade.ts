"use server";

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { getActiveAssetLeverage } from "@/lib/hyperliquid-info";
import { linkLeverageOrderIds, recordOrderLeverage } from "@/lib/order-leverage";
import { withManualExecution } from "@/lib/desk/execution-lease";
import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { requireWalletSessionFromCookies, WalletSessionError } from "@/lib/auth/wallet-session";
import {
    getUserHyperliquidApiWalletCredential,
    HyperliquidApiWalletError,
    markHyperliquidApiWalletUsed
} from "@/lib/hyperliquid-api-wallet";
import {
    cancelOrderWithPrivateKey,
    executionWalletAddress,
    getAssetMeta,
    placeOrderWithPrivateKey,
    updateLeverageWithPrivateKey,
    type PlaceOrderRequest
} from "@/lib/hyperliquid-execution";
import { safeError } from "@/lib/log/safeLogger";
import { assertWalletExecutionAllowed } from "@/lib/risk/execution-safety";

export type { PlaceOrderRequest } from "@/lib/hyperliquid-execution";

type ActionResult = { success: true; data: any } | { success: false; error: string };

const orderCloid = (): `0x${string}` => `0x${randomBytes(16).toString("hex")}`;

export async function placeOrderAction(
    order: PlaceOrderRequest,
    isTestnet: boolean
): Promise<ActionResult> {
    try {
        const session = requireWalletSessionFromCookies();
        const controlled = await withManualExecution(prisma, session.address, isTestnet, !!order.reduceOnly, async (check) => {
            if (!order.reduceOnly) await assertWalletExecutionAllowed(session.address, isTestnet);
            const asset = await getAssetMeta(order.asset, isTestnet);
            if (!asset) throw new Error(`Asset metadata not found for index ${order.asset}`);
            validateLeverage(order, asset.maxLeverage);

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

            const account = credential.mode === "server_dev_testnet_bot"
                ? executionWalletAddress(credential.privateKey)
                : session.address;
            const cloids = {
                entry: order.cloids?.entry ?? orderCloid(),
                stopLoss: order.stopLossPrice ? order.cloids?.stopLoss ?? orderCloid() : undefined,
                takeProfit: order.takeProfitPrice ? order.cloids?.takeProfit ?? orderCloid() : undefined,
            };
            const orderIds = [cloids.entry, cloids.stopLoss, cloids.takeProfit].filter(id => id !== undefined);
            const leverage = await getActiveAssetLeverage(account.toLowerCase(), asset.name, isTestnet);
            const recorded = await recordOrderLeverage(prisma, account, isTestnet, asset.name, orderIds, leverage);
            await check();
            const result = await placeOrderWithPrivateKey(credential.privateKey, { ...order, cloids }, isTestnet);
            if (recorded) await linkLeverageOrderIds(prisma, account, isTestnet, orderIds, result);
            if (credential.mode === "user_api_wallet") {
                await markHyperliquidApiWalletUsed(session.address, isTestnet);
            }
            return { ...result, executionMode: credential.mode };
        });
        return { success: true, data: { ...controlled.value, deskPaused: controlled.deskPaused } };
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
        const controlled = await withManualExecution(prisma, session.address, isTestnet, true, async (check) => {

        const credential = await resolveExecutionCredential(session.address, isTestnet);

        await check();
        const result = await cancelOrderWithPrivateKey(credential.privateKey, cancelRequest, isTestnet);
        if (credential.mode === "user_api_wallet") {
            await markHyperliquidApiWalletUsed(session.address, isTestnet);
        }
        return { ...result, executionMode: credential.mode };
        });
        return { success: true, data: { ...controlled.value, deskPaused: controlled.deskPaused } };
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

function validateLeverage(order: PlaceOrderRequest, venueMax: number): void {
    if (!order.leverage) return;
    const leverage = Math.floor(order.leverage);
    if (!Number.isFinite(leverage) || leverage < 1) {
        throw new Error("Leverage must be at least 1x");
    }

    const appMax = DEFAULT_AGENT_CONFIG.risk.exchange_max_leverage_allowed;
    const maxAllowed = Math.min(venueMax, appMax);
    if (leverage > maxAllowed) {
        throw new Error(`Leverage ${leverage}x exceeds max ${maxAllowed}x for this asset and risk config`);
    }
}
