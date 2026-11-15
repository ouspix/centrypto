import type { PrismaClient, DeskBook, DeskIntent } from "@prisma/client";
import type { DeskInstrument } from "./instruments";
import { finite, positive, positionKey, fx, type DeskAccount, type DeskVenue, type VenueStatus } from "./execution-types";
import { inventoryAfter, LIVE_ORDER_STATES } from "./execution-risk";
import { reconcileAbsentSubmission } from "./absent-submission";

export function keyed(bookId: string, instrumentId: string) {
    return { bookId_instrumentId: { bookId, instrumentId } };
}
const active = (i: DeskIntent) => LIVE_ORDER_STATES.includes(i.state);
const terminalStatus=(status:string)=>status==="filled"||status==="canceled"||status==="rejected"||status==="scheduledCancel"||/^(?:margin|vaultWithdrawal|openInterestCap|selfTrade|reduceOnly|siblingFilled|delisted|liquidated)Canceled$/.test(status)||/^(?:tick|minTradeNtl|perpMargin|reduceOnly|badAloPx|iocCancel|badTriggerPx|marketOrderNoLiquidity|positionIncreaseAtOpenInterestCap|positionFlipAtOpenInterestCap|tooAggressiveAtOpenInterestCap|openInterestIncrease|insufficientSpotBalance|oracle|perpMaxPosition)Rejected$/.test(status);
/** A terminal IOC may report filled with a nonzero canceled remainder. */
function terminalFilledQuantity(order:DeskIntent,status:NonNullable<VenueStatus>,through:number){
    if(!terminalStatus(status.status)||status.statusTimestamp!==undefined&&status.statusTimestamp>through)return null;
    if(status.cloid&&status.cloid!==order.cloid||status.coin&&status.coin!==order.coin||status.side&&status.side!==(order.side==="buy"?"B":"A"))return null;
    const original=status.originalQuantity,remaining=status.remainingQuantity;
    if(original===undefined||remaining===undefined)return status.status==="filled"?order.quantity:null;
    if(!Number.isFinite(original)||!Number.isFinite(remaining)||original<=0||remaining<0||remaining>original||Math.abs(original-order.quantity)>Math.max(1e-9,order.quantity*1e-9))return null;
    return original-remaining;
}
export async function syncLedger(db: PrismaClient, venue: DeskVenue, book: DeskBook, instruments: DeskInstrument[]) {
    const bookId = book.id,
        end = Date.now(),
        state = await db.deskExecutionState.findUnique({ where: { bookId } });
    const start = Math.max(
        book.createdAt.getTime(),
        (state?.lastSync?.getTime() ?? book.createdAt.getTime()) - 120_000,
    );
    let [fills, funding, orders] = await Promise.all([
        venue.fills(book, start, end),
        venue.funding(book, start, end),
        db.deskIntent.findMany({ where: { bookId } }),
    ]);
    const statuses = new Map<string,NonNullable<VenueStatus>>();
    const byOid = new Map<string, DeskIntent>(),
        byCloid = new Map<string, DeskIntent>();
    for (const o of orders) {
        if (o.oid) byOid.set(o.oid, o);
        for (const id of [o.cloid, o.stopCloid, o.targetCloid]) if (id) byCloid.set(id, o);
        if (!active(o)) continue;
        const s = await venue.status(book, o.cloid);
        if (!s) continue; // Network-ambiguous submission stays reserved until positively reconciled.
        if(s.cloid&&s.cloid!==o.cloid||o.oid&&s.oid!==o.oid)continue;
        statuses.set(o.id,s);
        byOid.set(s.oid, o);
        const state =
            s.status === "open" || s.status === "triggered"
                ? "working"
                : terminalStatus(s.status) ? "settling" : "unknown";
        await db.deskIntent.update({
            where: { id: o.id },
            data: { oid: s.oid, state, reason: s.status },
        });
    }
    // Recover delayed fills outside the rolling window only when an exact terminal
    // receipt proves the journal is missing executions. Never infer fills from status.
    const recoveryStarts=orders.flatMap(o=>{const s=statuses.get(o.id),expected=s?terminalFilledQuantity(o,s,end):null;
        return expected!==null&&expected>o.filledQty+1e-9&&o.createdAt.getTime()<start?[Math.max(book.createdAt.getTime(),o.createdAt.getTime()-1000)]:[];});
    if(recoveryStarts.length)fills=[...fills,...await venue.fills(book,Math.min(...recoveryStarts),end)];
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
            if(!inv?.quantity && next.quantity && request.strategyVersion && request.maxHoldHours){
                const key=`position-plan:${i.id}`;
                const dataJson=JSON.stringify({instrumentId:i.id,strategyVersion:request.strategyVersion,proposalKey:request.proposalKey,openedAt:new Date(time).toISOString(),maxHoldUntil:new Date(time+request.maxHoldHours*3600000).toISOString(),intentId:order.id});
                await tx.deskRecord.upsert({where:{bookId_key:{bookId,key}},create:{bookId,key,kind:"position_plan",role:"host",dataJson},update:{dataJson,createdAt:new Date(time)}});
            }
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
                    ...(!inv?.quantity && next.quantity ? {since:new Date(time)} : {}),
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
    for(const old of orders){
        const status=statuses.get(old.id),expected=status?terminalFilledQuantity(old,status,end):null;
        if(expected===null||!status||account.openOrders.some(o=>String(o.oid)===status.oid||o.cloid===old.cloid))continue;
        const current=await db.deskIntent.findUniqueOrThrow({where:{id:old.id}}),instrument=instruments.find(i=>i.id===old.instrumentId);
        if(!instrument||Math.abs(current.filledQty-expected)>Math.max(1e-9,old.quantity*1e-9))continue;
        const inventory=await db.deskInventory.findUnique({where:keyed(bookId,old.instrumentId)}),live=account.positions.get(positionKey(instrument))??0;
        if(Math.abs((inventory?.quantity??0)-live)>Math.max(1e-9,Math.abs(live)*1e-9))continue;
        // A delayed close can be journaled after an earlier account/ledger mismatch.
        // Only repair that specific suspension with a terminal, fully journaled
        // reduce-only close, exact flat agreement and no remaining venue orders.
        const repairFlat = inventory?.suspended && inventory.reason === "Exchange inventory differs from desk ledger" &&
            inventory.quantity === 0 && live === 0 && expected > 0 && JSON.parse(old.requestJson).reduceOnly === true &&
            !account.openOrders.some(o => o.coin === instrument.coin) &&
            !orders.some(o => o.id !== old.id && o.instrumentId === old.instrumentId && active(o));
        if(inventory?.suspended && !repairFlat)continue;
        await db.$transaction(async tx=>{
            if (repairFlat && inventory) {
                const flows = await tx.deskCashFlow.findMany({ where: { bookId, instrumentId: old.instrumentId,
                    occurredAt: { gte: inventory.since }, kind: { in: ["fill", "protection"] } } });
                const closeQty = flows.filter(f => f.intentId === old.id && f.kind === "fill").reduce((n, f) => n + Math.abs(f.quantity), 0);
                if (Math.abs(closeQty - expected) > 1e-9 || Math.abs(flows.reduce((n, f) => n + f.quantity, 0)) > 1e-9) return;
                const cleared = await tx.deskInventory.updateMany({ where: { id: inventory.id, quantity: 0,
                    suspended: true, reason: inventory.reason, updatedAt: inventory.updatedAt },
                    data: { suspended: false, reason: null } });
                if (!cleared.count) return;
                await tx.deskRecord.upsert({ where: { bookId_key: { bookId, key: "flat-reconciliation:" + old.id } },
                    create: { bookId, key: "flat-reconciliation:" + old.id, kind: "inventory_reconciliation", role: "host",
                        dataJson: JSON.stringify({ instrumentId: old.instrumentId, intentId: old.id,
                            priorReason: inventory.reason, quantity: 0, venueQuantity: 0, executedQuantity: closeQty,
                            proof: "Terminal reduce-only close, exact journaled fills, balanced episode, flat venue and ledger, no open venue orders or other active intents.",
                            reconciledAt: new Date().toISOString() }) }, update: {} });
            }
            const changed=await tx.deskIntent.updateMany({where:{id:old.id,state:"settling",filledQty:current.filledQty},
                data:{state:status.status==="filled"?"filled":"terminal",reservedUsd:0}});
            if(changed.count)await tx.deskRecord.upsert({where:{bookId_key:{bookId,key:"settlement:"+old.id}},
                create:{bookId,key:"settlement:"+old.id,kind:"order_reconciliation",role:"host",dataJson:JSON.stringify({intentId:old.id,oid:status.oid,venueStatus:status.status,venueStatusAt:status.statusTimestamp??null,requestedQuantity:old.quantity,executedQuantity:current.filledQty,unfilledQuantity:old.quantity-current.filledQty,releasedReservationUsd:current.reservedUsd,reconciledAt:new Date().toISOString(),proof:"Terminal venue status; exact journaled executed quantity; no live entry order; account and owned inventory agree. No exchange write."})},update:{}});
        });
    }
    for (const order of orders) await reconcileAbsentSubmission(db, venue, book, instruments, order);
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
