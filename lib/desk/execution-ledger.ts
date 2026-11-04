import type { PrismaClient, DeskBook, DeskIntent } from "@prisma/client";
import type { DeskInstrument } from "./instruments";
import { finite, positive, positionKey, fx, type DeskAccount, type DeskVenue } from "./execution-types";
import { inventoryAfter, LIVE_ORDER_STATES } from "./execution-risk";

export function keyed(bookId: string, instrumentId: string) {
    return { bookId_instrumentId: { bookId, instrumentId } };
}
const active = (i: DeskIntent) => LIVE_ORDER_STATES.includes(i.state);
export async function syncLedger(db: PrismaClient, venue: DeskVenue, book: DeskBook, instruments: DeskInstrument[]) {
    const bookId = book.id,
        end = Date.now(),
        state = await db.deskExecutionState.findUnique({ where: { bookId } });
    const start = Math.max(
        book.createdAt.getTime(),
        (state?.lastSync?.getTime() ?? book.createdAt.getTime()) - 120_000,
    );
    const [fills, funding, orders] = await Promise.all([
        venue.fills(book, start, end),
        venue.funding(book, start, end),
        db.deskIntent.findMany({ where: { bookId } }),
    ]);
    const byOid = new Map<string, DeskIntent>(),
        byCloid = new Map<string, DeskIntent>();
    for (const o of orders) {
        if (o.oid) byOid.set(o.oid, o);
        for (const id of [o.cloid, o.stopCloid, o.targetCloid]) if (id) byCloid.set(id, o);
        if (!active(o)) continue;
        const s = await venue.status(book, o.cloid);
        if (!s) continue; // Network-ambiguous submission stays reserved until positively reconciled.
        byOid.set(s.oid, o);
        const state =
            s.status === "open" || s.status === "triggered"
                ? "working"
                : s.status === "filled"
                  ? "settling"
                  : "terminal";
        await db.deskIntent.update({
            where: { id: o.id },
            data: { oid: s.oid, state, reservedUsd: state === "terminal" ? 0 : undefined, reason: s.status },
        });
    }
    const account = await venue.account(book, instruments);
    const flows = [
        ...fills.map((fill) => ({ time: fill.time, fill, fund: undefined })),
        ...funding.map((fund) => ({ time: fund.time, fill: undefined, fund })),
    ].sort((a, b) => a.time - b.time);
    for (const { fill, fund, time } of flows) {
        const venueKey = fill
            ? `fill:${fill.coin}:${fill.tid}:${fill.oid}`
            : `fund:${fund!.delta.coin}:${time}:${fund!.hash}`;
        if (await db.deskCashFlow.findUnique({ where: { bookId_venueKey: { bookId, venueKey } } })) continue;
        const coin = fill?.coin ?? fund!.delta.coin;
        const i = instruments.find((v) => v.coin === coin);
        if (!i) continue;
        let order = fill ? byOid.get(String(fill.oid)) : undefined;
        let isChild = false;
        if (fill && !order) {
            // Fills carry oid; protective orders can execute before their acknowledgement is journaled.
            const status = await venue.status(book, fill.oid);
            if (status?.cloid) {
                order = byCloid.get(status.cloid);
                isChild = !!order && status.cloid !== order.cloid;
                if (order && !isChild) {
                    byOid.set(status.oid, order);
                    await db.deskIntent.update({ where: { id: order.id }, data: { oid: status.oid } });
                }
            }
        }
        await db.$transaction(async (tx) => {
            const where = keyed(bookId, i.id);
            const inv = await tx.deskInventory.findUnique({ where });
            if (inv && time < inv.since.getTime()) return;
            // Manual fills never enter desk P&L. Flag any collision while the desk owned inventory.
            if (fill && !order) {
                if (inv && inv.quantity !== 0)
                    await tx.deskInventory.update({
                        where,
                        data: { suspended: true, reason: "Unattributed exchange fill on managed position" },
                    });
                return;
            }
            if (fund) {
                if (
                    !inv ||
                    inv.suspended ||
                    inv.quantity === 0 ||
                    Math.abs(inv.quantity - finite(fund.delta.szi, "funding quantity")) > 1e-8
                )
                    return;
                const usd = finite(fund.delta.usdc, "funding");
                await tx.deskCashFlow.create({
                    data: {
                        bookId,
                        venueKey,
                        instrumentId: i.id,
                        kind: "funding",
                        quantity: 0,
                        price: 0,
                        feeUsd: 0,
                        pnlUsd: usd,
                        shortfallUsd: 0,
                        occurredAt: new Date(time),
                    },
                });
                await tx.deskInventory.update({ where, data: { fundingUsd: { increment: usd } } });
                return;
            }
            if (!fill || !order) return;
            const sz = positive(fill.sz, "fill size"),
                px = positive(fill.px, "fill price"),
                currency = fx(i, account);
            const baseFee = i.kind === "spot" && fill.feeToken === i.base;
            let rate = currency;
            if (baseFee) rate = px * currency;
            else if (fill.feeToken && fill.feeToken !== i.quote) {
                const token = instruments.find((s) => s.kind === "spot" && s.base === fill.feeToken)?.baseTokenIndex;
                rate = fill.feeToken === "USDC" ? 1 : positive(account.tokenUsd.get(token!), "fee currency price");
            }
            const fee = finite(fill.fee, "fill fee"),
                signed = (fill.side === "B" ? 1 : -1) * sz;
            const next = inventoryAfter(
                inv?.quantity ?? 0,
                inv?.basis ?? 0,
                signed - (baseFee ? fee : 0),
                px * currency,
            );
            let quotePnl = 0;
            if (i.kind === "spot" && i.quoteTokenIndex !== 0) {
                // Crossing into another token exchanges two inventories. Debit/credit the quote token
                // as an asset as well, including any fee the venue charged in that token.
                const treasury = instruments.find(
                    (s) => s.kind === "spot" && s.baseTokenIndex === i.quoteTokenIndex && s.quoteTokenIndex === 0,
                );
                if (!treasury) throw new Error("Cannot reconcile quote-token cost basis");
                const treasuryKey = keyed(bookId, treasury.id),
                    old = await tx.deskInventory.findUnique({ where: treasuryKey });
                const quoteDelta = -signed * px - (fill.feeToken === i.quote ? fee : 0);
                const move = inventoryAfter(old?.quantity ?? 0, old?.basis ?? 0, quoteDelta, currency);
                quotePnl = move.pnl;
                await tx.deskInventory.upsert({
                    where: treasuryKey,
                    create: {
                        bookId,
                        instrumentId: treasury.id,
                        quantity: move.quantity,
                        basis: move.basis,
                        since: new Date(time),
                        realizedUsd: move.pnl,
                    },
                    update: { quantity: move.quantity, basis: move.basis, realizedUsd: { increment: move.pnl } },
                });
            }
            await tx.deskCashFlow.create({
                data: {
                    bookId,
                    venueKey,
                    intentId: order.id,
                    instrumentId: i.id,
                    kind: isChild ? "protection" : "fill",
                    quantity: signed,
                    price: px,
                    feeUsd: fee * rate,
                    pnlUsd: next.pnl + quotePnl - fee * rate,
                    shortfallUsd: isChild ? 0 : signed * (px - order.arrivalPrice) * currency,
                    occurredAt: new Date(time),
                },
            });
            const request = JSON.parse(order.requestJson);
            const stopPrice = next.quantity === 0 ? null : (request.stopPrice ?? inv?.stopPrice ?? null);
            const targetPrice = next.quantity === 0 ? null : (request.takeProfitPrice ?? inv?.targetPrice ?? null);
            await tx.deskInventory.upsert({
                where,
                create: {
                    bookId,
                    instrumentId: i.id,
                    quantity: next.quantity,
                    basis: next.basis,
                    realizedUsd: next.pnl - fee * rate,
                    since: new Date(time),
                    stopPrice,
                    targetPrice,
                },
                update: {
                    quantity: next.quantity,
                    basis: next.basis,
                    realizedUsd: { increment: next.pnl - fee * rate },
                    stopPrice,
                    targetPrice,
                },
            });
            if (!isChild)
                await tx.deskIntent.update({ where: { id: order.id }, data: { filledQty: { increment: sz } } });
        });
    }
    await db.deskIntent.updateMany({
        where: { bookId, state: "settling", filledQty: { gte: db.deskIntent.fields.quantity } },
        data: { state: "filled", reservedUsd: 0 },
    });
    const inventory = await db.deskInventory.findMany({ where: { bookId } });
    let unrealized = 0,
        realized = 0,
        deskGrossUsd = 0;
    for (const inv of inventory) {
        realized += inv.realizedUsd + inv.fundingUsd;
        if (!inv.quantity && !inv.suspended) continue;
        const i = instruments.find((v) => v.id === inv.instrumentId);
        if (!i) throw new Error("Unresolved held instrument " + inv.instrumentId);
        const qty = account.positions.get(positionKey(i)) ?? 0;
        if (Math.abs(qty - inv.quantity) > Math.max(1e-9, Math.abs(qty) * 1e-9))
            await db.deskInventory.update({
                where: { id: inv.id },
                data: { suspended: true, reason: "Exchange inventory differs from desk ledger" },
            });
        const usdMark = positive(account.marks.get(i.id), "held instrument mark") * fx(i, account);
        deskGrossUsd += Math.abs(qty) * usdMark;
        unrealized += (usdMark - inv.basis) * inv.quantity;
    }
    const pnl = realized + unrealized,
        dayKey = new Date(end).toISOString().slice(0, 10);
    const baseline = dayKey === state?.dayKey ? state.dayStartUsd : (state?.netPnlUsd ?? 0);
    const highWater = Math.max(state?.highWaterUsd ?? 0, pnl);
    const metrics = {
        lastSync: new Date(end),
        netPnlUsd: pnl,
        unrealizedUsd: unrealized,
        dailyPnlUsd: pnl - baseline,
        dayKey,
        dayStartUsd: baseline,
        highWaterUsd: highWater,
        drawdownUsd: Math.max(state?.drawdownUsd ?? 0, highWater - pnl),
    };
    await db.deskExecutionState.upsert({ where: { bookId }, create: { bookId, ...metrics }, update: metrics });
    return { account, deskGrossUsd, metrics };
}

export function foreignOrdersOnInstrument(a: DeskAccount, i: DeskInstrument, ours: DeskIntent[]) {
    return a.openOrders.filter(
        (o) =>
            o.coin === i.coin &&
            !ours.some(
                (r) =>
                    String(o.oid) === r.oid || (!!o.cloid && [r.cloid, r.stopCloid, r.targetCloid].includes(o.cloid)),
            ),
    );
}
