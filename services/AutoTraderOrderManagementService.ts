import "server-only";

import { prisma } from "@/lib/db";
import { cancelOrdersWithPrivateKey } from "@/lib/hyperliquid-execution";
import { getFrontendOpenOrders, getMeta, getOpenOrders as fetchExchangeOpenOrders } from "@/lib/hyperliquid-info";
import type { ManagedOpenOrder } from "@/lib/trader/position-management-types";
import type { AutoTraderNetwork, AutoTraderOrderStatus } from "@/types/auto-trader-review";

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
        const dbAttempts = await this.getOpenOrderAttempts(input);
        const exchangeOrders = await this.getExchangeOpenOrders(input, dbAttempts);
        if (exchangeOrders !== null) return exchangeOrders;
        return dbAttempts.map(attemptToManagedOpenOrder);
    }

    public async cancelOrders(input: {
        accountAddress: string;
        network: AutoTraderNetwork;
        privateKey: string;
        orders: Array<{ asset: number; oid: string | number }>;
        status?: AutoTraderOrderStatus;
        reason?: string;
    }): Promise<void> {
        const cancels = input.orders
            .map(order => ({ asset: order.asset, oid: Number(order.oid) }))
            .filter(order => Number.isFinite(order.asset) && Number.isFinite(order.oid));
        if (!cancels.length) return;

        await cancelOrdersWithPrivateKey(input.privateKey, { cancels }, input.network === "testnet");
        await this.markAttemptsByOids({
            accountAddress: input.accountAddress,
            network: input.network,
            oids: cancels.map(cancel => String(cancel.oid)),
            status: input.status ?? "CANCELED",
            reason: input.reason ?? "canceled by order management"
        });
    }

    public async cancelOcoSiblingOrders(input: {
        accountAddress: string;
        network: AutoTraderNetwork;
        privateKey: string;
        assetIndexBySymbol?: Map<string, number>;
    }): Promise<number> {
        const model = this.model("autoTraderOrderAttempt", false);
        if (!model?.findMany) return 0;

        const filledTriggers = await model.findMany({
            where: {
                orderRole: { in: ["STOP_LOSS", "TAKE_PROFIT"] },
                status: { in: ["FILLED", "FILLED_FROM_SYNC"] },
                decision: {
                    run: {
                        accountAddress: input.accountAddress.toLowerCase(),
                        network: input.network
                    }
                }
            },
            orderBy: { updatedAt: "desc" },
            take: 50
        });
        if (!filledTriggers.length) return 0;

        const openOrders = await this.getOpenOrders({ accountAddress: input.accountAddress, network: input.network });
        const liveOids = new Set(openOrders.map(order => order.oid).filter((oid): oid is string => !!oid));
        const assetIndexes = input.assetIndexBySymbol ?? await this.assetIndexBySymbol(input.network);
        let canceled = 0;

        for (const filled of filledTriggers) {
            const siblingRole = filled.orderRole === "TAKE_PROFIT" ? "STOP_LOSS" : "TAKE_PROFIT";
            const siblings = await model.findMany({
                where: {
                    decisionId: filled.decisionId,
                    orderRole: siblingRole,
                    status: { in: ["RESTING", "SUBMITTED"] }
                }
            });
            for (const sibling of siblings) {
                const oid = sibling.oid ? String(sibling.oid) : null;
                if (!oid || !liveOids.has(oid)) {
                    await model.update({
                        where: { id: sibling.id },
                        data: { status: "NOT_FOUND_ON_EXCHANGE", statusReason: "OCO sibling not present in exchange open orders" }
                    });
                    continue;
                }
                const asset = assetIndexes.get(sibling.symbol);
                if (asset === undefined) continue;
                await this.cancelOrders({
                    accountAddress: input.accountAddress,
                    network: input.network,
                    privateKey: input.privateKey,
                    orders: [{ asset, oid }],
                    status: "CANCELED_FROM_OCO",
                    reason: `${filled.orderRole} filled; canceled sibling ${siblingRole}`
                });
                canceled++;
            }
        }

        return canceled;
    }

    private async getOpenOrderAttempts(input: {
        accountAddress: string;
        network: AutoTraderNetwork;
    }): Promise<any[]> {
        const model = this.model("autoTraderOrderAttempt", false);
        if (!model?.findMany) return [];

        return model.findMany({
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
    }

    private async getExchangeOpenOrders(input: {
        accountAddress: string;
        network: AutoTraderNetwork;
    }, attempts: any[]): Promise<ManagedOpenOrder[] | null> {
        const isTestnet = input.network === "testnet";
        const frontendOrders = await getFrontendOpenOrders(input.accountAddress, isTestnet);
        const rawOrders = frontendOrders ?? await fetchExchangeOpenOrders(input.accountAddress, isTestnet);
        if (!Array.isArray(rawOrders)) return null;
        await this.markMissingDbAttemptsNotLive(input, attempts, rawOrders);

        const attemptsByOid = new Map<string, any>();
        const attemptsByCloid = new Map<string, any>();
        for (const attempt of attempts) {
            if (attempt.oid) attemptsByOid.set(String(attempt.oid), attempt);
            if (attempt.cloid) attemptsByCloid.set(String(attempt.cloid).toLowerCase(), attempt);
        }

        return rawOrders.map((order: any) => {
            const oid = order.oid === undefined || order.oid === null ? null : String(order.oid);
            const cloid = order.cloid === undefined || order.cloid === null ? null : String(order.cloid);
            const attempt = (oid ? attemptsByOid.get(oid) : null) ?? (cloid ? attemptsByCloid.get(cloid.toLowerCase()) : null);
            const side = normalizeOrderSide(order.side);
            const reduceOnly = Boolean(order.reduceOnly ?? order.reduce_only ?? order.isReduceOnly ?? attempt?.reduceOnly);
            const triggerPx = finite(order.triggerPx) ?? finite(order.trigger_px) ?? finite(order.trigger?.px);
            const orderType = String(order.orderType ?? order.order_type ?? order.type ?? "").toLowerCase();
            const role = attempt ? orderRole(attempt.orderRole) : inferExchangeOrderRole(orderType, triggerPx, reduceOnly);

            return {
                symbol: normalizeExchangeSymbol(order.coin ?? order.symbol ?? attempt?.symbol),
                side,
                positionSide: normalizePositionSide(order.positionSide ?? order.position_side) ?? inferPositionSideFromOrder(side, reduceOnly) ?? normalizePositionSide(attempt?.positionSide),
                orderRole: role,
                oid,
                cloid,
                reduceOnly,
                px: finite(order.limitPx) ?? finite(order.limit_px) ?? finite(order.px) ?? finite(attempt?.intendedLimitPx),
                triggerPx: triggerPx ?? finite(attempt?.intendedStopLossPx) ?? finite(attempt?.intendedTakeProfitPx),
                sizeCoin: finite(order.sz) ?? finite(order.size) ?? finite(order.origSz) ?? finite(attempt?.intendedSizeCoin),
                sizeUsd: finite(attempt?.intendedSizeUsd),
                status: "OPEN",
                createdAt: timestampDate(order.timestamp) ?? attempt?.createdAt ?? null,
                updatedAt: attempt?.updatedAt ?? null
            };
        });
    }

    private model(name: string, throwIfMissing = true): PrismaAny {
        const model = (prisma as any)[name];
        if (!model && throwIfMissing) throw new Error(`${name} Prisma model is unavailable; run npm run prisma:generate`);
        return model;
    }

    private async markMissingDbAttemptsNotLive(input: {
        accountAddress: string;
        network: AutoTraderNetwork;
    }, attempts: any[], rawOrders: any[]): Promise<void> {
        const model = this.model("autoTraderOrderAttempt", false);
        if (!model?.updateMany) return;
        const liveOids = new Set(rawOrders.map(order => order?.oid).filter(value => value !== undefined && value !== null).map(String));
        const liveCloids = new Set(rawOrders.map(order => order?.cloid).filter(value => value !== undefined && value !== null).map((value: unknown) => String(value).toLowerCase()));
        const now = Date.now();
        const staleAttemptIds = attempts
            .filter(attempt => {
                const oid = attempt.oid ? String(attempt.oid) : null;
                const cloid = attempt.cloid ? String(attempt.cloid).toLowerCase() : null;
                const updatedAt = attempt.updatedAt ? new Date(attempt.updatedAt).getTime() : 0;
                if (Number.isFinite(updatedAt) && now - updatedAt < 5_000) return false;
                return (!oid || !liveOids.has(oid)) && (!cloid || !liveCloids.has(cloid));
            })
            .map(attempt => attempt.id);
        if (!staleAttemptIds.length) return;
        await model.updateMany({
            where: {
                id: { in: staleAttemptIds },
                decision: {
                    run: {
                        accountAddress: input.accountAddress.toLowerCase(),
                        network: input.network
                    }
                }
            },
            data: {
                status: "NOT_FOUND_ON_EXCHANGE",
                statusReason: "not present in exchange open orders"
            }
        });
    }

    private async markAttemptsByOids(input: {
        accountAddress: string;
        network: AutoTraderNetwork;
        oids: string[];
        status: AutoTraderOrderStatus;
        reason: string;
    }): Promise<void> {
        const model = this.model("autoTraderOrderAttempt", false);
        if (!model?.updateMany || input.oids.length === 0) return;
        await model.updateMany({
            where: {
                oid: { in: input.oids },
                decision: {
                    run: {
                        accountAddress: input.accountAddress.toLowerCase(),
                        network: input.network
                    }
                }
            },
            data: {
                status: input.status,
                statusReason: input.reason,
                exchangeReceivedAt: new Date()
            }
        });
    }

    private async assetIndexBySymbol(network: AutoTraderNetwork): Promise<Map<string, number>> {
        const meta = await getMeta(network === "testnet");
        return new Map(meta.map((asset, index) => [normalizeExchangeSymbol(asset.name), index]));
    }
}

function attemptToManagedOpenOrder(attempt: any): ManagedOpenOrder {
    return {
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
    };
}

function orderRole(value: unknown): ManagedOpenOrder["orderRole"] {
    if (value === "ENTRY" || value === "CLOSE" || value === "REDUCE" || value === "STOP_LOSS" || value === "TAKE_PROFIT") return value;
    return "UNKNOWN";
}

function inferExchangeOrderRole(orderType: string, triggerPx: number | null, reduceOnly: boolean): ManagedOpenOrder["orderRole"] {
    if (orderType.includes("take") || orderType.includes("tp")) return "TAKE_PROFIT";
    if (orderType.includes("stop") || orderType.includes("sl")) return "STOP_LOSS";
    if (triggerPx !== null && reduceOnly) return "UNKNOWN";
    if (reduceOnly) return "CLOSE";
    return "UNKNOWN";
}

function normalizeOrderSide(value: unknown): "buy" | "sell" {
    const raw = String(value ?? "").toLowerCase();
    return raw === "b" || raw === "buy" ? "buy" : "sell";
}

function normalizePositionSide(value: unknown): ManagedOpenOrder["positionSide"] {
    return value === "long" || value === "short" ? value : null;
}

function inferPositionSideFromOrder(side: "buy" | "sell", reduceOnly: boolean): ManagedOpenOrder["positionSide"] {
    if (!reduceOnly) return null;
    return side === "sell" ? "long" : "short";
}

function normalizeExchangeSymbol(value: unknown): string {
    const raw = String(value ?? "");
    if (!raw) return "UNKNOWN";
    return raw.endsWith("-PERP") ? raw : `${raw}-PERP`;
}

function timestampDate(value: unknown): Date | null {
    const number = finite(value);
    if (number === null) return null;
    const date = new Date(number);
    return Number.isFinite(date.getTime()) ? date : null;
}

function finite(value: unknown): number | null {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
}
