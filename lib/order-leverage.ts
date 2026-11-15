import "server-only";
import type { PrismaClient } from "@prisma/client";
import type { AssetLeverage } from "@/lib/hyperliquid-info";
import { safeWarn } from "@/lib/log/safeLogger";

export async function recordOrderLeverage(
    db: PrismaClient,
    accountAddress: string,
    isTestnet: boolean,
    coin: string,
    cloids: readonly string[],
    leverage: AssetLeverage | null,
): Promise<boolean> {
    if (!leverage || !cloids.length) return false;
    try {
        const observedAt = new Date();
        await db.orderLeverageSnapshot.createMany({
            data: cloids.map(cloid => ({
                accountAddress: accountAddress.toLowerCase(),
                isTestnet,
                coin,
                cloid: cloid.toLowerCase(),
                leverage: leverage.value,
                marginMode: leverage.type,
                observedAt,
            })),
        });
        return true;
    } catch (error) {
        safeWarn("Could not record order leverage", error);
        return false;
    }
}

export async function linkLeverageOrderIds(
    db: PrismaClient,
    accountAddress: string,
    isTestnet: boolean,
    cloids: readonly string[],
    acknowledgement: unknown,
): Promise<void> {
    const result = acknowledgement as { response?: { data?: { statuses?: unknown[] } } };
    const statuses = result?.response?.data?.statuses;
    if (!Array.isArray(statuses)) return;
    try {
        await Promise.all(cloids.map((cloid, index) => {
            const status = statuses[index] as { filled?: { oid?: number }; resting?: { oid?: number } } | undefined;
            const oid = status?.filled?.oid ?? status?.resting?.oid;
            if (!Number.isSafeInteger(oid)) return;
            return db.orderLeverageSnapshot.updateMany({
                where: { accountAddress: accountAddress.toLowerCase(), isTestnet, cloid: cloid.toLowerCase() },
                data: { oid: String(oid) },
            });
        }));
    } catch (error) {
        safeWarn("Could not link order leverage to exchange order IDs", error);
    }
}
