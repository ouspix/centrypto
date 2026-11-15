import { createHash } from "node:crypto";
import type { DeskBook, PrismaClient } from "@prisma/client";
import type { DeskTool } from "./runtime";
import { queueWake } from "./books";
import { journalTransaction } from "./journal";

/** Persist the economic question once, independently of proposal-board capacity.
 * Same question never requeues merely because another turn samples newer candles. */
export async function queueEvidenceFollowup(
    db: PrismaClient, book: DeskBook, context: Parameters<DeskTool["run"]>[1],
    question: Record<string, unknown>, observation: unknown,
) {
    if (context.role !== "lead" || !book.enabled) return null;
    const shift = await db.deskShift.findFirst({ where: { id: context.shiftId, bookId: book.id } });
    if (!shift || shift.mode !== "live") return null;
    const normalized = Object.fromEntries(Object.keys(question).sort().map(k => [k, question[k]]));
    const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 24);
    return journalTransaction(db, book, shift, context.signal, async tx => {
        const wake = await queueWake(tx, book, `evidence-followup:${book.version}:${hash}`,
            "hypothesis_research", "research", {
                sourceShiftId: shift.id, sourceCallId: context.callId, question: normalized, observation,
                instruction: "Resolve THIS nominated historical-study evidence gap before unrelated discovery. Read the live proposal/backlog and original source-shift evidence for direction, mechanism, holding horizon and objections; the historical move direction is not automatically the trade direction. Save a research idea if missing. Reuse a linked pending/completed experiment; otherwise submit one frozen cost-aware candle test over available broader history. Inspect coverage, validation/holdout/stress and actual rule definitions. If independent history is exhausted, register a frozen prospective test with a completion condition. Sparse samples alone do not establish negative economics. Record disposition and link run/study receipts. Do not poll jobs, repeat this shallow study, renew an expired entry, change controls or place an exploratory live order. This research wake grants no execution authority."
            }, 7);
        return { wakeId: wake.id, status: wake.shiftId ? "assigned" : "queued", mode: "research",
            instruction: "Durable evidence investigation saved. Preserve the proposal; no polling or extra reminder is needed." };
    });
}
