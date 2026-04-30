import "server-only";

import { prisma } from "@/lib/db";

export async function getWalletKillSwitch(userAddress: string, isTestnet: boolean): Promise<boolean> {
    const walletRiskControl = (prisma as any).walletRiskControl;
    if (!walletRiskControl) return false;
    const control = await walletRiskControl.findUnique({
        where: {
            userAddress_isTestnet: {
                userAddress: userAddress.toLowerCase(),
                isTestnet
            }
        }
    });
    return !!control?.killSwitch;
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
