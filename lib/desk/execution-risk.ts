import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import type { DeskInstrument } from "./instruments";
import type { DeskMandate } from "./mandate";
import { finite, positive, fx, positionKey, type DeskAccount, type DeskL2, type DeskOrder, type Level } from "./execution-types";

export function depthWithinBand(levels: Level[], buy: boolean, boundary: number, currency: number) {
    return levels.filter(l => buy ? +l.px <= boundary : +l.px >= boundary)
        .reduce((sum, l) => sum + positive(l.sz, "book quantity") * positive(l.px, "book price") * currency, 0);
}

export const LIVE_ORDER_STATES = ["submitting", "unknown", "working", "settling", "blocked"];
export function parseDeskOrder(value: DeskOrder): DeskOrder {
    if (
        !value ||
        (value.side !== "buy" && value.side !== "sell") ||
        typeof value.instrumentId !== "string" ||
        !value.instrumentId ||
        typeof value.thesis !== "string" ||
        !value.thesis.trim() ||
        value.thesis.length > 3000
    )
        throw new Error("Order needs an instrument, side and thesis");
    if (value.reduceOnly !== undefined && typeof value.reduceOnly !== "boolean")
        throw new Error("Invalid reduceOnly flag");
    if (value.eventId !== undefined && (typeof value.eventId !== "string" || value.eventId.length > 180))
        throw new Error("Invalid event reference");
    return {
        instrumentId: value.instrumentId,
        side: value.side,
        quantity: positive(value.quantity, "order quantity"),
        limitPrice: positive(value.limitPrice, "limit price"),
        reduceOnly: !!value.reduceOnly,
        stopPrice: value.stopPrice === undefined ? undefined : positive(value.stopPrice, "stop price"),
        takeProfitPrice:
            value.takeProfitPrice === undefined ? undefined : positive(value.takeProfitPrice, "target price"),
        thesis: value.thesis.trim(),
        eventId: value.eventId,
    };
}

export function inspectBook(depth: DeskL2, now = Date.now()) {
    if (!depth || !Number.isFinite(depth.time) || depth.time < now - 5000 || depth.time > now + 1000)
        throw new Error("Stale order book");
    const [bids, asks] = depth.levels;
    const bid = positive(bids[0]?.px, "best bid"),
        ask = positive(asks[0]?.px, "best ask");
    if (ask < bid) throw new Error("Crossed order book");
    return { bid, ask, mid: (bid + ask) / 2 };
}

export type Outstanding = {
    instrumentId: string;
    reservedUsd: number;
    cloid: string;
    oid: string | null;
    state: string;
    stopCloid: string | null;
    targetCloid: string | null;
};
export function assessDeskOrder(input: {
    order: DeskOrder;
    instrument: DeskInstrument;
    instruments: DeskInstrument[];
    account: DeskAccount;
    depth: DeskL2;
    mandate: DeskMandate;
    reserved: Outstanding[];
    owned: number;
    suspended: boolean;
    dailyPnlUsd: number;
    deskGrossUsd: number;
    quoting: boolean;
    now?: number;
}) {
    const {
        order,
        instrument: i,
        instruments,
        depth,
        account: a,
        mandate: m,
        owned,
        suspended,
        reserved,
        quoting,
    } = input;
    const { bid, ask, mid } = inspectBook(depth, input.now);
    const buy = order.side === "buy",
        currency = fx(i, a);
    if (suspended) throw new Error("Instrument ownership suspended; reconcile or hand over");
    const live = a.positions.get(positionKey(i)) ?? 0;
    if (Math.abs(live - owned) > 1e-9 * Math.max(1, Math.abs(live)))
        throw new Error("Foreign position or inventory mismatch; handover required");
    const quantity = Number(formatSize(order.quantity.toFixed(i.szDecimals + 4), i.szDecimals));
    const tick = (px: number) =>
        Number(formatPrice(Number.isInteger(px) ? String(px) : px.toFixed(16), i.szDecimals, i.kind === "perp"));
    const limitPrice = positive(tick(order.limitPrice), "rounded limit");
    positive(quantity, "rounded size");
    if (!buy && limitPrice < order.limitPrice - 1e-10 * Math.max(1, order.limitPrice))
        throw new Error("Sell limit must conform to venue tick size");
    const sign = buy ? 1 : -1;
    if (owned * sign < 0 && quantity > Math.abs(owned) + 1e-10) throw new Error("Close before reversing the position");
    const reducing = owned * sign < 0 && quantity <= Math.abs(owned) + 1e-10;
    if (order.reduceOnly && !reducing) throw new Error("Reduce-only order would increase or reverse exposure");
    if (i.kind === "spot" && !buy && quantity > (a.freeSpot.get(i.baseTokenIndex!) ?? 0) + 1e-10)
        throw new Error("Insufficient available spot inventory");
    if (quoting && ((buy && limitPrice >= ask) || (!buy && limitPrice <= bid)))
        throw new Error("Quote would cross the spread");
    const maxDistance = (mid * m.maxSlippageBps) / 10000;
    if (buy ? limitPrice > mid + maxDistance : limitPrice < mid - maxDistance)
        throw new Error("Order violates slippage limit");
    const arrivalPrice = buy ? ask : bid;
    const usd = Math.max(limitPrice, mid) * quantity * currency;
    if (usd < 10 && !(i.kind === "perp" && reducing)) throw new Error("Below minimum order notional");
    const liquidity = depthWithinBand(depth.levels[buy ? 1 : 0], buy, mid + sign * maxDistance, currency);
    let instrumentReserve = 0,
        totalReserve = 0;
    for (const r of reserved) {
        totalReserve += r.reservedUsd;
        if (r.instrumentId === i.id) instrumentReserve += r.reservedUsd;
    }
    for (const o of a.openOrders) {
        const ours = reserved.some(
            (r) => r.oid === String(o.oid) || (o.cloid && [r.cloid, r.stopCloid, r.targetCloid].includes(o.cloid)),
        );
        if (ours) continue;
        const other = instruments.find((v) => v.coin === o.coin);
        if (
            o.coin === i.coin ||
            (i.kind === "spot" && other?.kind === "spot" && other.baseTokenIndex === i.baseTokenIndex)
        )
            throw new Error("Foreign working order on this position");
        if (!o.reduceOnly) {
            if (!other) {
                if (reducing) continue;
                throw new Error("Unpriced external working order");
            }
            totalReserve +=
                positive(o.sz, "external order size") * positive(o.limitPx, "external order limit") * fx(other, a);
        }
    }
    const stop = order.stopPrice === undefined ? undefined : positive(tick(order.stopPrice), "rounded stop");
    const target =
        order.takeProfitPrice === undefined ? undefined : positive(tick(order.takeProfitPrice), "rounded target");
    if (reducing && (stop || target)) throw new Error("Closing orders cannot attach a new bracket");
    if (stop && (buy ? stop >= Math.min(limitPrice, bid) : stop <= Math.max(limitPrice, ask)))
        throw new Error("Stop is on the wrong side");
    if (target && (buy ? target <= Math.max(limitPrice, ask) : target >= Math.min(limitPrice, bid)))
        throw new Error("Target is on the wrong side");
    if (!reducing) {
        if (a.riskWarnings?.length) throw new Error(a.riskWarnings.join("; "));
        if (Math.min(a.rollingPnl, input.dailyPnlUsd) <= -m.maxDailyLossUsd)
            throw new Error("Daily loss limit reached");
        if (usd > m.maxOrderUsd || liquidity < Math.max(m.minDepthUsd, usd))
            throw new Error("Order cap or executable depth exceeded");
        if (
            totalReserve + Math.max(a.grossUsd, input.deskGrossUsd) + usd >
            Math.min(m.capitalUsd, a.equity) * m.maxGrossLeverage
        )
            throw new Error("Gross capital/leverage budget exceeded");
        if (instrumentReserve + Math.abs(live) * mid * currency + usd > m.maxInstrumentUsd)
            throw new Error("Instrument concentration limit exceeded");
        if (i.kind === "spot" && buy && quantity * limitPrice > (a.freeSpot.get(i.quoteTokenIndex!) ?? 0))
            throw new Error("Insufficient quote currency available");
        if (!stop && !quoting && i.kind === "perp") throw new Error("A perpetual entry requires an exchange stop");
        const loss = stop && i.kind === "perp" ? Math.abs(limitPrice - stop) * quantity * currency : usd;
        const priorRisk =
            stop && i.kind === "perp"
                ? Math.abs(mid - stop) * Math.abs(owned) * currency
                : Math.abs(owned) * mid * currency;
        if (loss + priorRisk > m.maxRiskPerTradeUsd) throw new Error("Trade risk budget exceeded");
    }
    return {
        quantity,
        limitPrice,
        stopPrice: stop,
        targetPrice: target,
        arrivalPrice,
        currency,
        notionalUsd: usd,
        reservedUsd: reducing ? 0 : usd,
        reducing,
        depthTime: depth.time,
    };
}

// A single signed cash-flow updates average cost on additions and realizes P&L on closes.
export function inventoryAfter(quantity: number, basis: number, delta: number, price: number) {
    const next = quantity + delta,
        opposing = quantity * delta < 0;
    const pnl = opposing ? Math.min(Math.abs(quantity), Math.abs(delta)) * (price - basis) * Math.sign(quantity) : 0;
    const nextBasis =
        Math.abs(next) < 1e-12
            ? 0
            : !opposing
              ? (Math.abs(quantity) * basis + Math.abs(delta) * price) / Math.abs(next)
              : next * quantity < 0
                ? price
                : basis;
    return { quantity: Math.abs(next) < 1e-12 ? 0 : next, basis: finite(nextBasis, "inventory basis"), pnl };
}
