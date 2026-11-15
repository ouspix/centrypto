import { workBrief } from "./work-ledger";
import { watchView } from "./watch-state";
import "server-only";
import { createHash, randomUUID } from "crypto";
import type { DeskBook, DeskShift } from "@prisma/client";
import { prisma } from "@/lib/db";
import { queueWake, record } from "./books";
import { runRoundtable, type DeskConsultation } from "./roundtable";
import { deskRoles, ROLE_VERSION, type DeskRole, type RoleNote } from "./roles";
import { routineRecipients, watchOwner } from "./routine-work";
import { deskTools } from "./tools";
import { deskErrorMessage, isDeskDatabaseBusy, isDeskStorageCorruption } from "./errors";
import { reviewSchedule } from "./review-schedule";
import { catalystInvestigation } from "./catalyst-memory";
import { researchBacklog } from "./research-backlog";
import { checkpointRoleNote, scheduleRoleFollowUp, journalTransaction } from "./journal";
import { loadTradeProposals, saveTradeProposal, loadTradeProposalReviews, recordProposalReview } from "./proposals";
import { openingSpecialists } from "./work-routing";
import { claimOpportunityWake, finishOpportunityReview, opportunityScanKind } from "./opportunity-reviews";
import { captureReviewContext } from "./market-context";
import { strategyProfile } from "./decision-policy";
import { admitReview } from "./review-triage";
import { readProtectionStatus } from "./protection-status";
import { portfolioContext } from "./portfolio-context";
import { allocationContext } from "./allocation-context";
import { recentPortfolioCoverage, savePortfolioCoverage } from "./portfolio-coverage";
import { bookRiskContext } from "./mandate";

const leaseMs = 90000;

export async function claimShift(book: DeskBook, now = new Date(), liveReady = true) {
    const token = randomUUID();
    const schedule = book.enabled && liveReady ? await reviewSchedule(prisma, book, now)
        : { flat: false, intervalSeconds: book.frequencySeconds, dueAt: book.nextReviewAt };
    return prisma.$transaction(
        async (tx) => {
            // A mandate change revokes ongoing authority and all callbacks from the old lease.
            await tx.deskShift.updateMany({
                where: { bookId: book.id, status: "running", version: { not: book.version } },
                data: { status: "superseded", endedAt: now, leaseUntil: null },
            });
            const current = await tx.deskShift.findFirst({ where: { bookId: book.id, status: "running" } });
            if (current) {
                if (!liveReady && current.mode === "live" && current.leaseUntil && current.leaseUntil <= now) {
                    await tx.deskShift.update({
                        where: { id: current.id },
                        data: { status: "paused", lease: null, leaseUntil: null },
                    });
                } else {
                    if (current.leaseUntil && current.leaseUntil > now) return null;
                    if (
                        current.attempts >= 3 ||
                        +now - +current.createdAt > Math.max(900000, book.frequencySeconds * 1000)
                    ) {
                        await tx.deskShift.update({
                            where: { id: current.id },
                            data: { status: "expired", lease: null, endedAt: now },
                        });
                    } else {
                        const claimed = await tx.deskShift.updateMany({
                            where: { id: current.id, lease: current.lease, status: "running" },
                            data: { lease: token, leaseUntil: new Date(+now + leaseMs), attempts: { increment: 1 } },
                        });
                        return claimed.count ? tx.deskShift.findUniqueOrThrow({ where: { id: current.id } }) : null;
                    }
                }
            }
            if (book.enabled && liveReady && schedule.dueAt > now && +schedule.dueAt !== +book.nextReviewAt) {
                await tx.deskBook.updateMany({
                    where: { id: book.id, enabled: true, version: book.version, nextReviewAt: book.nextReviewAt },
                    data: { nextReviewAt: schedule.dueAt },
                });
            }
            if (book.enabled && liveReady && schedule.dueAt <= now) {
                const moved = await tx.deskBook.updateMany({
                    where: { id: book.id, enabled: true, version: book.version, nextReviewAt: book.nextReviewAt },
                    data: { nextReviewAt: new Date(+now + schedule.intervalSeconds * 1000) },
                });
                if (moved.count)
                    await queueWake(
                        tx,
                        book,
                        "review:" + schedule.dueAt.getTime(),
                        "scheduled",
                        "live",
                        {
                            reason: "Scheduled review of portfolio, market and pending ideas.",
                            verifiedFlat: schedule.flat,
                            intervalSeconds: schedule.intervalSeconds,
                        },
                        5,
                        now,
                    );
            }
            const where = {
                bookId: book.id,
                version: book.version,
                shiftId: null,
                dueAt: { lte: now },
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            };
            let first = await tx.deskWake.findFirst({
                where: { ...where, ...(!book.enabled || !liveReady ? { mode: "research" } : {}) },
                orderBy: [{ priority: "desc" }, { dueAt: "asc" }],
            });
            // Resume interrupted work after urgent events have drained. Never replay notes already saved.
            if (!first || first.priority < 10) {
                const paused = await tx.deskShift.findFirst({
                    where: {
                        bookId: book.id,
                        status: "paused",
                        version: book.version,
                        ...(!book.enabled || !liveReady ? { mode: "research" } : {}),
                    },
                    orderBy: { createdAt: "asc" },
                });
                if (paused) {
                    if (+now - +paused.createdAt > Math.max(900000, book.frequencySeconds * 1000)) {
                        await tx.deskShift.update({
                            where: { id: paused.id },
                            data: { status: "expired", endedAt: now },
                        });
                    } else {
                        const won = await tx.deskShift.updateMany({
                            where: { id: paused.id, status: "paused" },
                            data: { status: "running", lease: token, leaseUntil: new Date(+now + leaseMs) },
                        });
                        return won.count ? tx.deskShift.findUniqueOrThrow({ where: { id: paused.id } }) : null;
                    }
                }
            }
            const discovery = book.enabled && liveReady && first?.mode !== "research" && (first?.priority ?? 0) < 10
                ? await claimOpportunityWake(tx, book, now) : null;
            first ??= discovery?.wake ?? null;
            if (!first) return null;
            // Never combine research-only operator chat with a trading instruction.
            const sameMode = { ...where, mode: first.mode };
            const [material, routine] = await Promise.all([
                tx.deskWake.findMany({
                    where: { ...sameMode, kind: { notIn: ["watch", "follow_up"] } },
                    orderBy: [{ priority: "desc" }, { dueAt: "asc" }],
                    take: 36,
                }),
                tx.deskWake.findMany({
                    where: { ...sameMode, kind: { in: ["watch", "follow_up"] } },
                    orderBy: { dueAt: "asc" },
                }),
            ]);
            if (discovery?.wake && !material.some(w => w.id === discovery.wake!.id)) material.push(discovery.wake);
            const batch = [...material, ...routine];
            const triggers = await Promise.all(
                batch.map(async (wake) => {
                    const payload = JSON.parse(wake.payload);
                    // Upgrade old queued watches (pre-role payload) at claim time.
                    if (wake.kind === "watch" && !payload.role && wake.key.startsWith("watch:")) {
                        const source = await tx.deskWatch.findFirst({
                            where: { id: wake.key.slice(6), bookId: book.id },
                        });
                        if (source) payload.role = await watchOwner(tx, source);
                    }
                    return { id: wake.id, kind: wake.kind, priority: wake.priority, dueAt: wake.dueAt, payload };
                }),
            );
            const compact = new Map<string, (typeof triggers)[number]>();
            for (const t of triggers) {
                // The durable wake rows retain every occurrence, including those
                // created before watch coalescing was introduced.
                const key =
                    t.kind === "watch" || t.kind === "follow_up"
                        ? JSON.stringify([
                              t.payload.role ?? "lead",
                              t.payload.condition ?? "review",
                              t.payload.instrumentId ?? null,
                              t.payload.threshold ?? null,
                              t.payload.eventKey ?? null,
                              String(t.payload.thesis ?? "")
                                  .trim()
                                  .toLowerCase(),
                          ])
                        : t.id;
                compact.set(key, t);
            }
            const agenda = [...compact.values()];
            const activeRoles = routineRecipients({ triggers: agenda });
            const opening = {
                book: book.kind,
                network: book.isTestnet ? "testnet" : "mainnet",
                executionEnvironment: first.mode === "research" ? "read_only_research" : book.isTestnet ? "paper_active_testnet" : "live_mainnet",
                mode: first.mode,
                roleVersion: ROLE_VERSION,
                asOf: now,
                mandate: JSON.parse(book.mandateJson),
                riskPolicy: bookRiskContext(book),
                activeRoles: activeRoles ?? [...openingSpecialists({ triggers: agenda }), "lead"],
                workflow: "selective_collaboration",
                routineOnly: activeRoles !== null,
                verifiedFlat: schedule.flat,
                reviewIntervalSeconds: schedule.intervalSeconds,
                discoveryScanAt: discovery?.scanAt ?? null,
                triggers: agenda,
                coalescedWakes: triggers.length - agenda.length,
            };
            const shift = await tx.deskShift.create({
                data: {
                    bookId: book.id,
                    version: book.version,
                    status: "running",
                    mode: first.mode,
                    briefJson: JSON.stringify(opening),
                    lease: token,
                    leaseUntil: new Date(+now + leaseMs),
                },
            });
            await tx.deskWake.updateMany({
                where: {
                    ...sameMode,
                    AND: [
                        { OR: [{ kind: { in: ["watch", "follow_up"] } }, { id: { in: material.map((w) => w.id) } }] },
                    ],
                },
                data: { shiftId: shift.id },
            });
            return shift;
        },
        { timeout: 10000 },
    );
}

async function recoverContext(bookId: string, shiftId: string, mode: string) {
    const [notes, watches, theses, inventory, intents, consults] = await Promise.all([
        prisma.deskRecord.findMany({ where: { bookId, kind: "note" }, orderBy: { id: "desc" }, take: 90 }),
        prisma.deskWatch.findMany({ where: { bookId, mode, status: "open", kind:{not:"pass"} }, orderBy: { deadline: "asc" }, take: 30 }),
        prisma.deskRecord.findMany({ where: { bookId, kind: "thesis" }, orderBy: { id: "desc" }, take: 12 }),
        prisma.deskInventory.findMany({ where: { bookId, quantity: { not: 0 } } }),
        prisma.deskIntent.findMany({
            where: { bookId },
            orderBy: { createdAt: "desc" },
            take: 24,
            select: { id: true, instrumentId: true, state: true, side: true, quantity: true, filledQty: true },
        }),
        prisma.deskRecord.findMany({ where: { bookId, shiftId, kind: "consult" }, orderBy: { createdAt: "desc" }, take: 6 }),
    ]);
    const memory: Partial<Record<DeskRole, unknown>> = {},
        completed: Partial<Record<DeskRole, RoleNote>> = {};
    for (const role of deskRoles) {
        const past = notes.filter((n) => n.role === role);
        memory[role] = past
            .filter((n) => n.shiftId !== shiftId)
            .slice(0, 3)
            .map((n) => ({ at: n.createdAt, ...JSON.parse(n.dataJson) }));
        const latest = past.find((n) => n.shiftId === shiftId);
        if (latest) completed[role] = JSON.parse(latest.dataJson);
    }
    return {
        memory,
        completed,
        consultations: consults.reverse().map(c => JSON.parse(c.dataJson) as DeskConsultation),
        watches: watches.map(w=>({...watchView(w),instrument:w.instrumentId})),
        theses: theses.map((t) => JSON.parse(t.dataJson)),
        inventory: inventory.map((i) => ({
            instrument: i.instrumentId,
            quantity: i.quantity,
            suspended: i.suspended,
        })),
        intents,
    };
}

export async function runShift(book: DeskBook, shift: DeskShift, signal: AbortSignal, prepare?: (activeSignal: AbortSignal) => Promise<void>) {
    if (shift.bookId !== book.id) throw new Error("Shift does not belong to this book.");
    const stop = new AbortController();
    const cancel = () => stop.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) stop.abort();
    let renewing = false;
    const renew = setInterval(async () => {
        if (renewing) return;
        renewing = true;
        try {
            const now = new Date();
            const ok = await prisma.deskShift.updateMany({
                where: {
                    id: shift.id,
                    lease: shift.lease,
                    status: "running",
                    leaseUntil: { gt: now },
                    book: { version: shift.version, ...(shift.mode === "live" ? { enabled: true } : {}) },
                },
                data: { leaseUntil: new Date(+now + leaseMs) },
            });
            if (!ok.count) {
                stop.abort();
                return;
            }
            if (
                !JSON.parse(shift.briefJson).triggers.some(
                    (t: { kind: string }) => t.kind === "risk" || t.kind === "correction",
                )
            ) {
                const urgent = await prisma.deskWake.findFirst({
                    where: {
                        bookId: book.id,
                        version: shift.version,
                        priority: { gte: 10 },
                        shiftId: null,
                        dueAt: { lte: now },
                        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                    },
                });
                if (urgent) {
                    await prisma.deskShift.updateMany({
                        where: { id: shift.id, lease: shift.lease, status: "running" },
                        data: { status: "paused", lease: null, leaseUntil: null },
                    });
                    stop.abort();
                }
            }
        } catch {
            stop.abort();
        } finally {
            renewing = false;
        }
    }, 5000);
    try {
        const admission = await admitReview(book, shift, stop.signal);
        if (!admission.review) {
            await journalTransaction(prisma, book, shift, stop.signal, tx => tx.deskShift.updateMany({
                where: { id: shift.id, lease: shift.lease, status: "running" },
                data: { status: "deferred", endedAt: new Date(), leaseUntil: null },
            }));
            return;
        }
        const opening = admission.opening;
        shift.briefJson = JSON.stringify(opening);
        const activeRoles = routineRecipients(opening);
        if (prepare) await prepare(stop.signal);
        const { memory, completed, consultations, ...state } = await recoverContext(book.id, shift.id, shift.mode);
        const proposals = await loadTradeProposals(prisma, book, shift);
        const historicalReviews = await loadTradeProposalReviews(prisma, book, shift, proposals);
        const investigation = !activeRoles && !completed.catalyst
            ? await catalystInvestigation(prisma, book, shift) : null;
        const reusedCatalyst = await investigation?.reuse();
        // A reminder failure must not buy another model turn. Completed notes
        // also serve as a durable outbox for unfinished follow-up scheduling.
        for (const role of deskRoles) {
            const note = completed[role];
            if (note) await scheduleRoleFollowUp(prisma, book, shift, role, note, stop.signal);
        }
        const save = async (role: DeskRole, note: RoleNote) => {
            const saved = activeRoles && note.followUpAt ? {...note,followUpAt:null} : note;
            await checkpointRoleNote(prisma, book, shift, role, saved, stop.signal);
            await scheduleRoleFollowUp(prisma, book, shift, role, saved, stop.signal);
            if (role === "catalyst" && !reusedCatalyst) await investigation?.remember(note);
        };
        if (reusedCatalyst) {
            await save("catalyst", reusedCatalyst);
            completed.catalyst = reusedCatalyst;
        }
        // A model can invent a different ticket when replayed after a crash. Recover
        // the journal and exchange receipts, but never replay this shift's trading authority.
        const previousDispatch = await prisma.deskRecord.findFirst({
            where: { bookId: book.id, shiftId: shift.id, kind: "dispatch" },
            select: { key: true },
        });
        const featureSnapshotId = opening.triggers?.find((t: { kind: string }) => t.kind === "opportunity_scan")?.payload?.snapshotId;
        const marketContext = opening.admission?.requiredWorkOnly || opening.triggers?.some((t: { priority?: number }) => (t.priority ?? 0) >= 10)
            ? null : await captureReviewContext(book, shift, featureSnapshotId).catch(() => null);
        stop.signal.throwIfAborted();
        const tools = deskTools(book, shift, marketContext?.evidenceId);
        const portfolio = await portfolioContext(prisma, book);
        const portfolioReviewReuse = opening.triggers?.every((t: { kind: string }) => t.kind === "opportunity_scan")
            ? await recentPortfolioCoverage(prisma, book, portfolio) : null;
        await runRoundtable({
            onActivity: async (event) => {
                const dataJson = JSON.stringify({ ...event, attempt: shift.attempts,
                    runId: createHash("sha256").update(shift.lease ?? "").digest("hex") });
                await prisma.deskRecord.upsert({
                    where: { bookId_key: { bookId: book.id, key: "activity:" + event.invocationId } },
                    create: { bookId: book.id, shiftId: shift.id, key: "activity:" + event.invocationId,
                        kind: "role_activity", role: event.role, dataJson },
                    update: { dataJson },
                });
            },
            sharedObservations: tools.sharedObservations,
            refreshContext: async () => {
                const [profile, protection, allocation] = await Promise.all([strategyProfile(prisma, book), readProtectionStatus(prisma, book), allocationContext(prisma, book)]);
                await prisma.deskRecord.upsert({ where: { bookId_key: { bookId: book.id, key: allocation.evidenceId } }, update: {},
                    create: { bookId: book.id, shiftId: shift.id, key: allocation.evidenceId, kind: "allocation_context", role: "host", dataJson: JSON.stringify(allocation) } });
                return { strategyProfile: profile, protection, allocationContext: allocation };
            },
            bookId: book.id,
            shiftId: shift.id,
            brief: {
                ...opening,
                ...(marketContext ? { marketContext } : {}),
                mandate: JSON.parse(book.mandateJson),
                riskPolicy: bookRiskContext(book),
                protection: await readProtectionStatus(prisma, book),
                portfolio,
                portfolioReviewReuse,
                researchBacklog: await researchBacklog(prisma, book),
                workLedger: await workBrief(prisma,book,shift.mode),
                agenda: activeRoles
                    ? "Review the requesting roles’ due work once. Further routine wakes require a fresh external event. Record the outcome and return followUpAt=null."
                    : "Event owners originate relevant ideas. The lead prioritizes the shared proposals and requests only the specialists needed for a concrete unresolved question. Execution and risk checks are not automatic model turns; enforced host checks always apply.",
                ...state,
                resuming: shift.attempts > 1 || !!previousDispatch,
                executionStatus: previousDispatch
                    ? "A prior attempt may already have reached the venue. Reconcile receipts and finish this review without resubmitting."
                    : "Normal",
            },
            mode: shift.mode === "live" ? "live" : "research",
            memory,
            completed,
            consultations,
            proposals,
            historicalReviews,
            saveProposal: (draft, role) => saveTradeProposal(prisma, book, shift, role, draft, stop.signal),
            activeRoles: activeRoles ?? undefined,
            save,
            recordConsult: async (entry) => {
                const identity = [entry.requester, entry.colleague, entry.question, entry.proposalKey, entry.proposalRevision];
                const key = shift.id + ":consult:" + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
                await journalTransaction(prisma, book, shift, stop.signal, async tx => {
                    await record(tx, book.id, shift.id, key, "consult", entry.requester, entry);
                    await recordProposalReview(tx, book, shift, entry, key);
                });
                // A targeted answer is not a full catalyst investigation and must
                // never populate the broad cross-shift investigation cache.
            },
            tools: previousDispatch ? tools.filter((t) => t.access === "read" || t.access === "journal") : tools,
            signal: stop.signal,
        });
        const endedAt = new Date();
        await prisma.$transaction(async (tx) => {
            const finished = await tx.deskShift.updateMany({
                where: { id: shift.id, lease: shift.lease, status: "running" },
                data: { status: "completed", endedAt, leaseUntil: null, error: null },
            });
            if (finished.count) await finishOpportunityReview(tx, book, shift, endedAt);
            const coveredPortfolio = finished.count && !activeRoles && shift.mode === "live"
                ? await savePortfolioCoverage(tx, book, shift.id, endedAt) : false;
            const recoveredWarning = isDeskDatabaseBusy(book.lastError) || ["Codex App Server disconnected",
                "Codex desk turn timed out", "Codex desk turn exceeded its wall-time limit"].some(message => book.lastError?.includes(message));
            if (finished.count && recoveredWarning) {
                // Compare the saved warning so a newer failure survives this recovery.
                await tx.deskBook.updateMany({
                    where: { id: book.id, version: shift.version, lastError: book.lastError },
                    data: { lastError: null },
                });
            }
            if (finished.count && !activeRoles && shift.mode === "live" &&
                (coveredPortfolio || (opening.verifiedFlat &&
                (!opening.triggers?.some((t: { kind: string }) => t.kind === opportunityScanKind) ||
                 opening.triggers.some((t: { kind: string }) => t.kind === "scheduled"))))) {
                // If a sweep arrived during this roundtable or is about to start,
                // this portfolio review covers it. Keep independently timed news
                // deadlines and operator instructions in the inbox.
                const adjacent = new Date(+endedAt + Math.min(60_000, book.frequencySeconds * 250));
                await tx.deskBook.updateMany({
                    where: { id: book.id, version: shift.version, enabled: true, nextReviewAt: { lte: adjacent } },
                    data: { nextReviewAt: new Date(+endedAt + (opening.reviewIntervalSeconds ?? book.frequencySeconds) * 1000) },
                });
                await tx.deskWake.updateMany({
                    where: {
                        bookId: book.id,
                        version: shift.version,
                        mode: "live",
                        kind: "scheduled",
                        key: { startsWith: "review:" },
                        shiftId: null,
                        dueAt: { lte: adjacent },
                    },
                    data: { shiftId: shift.id },
                });
            }
        });
    } catch (error) {
        clearInterval(renew);
        const message = deskErrorMessage(error);
        try {
            await prisma.deskShift.updateMany({
                where: { id: shift.id, lease: shift.lease, status: "running" },
                data: {
                    ...(shift.attempts >= 3 ? { status: "failed", endedAt: new Date() } : {}),
                    error: message,
                    leaseUntil: new Date(Date.now() + 15000),
                },
            });
        } catch (reportError) {
            // If storage is still locked, the existing lease expires naturally.
            // Preserve the actual failure instead of replacing it with this write.
            console.warn("[Trading desk] Could not save shift failure:", deskErrorMessage(reportError));
            if (isDeskStorageCorruption(reportError)) throw reportError;
        }
        throw error;
    } finally {
        clearInterval(renew);
        signal.removeEventListener("abort", cancel);
    }
}
