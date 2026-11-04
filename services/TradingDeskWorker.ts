import "server-only";
import type { DeskBook } from "@prisma/client";
import { prisma } from "@/lib/db";
import { claimShift, runShift } from "@/lib/desk/shifts";
import { ingestNews, processWatches, sampleMarket, wakeOnFills } from "@/lib/desk/triggers";
import { tickDeskExecution } from "@/lib/desk/execution";
import { queueWake } from "@/lib/desk/books";
import { deskProbeCoolingDown, verifyDeskRuntime } from "@/lib/desk/runtime";
import { deskErrorMessage, isDeskStorageCorruption } from "@/lib/desk/errors";
export { isDeskStorageCorruption } from "@/lib/desk/errors";

type Task = { done: Promise<void>; stop: AbortController };
export class TradingDeskWorker {
    private tasks = new Map<string, Task>();
    private lastScan = new Map<string, number>();
    private lastRecovery = new Map<string, number>();
    private stopping = false;

    // A damaged journal cannot establish what already executed. Stop all model
    // turns before attempting any further write, even if SQLite cannot persist the pause.
    public async stopOnCorruption(error: unknown) {
        if (!isDeskStorageCorruption(error)) return false;
        if (!this.stopping) {
            this.stopping = true;
            for (const task of this.tasks.values()) task.stop.abort();
            console.error("[Trading desk] Database corruption detected. Desk halted pending repair and restart.");
            await prisma.deskBook.updateMany({
                where: { enabled: true },
                data: { enabled: false, version: { increment: 1 }, lastError: "Database corruption: repair and review before enabling." },
            }).catch(() => {});
        }
        return true;
    }

    public async checkStorage() {
        const rows = await prisma.$queryRawUnsafe<{quick_check:string}[]>("PRAGMA quick_check");
        if (rows.length !== 1 || rows[0].quick_check !== "ok") throw new Error("Database corruption: SQLite quick check failed");
    }

    private start(key: string, book: DeskBook, work: (signal: AbortSignal) => Promise<void>) {
        if (this.stopping || this.tasks.has(key)) return;
        const stop = new AbortController();
        const done = work(stop.signal)
            .catch(async (e) => {
                if (await this.stopOnCorruption(e)) return;
                const error = deskErrorMessage(e);
                console.warn("[Trading desk]", key.split(":")[0], error);
                await prisma.deskBook
                    .updateMany({ where: { id: book.id }, data: { lastError: error } })
                    .catch(() => {});
            })
            .finally(() => this.tasks.delete(key));
        this.tasks.set(key, { done, stop });
    }

    public async poll() {
        if (this.stopping) return;
        const books = await prisma.deskBook.findMany();
        for (const book of books) {
            if (this.stopping) return;
            const id = book.id;
            const dueResearch =
                !book.enabled &&
                (await prisma.deskWake.findFirst({
                    where: {
                        bookId: id,
                        version: book.version,
                        mode: "research",
                        shiftId: null,
                        dueAt: { lte: new Date() },
                    },
                }));
            const running =
                !book.enabled &&
                (await prisma.deskShift.findFirst({
                    where: {
                        bookId: id,
                        version: book.version,
                        mode: "research",
                        status: { in: ["running", "paused"] },
                    },
                }));
            const draining = book.enabled
                ? null
                : await prisma.deskExecutionState.findUnique({
                      where: { bookId: id },
                      select: { cancelAt: true, quoteJson: true },
                  });
            const unresolved =
                !book.enabled &&
                (await prisma.deskIntent.findFirst({
                    where: {
                        bookId: id,
                        OR: [
                            { reservedUsd: { gt: 0 } },
                            { state: { in: ["working", "settling", "blocked", "unknown", "submitting"] } },
                        ],
                    },
                    select: { id: true },
                }));
            const holding =
                !book.enabled &&
                (await prisma.deskInventory.findFirst({
                    where: { bookId: id, OR: [{ quantity: { not: 0 } }, { suspended: true }] },
                    select: { id: true },
                }));
            if (
                book.enabled ||
                draining?.cancelAt ||
                draining?.quoteJson ||
                unresolved ||
                holding ||
                this.lastRecovery.has(id)
            ) {
                this.start("execution:" + id, book, async () => {
                    await tickDeskExecution(id);
                    if (book.enabled) this.lastRecovery.set(id, Date.now());
                    else this.lastRecovery.delete(id);
                });
            } else {
                this.lastRecovery.delete(id);
            }
            if (book.enabled || dueResearch || running || Date.now() - (this.lastScan.get(id) ?? 0) > 30000) {
                this.start("watches:" + id, book, async () => {
                    await processWatches(book);
                });
            }
            if (!book.enabled && !dueResearch && !running) continue;
            if (Date.now() - (this.lastScan.get(id) ?? 0) > 10000) {
                this.lastScan.set(id, Date.now());
                await prisma.deskBook.updateMany({
                    where: { id, version: book.version },
                    data: { heartbeatAt: new Date() },
                });
                if (book.enabled) {
                    this.start("news:" + id, book, async () => {
                        await ingestNews(book);
                    });
                    this.start("market:" + id, book, async () => {
                        await sampleMarket(book);
                    });
                    this.start("fills:" + id, book, async () => {
                        await wakeOnFills(book);
                    });
                }
            }
            // Resume against the exchange first. Research-only books never touch signing.
            const liveReady = book.enabled && Date.now() - (this.lastRecovery.get(id) ?? 0) <= 60000;
            if (book.enabled && !liveReady) {
                const urgent = await prisma.deskWake.findMany({
                    where: {
                        bookId: id,
                        version: book.version,
                        mode: "live",
                        priority: 10,
                        shiftId: null,
                        dueAt: { lte: new Date() },
                        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                    },
                    take: 24,
                });
                for (const w of urgent)
                    await queueWake(
                        prisma,
                        book,
                        "outage:" + w.key,
                        "risk",
                        "research",
                        {
                            reason: "Exchange reconciliation is unavailable. Review known exposure and report uncertainty. The live review remains queued.",
                            event: JSON.parse(w.payload),
                        },
                        10,
                    );
                if (
                    !urgent.length &&
                    !(await prisma.deskWake.findFirst({
                        where: {
                            bookId: id,
                            version: book.version,
                            mode: "research",
                            shiftId: null,
                            dueAt: { lte: new Date() },
                        },
                    }))
                )
                    continue;
            }
            this.start("roundtable:" + id, book, async (signal) => {
                if (deskProbeCoolingDown()) return;
                const shift = await claimShift(book, new Date(), liveReady);
                if (shift) await runShift(book, shift, signal, (activeSignal) => verifyDeskRuntime(activeSignal, book.id));
            });
        }
    }
    public async close() {
        this.stopping = true;
        for (const task of this.tasks.values()) task.stop.abort();
        await Promise.allSettled([...this.tasks.values()].map((t) => t.done));
    }
}
