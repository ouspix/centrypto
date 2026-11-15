import type { DeskBook, DeskShift, Prisma, PrismaClient } from "@prisma/client";
import { record } from "./books";
import { isDeskDatabaseBusy } from "./errors";
import { requestWatch } from "./routine-work";
import type { DeskRole, RoleNote } from "./roles";

/** Only idempotent database journal writes belong here, never venue actions. */
export async function journalTransaction<T>(db: PrismaClient, book: DeskBook, shift: DeskShift,
    signal: AbortSignal, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw new Error("Shift cancelled.");
        try {
            return await db.$transaction(async tx => {
                if (signal.aborted) throw new Error("Shift cancelled.");
                const valid = await tx.deskShift.findFirst({ where: {
                    id: shift.id, bookId: book.id, lease: shift.lease, status: "running",
                    leaseUntil: { gt: new Date() }, book: { version: shift.version },
                } });
                if (!valid) throw new Error("Shift revoked");
                const result = await work(tx);
                if (signal.aborted) throw new Error("Shift cancelled.");
                return result;
            }, { maxWait: 5000, timeout: 15000 });
        } catch (error) {
            if (!isDeskDatabaseBusy(error) || attempt >= 2 || signal.aborted) throw error;
            await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
        }
    }
}

export async function checkpointRoleNote(db: PrismaClient, book: DeskBook, shift: DeskShift,
    role: DeskRole, note: RoleNote, signal: AbortSignal) {
    await journalTransaction(db, book, shift, signal, tx =>
        record(tx, book.id, shift.id, shift.id + ":" + role, "note", role, note));
}

/** Durable, atomic slots bound expensive research even across worker restarts. */
export async function reserveBacktestRun(db: PrismaClient, book: DeskBook, shift: DeskShift,
    role: DeskRole, callId: string, signal: AbortSignal) {
    for (let slot = 0; slot < 2; slot++) {
        try {
            await journalTransaction(db, book, shift, signal, tx => tx.deskRecord.create({ data: {
                bookId: book.id, shiftId: shift.id, key: shift.id + ":backtest-budget:" + slot,
                kind: "research_budget", role, dataJson: JSON.stringify({ tool: "backtest_strategy", callId }),
            } }));
            return;
        } catch (error) {
            if ((error as { code?: string })?.code !== "P2002") throw error;
        }
    }
    throw new Error("Backtest budget exhausted for this shift, including prior attempts.");
}

/** The committed note is the durable scheduling request. Replayed on resume;
 * the completion marker and watch commit together, so a consumed watch is not rearmed. */
export async function scheduleRoleFollowUp(db: PrismaClient, book: DeskBook, shift: DeskShift,
    role: DeskRole, note: RoleNote, signal: AbortSignal) {
    const due = note.followUpAt && new Date(note.followUpAt);
    if (!due || !Number.isFinite(+due) || +due <= Date.now() || +due >= Date.now() + 90 * 86400000) return;
    const key = shift.id + ":" + role + ":follow-up";
    await journalTransaction(db, book, shift, signal, async tx => {
        const done = await tx.deskRecord.findUnique({ where: { bookId_key: { bookId: book.id, key } } });
        if (done) return;
        const forward=await tx.deskRecord.findMany({where:{bookId:book.id,OR:[{kind:"prospective_study",key:{startsWith:`prospective:${book.version}:`}},{kind:"entry_comparison",key:{startsWith:`entry-comparison:${book.version}:`}}]},take:30});
        const owned=forward.map(r=>JSON.parse(r.dataJson)).find(s=>s.status==="observing"&&s.endAt===+due&&note.evidenceIds.includes(s.id));
        if(owned){
            await record(tx,book.id,shift.id,key,"follow_up_scheduled",role,{watchId:null,status:"not_scheduled",reason:"Prospective completion already owns this review",studyId:owned.id});
            return;
        }
        const result = await requestWatch(tx, book, shift, role, {
            kind: "review", thesis: note.thesis || note.summary, deadline: due, subjectKey:key,
        });
        await record(tx, book.id, shift.id, key, "follow_up_scheduled", role, result);
    });
}
