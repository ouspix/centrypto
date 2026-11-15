import { createHash } from "node:crypto";
import type { DeskBook, PrismaClient } from "@prisma/client";
import { portfolioContext } from "./portfolio-context";

type Context = Awaited<ReturnType<typeof portfolioContext>>;
type Store = Pick<PrismaClient, "deskRecord" | "deskShift" | "deskInventory" | "deskIntent" | "deskExecutionState">;
export const coverageKey = (book: DeskBook) => ({ bookId: book.id, key: `portfolio-review-coverage:${book.version}` });
export function portfolioFingerprint(context: Context) {
    if (!context.reconciledRecently || context.capacity.pendingCommitments || !context.holdings.length) return null;
    return createHash("sha256").update(JSON.stringify(context.holdings.map(p => ({ instrumentId: p.instrumentId, quantity: p.quantity,
        stopPrice: p.stopPrice, targetPrice: p.targetPrice, openedAt: p.openedAt, suspended: p.suspended,
        originalExitDeadline: p.originalExitDeadline })).sort((a, b) => a.instrumentId.localeCompare(b.instrumentId)))).digest("hex");
}

/** Only complete, current-version live comparisons cover a scheduled portfolio check.
 * Triage, a partial journal, stale exposure, reservations or changed plans never qualify.
 */
export async function savePortfolioCoverage(db: Store, book: DeskBook, shiftId: string, endedAt: Date) {
    const context = await portfolioContext(db, book, +endedAt, false), fingerprint = portfolioFingerprint(context);
    if (!fingerprint) return false;
    const [shift, note, rows] = await Promise.all([
        db.deskShift.findUnique({ where: { id: shiftId } }),
        db.deskRecord.count({ where: { bookId: book.id, shiftId, role: "lead", kind: "note" } }),
        db.deskRecord.findMany({ where: { bookId: book.id, shiftId, role: "lead", kind: "portfolio_comparison" } }),
    ]);
    if (!shift || shift.mode !== "live" || shift.status !== "completed" || shift.version !== book.version || !note) return false;
    const comparisons = rows.map(r => JSON.parse(r.dataJson)).filter(c => c.bookVersion === book.version && c.forwardCase &&
        c.mode === "live" && c.portfolio && portfolioFingerprint(c.portfolio) === fingerprint);
    if (!context.holdings.every(p => comparisons.some(c => c.holdingInstrumentId === p.instrumentId))) return false;
    const dataJson = JSON.stringify({ shiftId, bookVersion: book.version, completedAt: endedAt.toISOString(), fingerprint,
        holdingInstrumentIds: context.holdings.map(p => p.instrumentId) });
    const key = coverageKey(book);
    await db.deskRecord.upsert({ where: { bookId_key: key }, create: { ...key, shiftId, role: "host", kind: "portfolio_review_coverage", dataJson },
        update: { shiftId, dataJson } });
    return true;
}

export async function recentPortfolioCoverage(db: Store, book: DeskBook, context: Context, now = Date.now()) {
    const fingerprint = portfolioFingerprint(context);
    if (!fingerprint) return null;
    const row = await db.deskRecord.findUnique({ where: { bookId_key: coverageKey(book) } });
    if (!row) return null;
    const saved = JSON.parse(row.dataJson), at = Date.parse(saved.completedAt);
    if (saved.bookVersion !== book.version || saved.fingerprint !== fingerprint || !Number.isFinite(at) || at > now || now - at >= book.frequencySeconds * 1000) return null;
    return { ...saved, validUntil: new Date(at + book.frequencySeconds * 1000).toISOString(),
        instruction: "These unchanged holdings were assessed in the referenced completed review. Reuse that assessment while investigating new candidates; recheck any new adverse evidence or replacement case. Do not mechanically repeat unchanged reads and journals. Urgent protection, new exposure events and original deadlines remain immediate and independent." };
}
