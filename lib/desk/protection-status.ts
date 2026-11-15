import type { DeskBook, DeskInventory, DeskIntent, PrismaClient } from "@prisma/client";
import type { DeskAccount } from "./execution-types";
import { LIVE_ORDER_STATES } from "./execution-risk";

export const protectionFreshnessMs = 30_000;
export const protectionStatusKey = (book: Pick<DeskBook, "version">) => `protection-status:${book.version}`;
type Plan = { instrumentId: string; openedAt: string; maxHoldUntil: string; intentId: string };
type Inventory = Pick<DeskInventory, "instrumentId" | "quantity" | "stopPrice" | "suspended" | "since"> & Partial<Pick<DeskInventory, "updatedAt">>;
type Intent = Pick<DeskIntent, "instrumentId" | "cloid" | "stopCloid" | "groupKey"> & Partial<Pick<DeskIntent, "state" | "reservedUsd">>;
export type ProtectionObservation = { account: DeskAccount; observedAt: Date };

/** Evidence only. Never creates/revises protection, grants entry, or changes risk. */
export function protectionEvidence(inventory: Inventory[], intents: Intent[], plans: Plan[],
    observation: ProtectionObservation, now = Date.now()) {
    const fresh = +observation.observedAt <= now + 1000 && now - +observation.observedAt <= protectionFreshnessMs;
    return {
        observedAt: observation.observedAt.toISOString(), validUntil: new Date(+observation.observedAt + protectionFreshnessMs).toISOString(),
        source: "execution_reconciliation", status: fresh ? "observed" : "stale",
        instruction: "Fresh verified facts supersede older journal claims of missing visibility. A stored deadline is enforced locally while the execution worker is running; it is not an exchange-hosted timer. This evidence is not permission to add risk. Reassess any real missing, stale or mismatched protection.",
        flatPositions: inventory.filter(p => fresh && p.quantity === 0 && !p.suspended && p.updatedAt && +p.updatedAt <= +observation.observedAt &&
            p.instrumentId.includes(":perp:") &&
            (observation.account.positions.get(`perp:${p.instrumentId.split(":perp:")[1]}`) ?? 0) === 0 &&
            !observation.account.openOrders.some(o => o.coin === p.instrumentId.split(":perp:")[1]) &&
            !intents.some(i => i.instrumentId === p.instrumentId && ((i.reservedUsd ?? 0) > 0 || LIVE_ORDER_STATES.includes(i.state as typeof LIVE_ORDER_STATES[number]))))
            .sort((a, b) => +b.updatedAt! - +a.updatedAt!).slice(0, 8)
            .map(p => ({ instrumentId: p.instrumentId, quantity: 0, inventoryUpdatedAt: p.updatedAt!.toISOString(),
                observedAt: observation.observedAt.toISOString(), noVenueOrders: true,
                instruction: "Owned and venue position are flat; no venue orders or pending local intents. Reuse this verification while fresh. Lead handles remaining proposal/task closure; no duplicate execution consultation is needed." })),
        positions: inventory.filter(p => p.quantity !== 0).map(p => {
            const perp = p.instrumentId.includes(":perp:"), coin = p.instrumentId.split(":perp:")[1];
            const venueQuantity = perp ? observation.account.positions.get(`perp:${coin}`) ?? 0 : null;
            const reconciled = fresh && !p.suspended && +p.since <= +observation.observedAt && venueQuantity !== null && Math.abs(venueQuantity - p.quantity) < 1e-9;
            const children = new Set(intents.filter(i => i.instrumentId === p.instrumentId)
                .flatMap(i => [i.stopCloid, ...(i.groupKey === "guard/sl" ? [i.cloid] : [])]).filter(Boolean));
            const linked = observation.account.openOrders.filter(o => o.coin === coin && !!o.cloid && children.has(o.cloid));
            const stop = linked.find(o => o.reduceOnly === true && o.isTrigger === true && /^Stop /i.test(o.orderType ?? "") &&
                o.side === (p.quantity > 0 ? "A" : "B") && p.stopPrice !== null && p.stopPrice > 0 &&
                Math.abs(Number(o.triggerPx) - p.stopPrice) <= Math.max(1e-9, p.stopPrice * 1e-9) &&
                (o.isPositionTpsl === true || Math.abs(Number(o.sz) - Math.abs(p.quantity)) < 1e-9));
            const plan = plans.find(x => x.instrumentId === p.instrumentId && Date.parse(x.openedAt) === +p.since &&
                Number.isFinite(Date.parse(x.maxHoldUntil)) && Date.parse(x.maxHoldUntil) > Date.parse(x.openedAt));
            const due = !!plan && Date.parse(plan.maxHoldUntil) <= now;
            return {
                instrumentId: p.instrumentId, quantity: p.quantity, openedAt: p.since.toISOString(), reconciled,
                nativeStop: {
                    status: !perp ? "not_applicable" : !fresh || !reconciled ? "unverified" : stop ? "verified" : "unverified",
                    expectedTriggerPrice: p.stopPrice, orderId: stop?.oid ?? null, triggerPrice: stop ? Number(stop.triggerPx) : null,
                    reduceOnly: stop?.reduceOnly ?? null, isTrigger: stop?.isTrigger ?? null,
                    orderType: stop?.orderType ?? null, coversPosition: !!stop && reconciled,
                    reason: stop ? null : linked.length ? "Linked stop is missing required native flags or does not match the owned position." : "No matching owned native stop was observed.",
                },
                timeExit: { status: !reconciled || !plan ? "unverified" : due ? "due" : "scheduled_local",
                    maxHoldUntil: plan?.maxHoldUntil ?? null, source: "persisted_fill_time_plan",
                    enforcedBy: "execution_worker", requiresRunningWorker: true, lastReconciledAt: observation.observedAt.toISOString() },
                verificationComplete: reconciled && !!stop && !!plan && !due,
            };
        }),
    };
}

/** Called after execution finishes, as separate worker work; no extra venue calls. */
export async function publishProtectionStatus(db: PrismaClient, book: DeskBook, observation: ProtectionObservation) {
    const [inventory, intents, rows] = await Promise.all([
        db.deskInventory.findMany({ where: { bookId: book.id } }),
        db.deskIntent.findMany({ where: { bookId: book.id }, select: { instrumentId: true, cloid: true, stopCloid: true, groupKey: true, state: true, reservedUsd: true } }),
        db.deskRecord.findMany({ where: { bookId: book.id, kind: "position_plan" }, select: { dataJson: true } }),
    ]);
    const evidence = protectionEvidence(inventory, intents, rows.map(r => JSON.parse(r.dataJson)), observation);
    if (evidence.status !== "observed") return;
    const key = { bookId: book.id, key: protectionStatusKey(book) };
    await db.$transaction(async tx => {
        if (!await tx.deskBook.findFirst({ where: { id: book.id, version: book.version } })) return;
        const prior = await tx.deskRecord.findUnique({ where: { bookId_key: key } });
        if (prior && Date.parse(JSON.parse(prior.dataJson).observedAt) >= +observation.observedAt) return;
        await tx.deskRecord.upsert({ where: { bookId_key: key },
            create: { ...key, kind: "protection_status", role: "host", dataJson: JSON.stringify(evidence) },
            update: { dataJson: JSON.stringify(evidence), createdAt: new Date() } });
    });
}

/** Local reads only. Stored evidence cannot remain green through an outage/change. */
export async function readProtectionStatus(db: PrismaClient, book: Pick<DeskBook, "id" | "version">, now = Date.now()) {
    const [record, execution, inventory, pending] = await Promise.all([
        db.deskRecord.findUnique({ where: { bookId_key: { bookId: book.id, key: protectionStatusKey(book) } } }),
        db.deskExecutionState.findUnique({ where: { bookId: book.id } }),
        db.deskInventory.findMany({ where: { bookId: book.id } }),
        db.deskIntent.findMany({ where: { bookId: book.id, OR: [{ reservedUsd: { gt: 0 } }, { state: { in: LIVE_ORDER_STATES } }] }, select: { instrumentId: true } }),
    ]);
    if (!record) return { status: "unavailable", positions: [], flatPositions: [], instruction: "Protection observation is unavailable; no absence or safety conclusion follows." };
    const evidence = JSON.parse(record.dataJson) as ReturnType<typeof protectionEvidence>;
    const fresh = now >= Date.parse(evidence.observedAt) - 1000 && now <= Date.parse(evidence.validUntil) &&
        !!execution?.lastSync && +execution.lastSync <= now + 1000 && now - +execution.lastSync <= protectionFreshnessMs && !execution.lastError;
    evidence.status = fresh ? "observed" : "stale";
    evidence.flatPositions = (evidence.flatPositions ?? []).filter(p => fresh &&
        inventory.some(i => i.instrumentId === p.instrumentId && i.quantity === 0 && !i.suspended && i.updatedAt?.toISOString() === p.inventoryUpdatedAt) &&
        !pending.some(i => i.instrumentId === p.instrumentId));
    evidence.positions = inventory.filter(p => p.quantity !== 0).map(p => {
        const old = evidence.positions.find(x => x.instrumentId === p.instrumentId);
        const unchanged = fresh && !p.suspended && old?.quantity === p.quantity && old.openedAt === p.since.toISOString() &&
            old.nativeStop.expectedTriggerPrice === p.stopPrice;
        if (!old) return { instrumentId: p.instrumentId, quantity: p.quantity, openedAt: p.since.toISOString(), reconciled: false,
            nativeStop: { status: "unverified", expectedTriggerPrice: p.stopPrice, orderId: null, triggerPrice: null,
                reduceOnly: null, isTrigger: null, orderType: null, coversPosition: false, reason: "Owned position changed after the last observation." },
            timeExit: { status: "unverified", maxHoldUntil: null, source: "persisted_fill_time_plan", enforcedBy: "execution_worker", requiresRunningWorker: true, lastReconciledAt: evidence.observedAt }, verificationComplete: false };
        if (!unchanged) return { ...old, reconciled: false, verificationComplete: false,
            nativeStop: { ...old.nativeStop, status: "unverified", coversPosition: false }, timeExit: { ...old.timeExit, status: "unverified" } };
        if (old.timeExit.maxHoldUntil && Date.parse(old.timeExit.maxHoldUntil) <= now)
            return { ...old, verificationComplete: false, timeExit: { ...old.timeExit, status: "due" } };
        return old;
    });
    return evidence;
}
