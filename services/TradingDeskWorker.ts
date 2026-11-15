import { observeSwingSetups } from "@/lib/desk/setup-outcomes";
import "server-only";
import type { DeskBook } from "@prisma/client";
import { usesAppPostgres } from "@/lib/app-database-provider";
import { prisma } from "@/lib/db";
import { claimShift, runShift } from "@/lib/desk/shifts";
import { ingestNews, processWatches, sampleMarket, wakeOnFills } from "@/lib/desk/triggers";
import { tickDeskExecution } from "@/lib/desk/execution";
import { queueWake } from "@/lib/desk/books";
import { deskProbeCoolingDown, verifyDeskRuntime } from "@/lib/desk/runtime";
import { deskErrorMessage, isDeskStorageCorruption } from "@/lib/desk/errors";
import { discoveryMode, monitorOpportunities } from "@/lib/desk/opportunity-reviews";
import { discoveryIntervalMs } from "@/lib/desk/discovery-scan";
import { liquidityWatchIntervalMs, monitorLiquidityWatches } from "@/lib/desk/pass-review";
import { publishProtectionStatus } from "@/lib/desk/protection-status";
import { scheduleMarketNews } from "@/lib/desk/market-context";
import { scheduleMarketFeatures } from "@/lib/desk/market-snapshots";
import { reconcileTokenMeters } from "@/lib/desk/token-usage";
export { isDeskStorageCorruption } from "@/lib/desk/errors";

type Task = { done: Promise<void>; stop: AbortController };
export class TradingDeskWorker {
    private tasks = new Map<string, Task>();
    private lastScan = new Map<string, number>();
    private lastRecovery = new Map<string, number>();
    private discoverySchedule = new Map<string, { nextAt: number; failures: number }>();
    private liquiditySchedule = new Map<string, { nextAt: number; lastChecked: Map<string, number> }>();
    private stopping = false;
    private readonly marketFeatureStop = new AbortController();
    private meterRecoveryAt = 0;
    private meterRecovery: Promise<unknown> | null = null;

    // A damaged journal cannot establish what already executed. Stop all model
    // turns before attempting any further write, even if SQLite cannot persist the pause.
    public async stopOnCorruption(error: unknown) {
        if (!isDeskStorageCorruption(error)) return false;
        if (!this.stopping) {
            this.stopping = true;
            this.marketFeatureStop.abort();
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
        if (usesAppPostgres(prisma)) {
            await prisma.deskBook.count();
            return;
        }
        const rows = await prisma.$queryRawUnsafe<{quick_check:string}[]>("PRAGMA quick_check");
        if (rows.length !== 1 || rows[0].quick_check !== "ok") throw new Error("Database corruption: SQLite quick check failed");
    }

    private start(key: string, book: DeskBook, work: (signal: AbortSignal) => Promise<void>) {
        if (this.stopping || this.tasks.has(key)) return;
        const stop = new AbortController();
        const component = key.split(":")[0];
        const done = work(stop.signal)
            .then(async () => {
                if (book.lastError?.startsWith("[" + component + "]"))
                    await prisma.deskBook.updateMany({ where: { id: book.id, lastError: book.lastError }, data: { lastError: null } });
            })
            .catch(async (e) => {
                if (await this.stopOnCorruption(e)) return;
                const error = deskErrorMessage(e);
                console.warn("[Trading desk]", key.split(":")[0], error);
                await prisma.deskBook
                    .updateMany({ where: { id: book.id }, data: { lastError: "[" + component + "] " + new Date().toISOString() + " " + error } })
                    .catch(() => {});
            })
            .finally(() => this.tasks.delete(key));
        this.tasks.set(key, { done, stop });
    }

    public async poll() {
        if (this.stopping) return;
        if (!this.meterRecovery && Date.now() >= this.meterRecoveryAt) {
            this.meterRecoveryAt = Date.now() + 60_000;
            this.meterRecovery = reconcileTokenMeters(prisma)
                .catch(error => console.warn("[Trading desk] Token meter cleanup will retry", deskErrorMessage(error)))
                .finally(() => { this.meterRecovery = null; });
        }
        const books = await prisma.deskBook.findMany();
        for (const network of new Set(books.map(book => book.isTestnet))) {
            scheduleMarketFeatures(network, this.marketFeatureStop.signal);
            scheduleMarketNews(network, this.marketFeatureStop.signal);
        }
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
                    const observation = await tickDeskExecution(id);
                    if (book.enabled) this.lastRecovery.set(id, Date.now());
                    else this.lastRecovery.delete(id);
                    // Publishing analytical visibility runs separately, after protection.
                    // Its database work never gates or slows the next execution tick.
                    if (observation) this.start("protection-status:" + id, book, () => publishProtectionStatus(prisma, book, observation));
                });
            } else {
                this.lastRecovery.delete(id);
            }
            if (book.enabled || dueResearch || running || Date.now() - (this.lastScan.get(id) ?? 0) > 30000) {
                this.start("watches:" + id, book, async () => {
                    await processWatches(book);
                    await observeSwingSetups(prisma,book);
                });
            }
            if (!book.enabled && !dueResearch && !running) continue;
            if (book.enabled && book.kind === "directional") {
                const discovery = this.discoverySchedule.get(id);
                if (["live", "shadow"].includes(discoveryMode()) && Date.now() >= (discovery?.nextAt ?? 0)) {
                    this.start("discovery:" + id, book, async signal => {
                        try {
                            const startedAt = Date.now();
                            await monitorOpportunities(book, signal);
                            this.discoverySchedule.set(id, { nextAt: startedAt + discoveryIntervalMs, failures: 0 });
                        } catch (error) {
                            const failures = Math.min((discovery?.failures ?? 0) + 1, 4);
                            this.discoverySchedule.set(id, { nextAt: Date.now() + discoveryIntervalMs * 2 ** failures, failures });
                            throw error;
                        }
                    });
                }
                const liquidity = this.liquiditySchedule.get(id) ?? { nextAt: 0, lastChecked: new Map<string, number>() };
                if (Date.now() >= liquidity.nextAt) this.start("liquidity:" + id, book, async signal => {
                    liquidity.nextAt = Date.now() + liquidityWatchIntervalMs;
                    this.liquiditySchedule.set(id, liquidity);
                    await monitorLiquidityWatches(book, liquidity.lastChecked, signal);
                });
            }
            if (Date.now() - (this.lastScan.get(id) ?? 0) > 10000) {
                this.lastScan.set(id, Date.now());
                await prisma.deskBook.updateMany({
                    where: { id, version: book.version },
                    data: { heartbeatAt: new Date() },
                });
                if (book.enabled) {
                    await queueWake(prisma, book, "hypothesis:" + Math.floor(Date.now() / (JSON.parse(book.mandateJson).maxOpenRiskUsd ? 2*3600000 : 3600000)), "hypothesis_research", "research", {
                        instruction: "First check read_desk_work for overdue or unowned research obligations; progress or explicitly resolve a bounded batch without refreshing irrelevant market/account data. Read research_landscape and research_backlog. Prioritize a defensible under-tested family or direction (including shorts) from the full-market researchLanes; do not repeat only long pullbacks. Use screen_markets and inspect at most four candidates sequentially, sharing cached context. No current entry does not preclude a historical experiment. Test swing ideas with backtest_strategy engine=candles, source=venue_candles, 30-90 days at 1h or finer actual 15m coverage, fixed rules/costs. Use three non-overlapping windows only for short depth replay. Link proposalKey for backlog ideas. For positive preliminary evidence, start_prospective_test freezes a rule and records future modeled outcomes without orders. If a completed experiment genuinely answers a changed question, read backtest_status and resolve its disposition; reading status alone is not progress. Record a disposition with resolve_research_idea: evidence_ready, rejected or waiting_external with exact dependency and next review. Do not endlessly park or rerun unchanged ideas. Queue returns immediately; completion triggers review. No profitable result is required. Do not transfer funds, activate books or place orders."
                    }, 7);
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
        this.marketFeatureStop.abort();
        for (const task of this.tasks.values()) task.stop.abort();
        await Promise.allSettled([...this.tasks.values()].map((t) => t.done));
    }
}
