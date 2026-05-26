import "server-only";

import { prisma } from "@/lib/db";
import type { ManagedOpenOrder } from "@/lib/trader/position-management-types";
import type { AutoTraderNetwork } from "@/types/auto-trader-review";

type PrismaAny = any;

export class AutoTraderOrderManagementService {
    private static instance: AutoTraderOrderManagementService;

    public static getInstance(): AutoTraderOrderManagementService {
        if (!AutoTraderOrderManagementService.instance) {
            AutoTraderOrderManagementService.instance = new AutoTraderOrderManagementService();
        }
        return AutoTraderOrderManagementService.instance;
    }

    public async getOpenOrders(input: {
        accountAddress: string;
        network: AutoTraderNetwork;
    }): Promise<ManagedOpenOrder[]> {
        const model = this.model("autoTraderOrderAttempt", false);
        if (!model?.findMany) return [];

        const attempts = await model.findMany({
            where: {
                status: { in: ["RESTING", "SUBMITTED"] },
                decision: {
                    run: {
                        accountAddress: input.accountAddress.toLowerCase(),
                        network: input.network
                    }
                }
            },
            orderBy: [{ updatedAt: "desc" }],
            take: 200
        });

        return attempts.map((attempt: any) => ({
            symbol: attempt.symbol,
            side: attempt.orderSide === "buy" ? "buy" : "sell",
            positionSide: attempt.positionSide === "long" || attempt.positionSide === "short" ? attempt.positionSide : null,
            orderRole: orderRole(attempt.orderRole),
            oid: attempt.oid ?? null,
            cloid: attempt.cloid ?? null,
            reduceOnly: !!attempt.reduceOnly,
            px: finite(attempt.intendedLimitPx),
            triggerPx: finite(attempt.intendedStopLossPx) ?? finite(attempt.intendedTakeProfitPx),
            sizeCoin: finite(attempt.intendedSizeCoin),
            sizeUsd: finite(attempt.intendedSizeUsd),
            status: attempt.status === "RESTING" ? "RESTING" : attempt.status === "SUBMITTED" ? "SUBMITTED" : "UNKNOWN",
            createdAt: attempt.createdAt ?? null,
            updatedAt: attempt.updatedAt ?? null
        }));
    }

    private model(name: string, throwIfMissing = true): PrismaAny {
        const model = (prisma as any)[name];
        if (!model && throwIfMissing) throw new Error(`${name} Prisma model is unavailable; run npm run prisma:generate`);
        return model;
    }
}

function orderRole(value: unknown): ManagedOpenOrder["orderRole"] {
    if (value === "ENTRY" || value === "CLOSE" || value === "REDUCE" || value === "STOP_LOSS" || value === "TAKE_PROFIT") return value;
    return "UNKNOWN";
}

function finite(value: unknown): number | null {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
}
