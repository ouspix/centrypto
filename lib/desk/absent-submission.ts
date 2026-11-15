import type { PrismaClient, DeskBook, DeskIntent } from "@prisma/client";
import type { DeskInstrument } from "./instruments";
import { positionKey, type DeskVenue } from "./execution-types";

/** Only expired, non-reducing directional HTTP 422 submissions qualify.
 * Timeouts, partial fills, pairs and protective orders require normal reconciliation. */
export function absentSubmissionCandidate(order: DeskIntent, now: number) {
    if (order.state !== "unknown" || order.filledQty !== 0 || order.groupKey ||
        order.createdAt.getTime() > now - 120_000 ||
        !/^Exchange exchange HTTP 422(?:$|:)/.test(order.reason ?? "")) return false;
    try {
        const request = JSON.parse(order.requestJson);
        const expiry = Date.parse(request.entryExpiresAt);
        return request.reduceOnly !== true && !!request.strategyVersion &&
            Number.isFinite(expiry) && expiry <= now;
    } catch { return false; }
}

/** Two independent absence observations at least 60s apart; no exchange writes.
 * Each rechecks the whole submission window, not the rolling ledger cursor. */
export async function reconcileAbsentSubmission(
    db: PrismaClient, venue: DeskVenue, book: DeskBook, instruments: DeskInstrument[], order: DeskIntent,
) {
    if (book.kind !== "directional" || !absentSubmissionCandidate(order, Date.now())) return;
    const instrument = instruments.find(i => i.id === order.instrumentId && i.kind === "perp");
    if (!instrument) return;
    const key = "submission-absence:" + order.id;
    const reset = () => db.deskRecord.deleteMany({ where: { bookId: book.id, key } });
    try {
        const ids = [order.cloid, order.stopCloid, order.targetCloid].filter((id): id is string => !!id);
        const statuses = await Promise.all(ids.map(id => venue.status(book, id)));
        const through = Date.now(), since = order.createdAt.getTime() - 120_000;
        const fills = await venue.fills(book, since, through);
        const account = await venue.account(book, instruments);
        const current = await db.deskIntent.findUniqueOrThrow({ where: { id: order.id } });
        const inventory = await db.deskInventory.findUnique({
            where: { bookId_instrumentId: { bookId: book.id, instrumentId: order.instrumentId } },
        });
        if (!absentSubmissionCandidate(current, through) || statuses.some(Boolean) ||
            fills.some(f => f.coin === order.coin) ||
            account.openOrders.some(o => o.coin === order.coin || !!o.cloid && ids.includes(o.cloid)) ||
            (account.positions.get(positionKey(instrument)) ?? 0) !== 0 ||
            inventory?.suspended || (inventory?.quantity ?? 0) !== 0) {
            await reset();
            return;
        }
        const previous = await db.deskRecord.findUnique({ where: { bookId_key: { bookId: book.id, key } } });
        const first = previous ? JSON.parse(previous.dataJson).checkedAt : undefined;
        const checkedAt = new Date().toISOString();
        if (!first || !Number.isFinite(Date.parse(first))) {
            await db.deskRecord.upsert({ where: { bookId_key: { bookId: book.id, key } },
                create: { bookId: book.id, key, kind: "submission_absence", role: "host",
                    dataJson: JSON.stringify({ intentId: order.id, checkedAt, since, through }) },
                update: { dataJson: JSON.stringify({ intentId: order.id, checkedAt, since, through }) } });
            return;
        }
        if (Date.parse(checkedAt) - Date.parse(first) < 60_000) return;
        await db.$transaction(async tx => {
            const changed = await tx.deskIntent.updateMany({
                where: { id: order.id, state: "unknown", filledQty: 0, updatedAt: current.updatedAt },
                data: { state: "abandoned", reservedUsd: 0,
                    reason: "Expired HTTP 422 submission absent at venue after repeated full-window reconciliation; no resubmission" },
            });
            if (changed.count) await tx.deskRecord.upsert({
                where: { bookId_key: { bookId: book.id, key: "settlement:" + order.id } },
                create: { bookId: book.id, key: "settlement:" + order.id, kind: "order_reconciliation", role: "host",
                    dataJson: JSON.stringify({ intentId: order.id, originalError: current.reason,
                        firstCheckedAt: first, reconciledAt: checkedAt, fillsSince: since, fillsThrough: through,
                        checkedOrderIds: ids, releasedReservationUsd: current.reservedUsd, executedQuantity: 0,
                        proof: "Expired HTTP 422; two absent entry/stop/target status checks at least 60s apart; full-window fills contain no instrument fills; no instrument orders, venue position or owned inventory. No exchange write." }) },
                update: {},
            });
        });
    } catch (error) {
        // A failed/incomplete read breaks the chain of absence evidence.
        await reset();
        throw error;
    }
}
