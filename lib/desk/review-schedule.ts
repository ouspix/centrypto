import type { DeskBook, PrismaClient } from "@prisma/client";
import { accountExposure } from "./market";
import { LIVE_ORDER_STATES } from "./execution-risk";
import { portfolioContext } from "./portfolio-context";
import { recentPortfolioCoverage } from "./portfolio-coverage";

export const flatReviewSeconds = 30 * 60;
const observations = new Map<string, { at: number; flat: boolean }>();

/** Cash alone is flat; unknown exposure, reservations and suspended inventory are not. */
export async function verifiedFlatBook(db: PrismaClient, book: DeskBook, now = Date.now()) {
    if (book.kind !== "directional") return false;
    const [inventory, pending] = await Promise.all([
        db.deskInventory.count({ where: { bookId: book.id, OR: [{ quantity: { not: 0 } }, { suspended: true }] } }),
        db.deskIntent.count({ where: { bookId: book.id, OR: [{ reservedUsd: { gt: 0 } }, { state: { in: LIVE_ORDER_STATES } }] } }),
    ]);
    if (inventory || pending) return false;
    const key = JSON.stringify([book.id, book.version, book.accountAddress, book.isTestnet]);
    const cached = observations.get(key);
    if (cached && now >= cached.at && now - cached.at < 30_000) return cached.flat;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const exposure = await Promise.race([
            accountExposure(book).catch(() => null),
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000); }),
        ]);
        const flat = !!exposure && exposure.positions.every((p: { quantity: string }) => Number(p.quantity) === 0)
            && exposure.openOrders.length === 0
            && exposure.spot.every((s: { token: number; quantity: string; locked: string }) =>
                Number(s.locked) === 0 && (Number(s.quantity) === 0 || (s.token === 0 && Number(s.quantity) > 0)));
        // A failed observation does not inherit an earlier flat state.
        for (const [id, entry] of observations) if (now - entry.at > 30_000) observations.delete(id);
        observations.set(key, { at: now, flat });
        return flat;
    } finally { clearTimeout(timer); }
}

export async function reviewSchedule(db: PrismaClient, book: DeskBook, now: Date) {
    const flat = await verifiedFlatBook(db, book, +now);
    const intervalSeconds = flat ? Math.max(book.frequencySeconds, JSON.parse(book.mandateJson).maxOpenRiskUsd ? 1800 : flatReviewSeconds) : book.frequencySeconds;
    const last = await db.deskWake.findFirst({
        where: { bookId: book.id, version: book.version, kind: "scheduled", mode: "live", key: { startsWith: "review:" } },
        orderBy: { dueAt: "desc" }, select: { dueAt: true },
    });
    // Check exposure even during a slow flat interval. Once exposure appears or becomes
    // unknown, restore the configured cadence from the last actual scheduled review.
    let dueAt = last
        ? new Date((flat ? Math.max : Math.min)(+book.nextReviewAt, +last.dueAt + intervalSeconds * 1000))
        : book.nextReviewAt;
    if (flat) {
        const recent = await db.deskShift.findMany({ where: { bookId: book.id, version: book.version, mode: "live", status: "completed",
            endedAt: { gte: new Date(+now - intervalSeconds * 1000) } }, orderBy: { endedAt: "desc" }, take: 12 });
        const covered = recent.find(s => {
            const opening = JSON.parse(s.briefJson);
            return opening.verifiedFlat === true && opening.routineOnly !== true && opening.triggers?.some((t: { kind: string }) =>
                ["opportunity_scan", "market_move", "scheduled"].includes(t.kind));
        });
        // Only a completed full review covers the flat-book fallback. Triage
        // deferrals and focused watches cannot move it; exposure cadence is unchanged.
        if (covered?.endedAt && await db.deskRecord.count({ where: { bookId: book.id, shiftId: covered.id, role: "lead", kind: "note" } }))
            dueAt = new Date(Math.max(+dueAt, +covered.endedAt + intervalSeconds * 1000));
    }
    if (!flat) {
        const covered = await recentPortfolioCoverage(db, book, await portfolioContext(db, book, +now, false), +now);
        if (covered) dueAt = new Date(Math.max(+dueAt, Date.parse(covered.validUntil)));
    }
    return { flat, intervalSeconds, dueAt };
}
