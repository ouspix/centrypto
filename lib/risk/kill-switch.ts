import "server-only";

import { prisma } from "@/lib/db";
import { safeError } from "@/lib/log/safeLogger";

export async function getWalletKillSwitch(userAddress: string, isTestnet: boolean): Promise<boolean> {
    const walletRiskControl = (prisma as any).walletRiskControl;
    if (!walletRiskControl) {
        if (isProductionRuntime()) {
            throw new Error("WalletRiskControl Prisma model is unavailable; execution is blocked until Prisma is generated");
        }
        return false;
    }

    try {
        const control = await walletRiskControl.findUnique({
            where: {
                userAddress_isTestnet: {
                    userAddress: userAddress.toLowerCase(),
                    isTestnet
                }
            }
        });
        return !!control?.killSwitch;
    } catch (error) {
        safeError("Wallet kill-switch lookup failed", error);
        if (isProductionRuntime()) {
            throw new Error("Wallet kill-switch lookup failed; execution is blocked");
        }
        return false;
    }
}

export async function setWalletKillSwitch(userAddress: string, isTestnet: boolean, enabled: boolean): Promise<boolean> {
    const normalized = userAddress.toLowerCase();
    const walletRiskControl = (prisma as any).walletRiskControl;
    if (!walletRiskControl) {
        throw new Error("WalletRiskControl Prisma model is unavailable; run npm run prisma:generate");
    }
    await walletRiskControl.upsert({
        where: {
            userAddress_isTestnet: {
                userAddress: normalized,
                isTestnet
            }
        },
        update: { killSwitch: enabled },
        create: {
            userAddress: normalized,
            isTestnet,
            killSwitch: enabled
        }
    });
    return enabled;
}

function isProductionRuntime(): boolean {
    return process.env.NODE_ENV === "production";
}
