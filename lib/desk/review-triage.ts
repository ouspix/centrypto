import "server-only";
import { captureReviewContext } from "./market-context";
import { createHash } from "node:crypto";
import type { DeskBook, DeskShift } from "@prisma/client";
import { prisma } from "@/lib/db";
import { record, queueWake } from "./books";
import { journalTransaction } from "./journal";
import { discoveryStateKey, syncDiscoveryReviews } from "./review-memory";
import { discoveryFreshnessMs, discoveryInstrumentCooldownMs, materialDiscoveryChanges, type DiscoveryState } from "./discovery-queue";
import { instrument, publicQuote } from "./market";
import { bandLiquidity } from "./liquidity";
import { parseDeskMandate, bookRiskContext } from "./mandate";
import { LIVE_ORDER_STATES } from "./execution-risk";
import { newsExposure } from "./news-exposure";
import { portfolioContext } from "./portfolio-context";
import { codexDeskTransport, type DeskTransport } from "./runtime";
import { decodeTriage, isOpportunityTrigger, opportunityCandidateIds, scopeOpportunityTrigger, reusableTriage, triageInstructions, triageLimits, triageSchema,
    type ReviewTrigger, type TriageCandidate, type TriageCheckpoint, type TriageVerdict } from "./review-admission";

type TriageState = { nextAt: number; failures: number; decisions: Record<string, TriageCheckpoint> };
export const reviewTriageEnabled = () => process.env.DESK_REVIEW_TRIAGE !== "off";

/** Split mandatory work from unrelated discovery without waiting on the model or
 * venue. Original wake evidence/deadlines are retained; retries reuse one wake.
 */
async function requiredReview(book: DeskBook, shift: DeskShift, signal: AbortSignal, opening: any,
    mandatory: ReviewTrigger[], opportunities: ReviewTrigger[], requiredIds: Set<string>) {
    const deferredIds = new Set(opportunities.flatMap(opportunityCandidateIds).filter(id => !requiredIds.has(id)));
    const scoped = opportunities.flatMap(t => { const scoped = scopeOpportunityTrigger(t, requiredIds); return scoped ? [scoped] : []; });
    const next = { ...opening, triggers: [...mandatory, ...scoped], admission: {
        requiredWorkOnly: true, requiredInstrumentIds: [...requiredIds], deferredInstrumentIds: [...deferredIds],
        candidates: [], cheapChecks: [], modelCalled: false, failure: null,
        instruction: "Handle the required events and existing exposure now. Unrelated opportunity candidates are queued separately for admission. Do not refill this review with a fresh market screen or discretionary new-entry comparisons. This does not restrict protective actions, event-specific investigation or explicit operator instructions.",
    } };
    await journalTransaction(prisma, book, shift, signal, async tx => {
        for (const t of opportunities) {
            const deferred = scopeOpportunityTrigger(t, deferredIds);
            if (!deferred) continue;
            const source = await tx.deskWake.findFirst({ where: { id: t.id, bookId: book.id, version: book.version } });
            if (!source || (source.expiresAt && +source.expiresAt <= Date.now())) continue;
            const rootId = t.payload.admissionSourceWakeId ?? source.id;
            const payload = { ...deferred.payload, admissionSourceWakeId: rootId };
            const dueAt = new Date(Date.now() + 5000);
            if (source.key === `candidate-admission:${rootId}`) {
                await tx.deskWake.updateMany({ where: { id: source.id, shiftId: shift.id },
                    data: { shiftId: null, dueAt, payload: JSON.stringify(payload) } });
            } else {
                await queueWake(tx, book, `candidate-admission:${rootId}`, source.kind, "live", payload,
                    Math.min(source.priority, 6), dueAt, source.expiresAt);
            }
        }
        await tx.deskShift.updateMany({ where: { id: shift.id, lease: shift.lease, status: "running" }, data: { briefJson: JSON.stringify(next) } });
        await record(tx, book.id, shift.id, `review-admission:${shift.id}`, "review_admission", "host", {
            ...next.admission, accepted: [], decision: "required_review", at: new Date().toISOString(),
        });
    });
    return { review: true, opening: next };
}

async function liquidity(book: DeskBook, id: string): Promise<NonNullable<TriageCandidate["liquidity"]>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            (async () => {
                const item = await instrument(book.isTestnet, id);
                if (item.kind !== "perp" || item.quote !== "USDC") throw new Error("Not a native USDC perp");
                const q = await publicQuote(item, book.isTestnet, true);
                const band = bandLiquidity({ time: q.time, levels: [q.bids, q.asks] }, parseDeskMandate(book.mandateJson), 1);
                return { status: [band.bids, band.asks].some(s => s.status === "insufficient") ? "insufficient" as const :
                    [band.bids, band.asks].every(s => s.status === "sufficient") ? "sufficient" as const : "unavailable" as const,
                    at: q.time, bidUsd: band.bids.observedDepthUsd!, askUsd: band.asks.observedDepthUsd! };
            })(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Liquidity preflight timeout")), 8000); }),
        ]);
    } catch { return { status: "unavailable", at: Date.now() }; }
    finally { clearTimeout(timer); }
}

/** Runs before loading full desk context. It cannot submit orders and shares the
 * shift's revocable lease and urgent-event cancellation, while execution runs independently. */
export async function admitReview(book: DeskBook, shift: DeskShift, signal: AbortSignal,
    transport: DeskTransport = codexDeskTransport): Promise<{ review: boolean; opening: any }> {
    const opening = JSON.parse(shift.briefJson);
    const triggers: ReviewTrigger[] = opening.triggers ?? [];
    const bypass = { review: true, opening };
    if (!reviewTriageEnabled() || shift.mode !== "live" || book.kind !== "directional" || !triggers.length) return bypass;
    // Recovery of an already-started full review keeps its existing safety semantics.
    if (await prisma.deskRecord.count({ where: { bookId: book.id, shiftId: shift.id, kind: { in: ["note", "dispatch"] } } })) return bypass;
    const mandatory = triggers.filter(t => !isOpportunityTrigger(t));
    const scheduled = mandatory.filter(t => t.kind === "scheduled" && (t.priority ?? 0) < 10);
    const immediate = mandatory.filter(t => !scheduled.includes(t));
    const opportunities = triggers.filter(isOpportunityTrigger);
    const nominees = opportunities.flatMap(t => t.kind === "opportunity_scan" ? t.payload.comparisonBrief?.candidates ?? [] :
        t.kind === "market_move" ? t.payload.moves.map((m: { instrumentId: string }) => ({ ...m, nominatedFrom: "market_move" })) :
            t.kind === "watch" ? [{ instrumentId: t.payload.instrumentId, nominatedFrom: "depth_recovery" }] : []);
    const unique = [...new Map<string, any>(nominees.map((c: any) => [c.instrumentId, c])).values()];
    const ids = unique.map(c => c.instrumentId);
    const [inventory, pending] = await Promise.all([
        prisma.deskInventory.findMany({ where: { bookId: book.id, instrumentId: { in: ids }, OR: [{ quantity: { not: 0 } }, { suspended: true }] }, select: { instrumentId: true } }),
        prisma.deskIntent.findMany({ where: { bookId: book.id, instrumentId: { in: ids }, OR: [{ reservedUsd: { gt: 0 } }, { state: { in: LIVE_ORDER_STATES } }] }, select: { instrumentId: true } }),
    ]);
    const requiredIds = new Set([...inventory, ...pending].map(r => r.instrumentId));
    // Mandatory work never waits on an exposure HTTP request or triage. Unknown
    // market exposure still gets its original full review, scoped to those moves.
    if (!mandatory.length && opportunities.some(t => t.kind === "market_move")) {
        const exposure = await newsExposure(book);
        for (const t of opportunities.filter(t => t.kind === "market_move"))
            for (const id of opportunityCandidateIds(t))
                if (exposure.coverage.needsReconciliation || exposure.heldIds.includes(id)) requiredIds.add(id);
    }
    if (immediate.length || (requiredIds.size && (!scheduled.length || opportunities.some(t => t.kind !== "opportunity_scan"))))
        return requiredReview(book, shift, signal, opening, mandatory, opportunities, requiredIds);
    // Ordinary scheduled portfolio work can share its review with admitted discovery.
    // Never defer it into a second five-second wake or make urgent work wait for triage.
    if (scheduled.length && !opportunities.length) return requiredReview(book, shift, signal, opening, scheduled, [], requiredIds);
    await journalTransaction(prisma, book, shift, signal, tx => syncDiscoveryReviews(tx, book));
    const stored = await prisma.deskRecord.findUnique({ where: { bookId_key: discoveryStateKey(book) } });
    const scan: DiscoveryState | null = stored ? JSON.parse(stored.dataJson) : null;
    const now = Date.now();
    const watches = await prisma.deskWatch.findMany({ where: { bookId: book.id, instrumentId: { in: ids }, mode: "live",
        kind: "pass", status: "open", deadline: { gt: new Date(now) }, key: { startsWith: `routine:lead:${book.version}:live:` },
    }, orderBy: { createdAt: "desc" } });
    const depthWatch = new Map<string, boolean>();
    for (const w of watches) if (!depthWatch.has(w.instrumentId!)) {
        const data = JSON.parse(w.outcomeJson ?? "{}");
        depthWatch.set(w.instrumentId!, !data.monitoringDisabled &&
            (["both_depth", "bid_depth", "ask_depth"].includes(data.revisitWhen) || !!data.depthBlockedAt));
    }
    const cheap: Array<{ instrumentId: string; reason: string }> = [];
    const candidates: TriageCandidate[] = [];
    let depthReads = 0;
    for (const n of unique) {
        const id = n.instrumentId, previous = scan?.reviews[id] ?? null;
        // The scheduled portfolio assessment already owns these holdings. Triage
        // only the unrelated new candidates, without creating a second review.
        if (requiredIds.has(id)) continue;
        if (!id.startsWith(book.isTestnet ? "testnet:perp:" : "mainnet:perp:")) {
            cheap.push({ instrumentId: id, reason: "Outside the native perpetual discovery universe" }); continue;
        }
        const recovery = triggers.some(t => t.kind === "watch" && t.payload.instrumentId === id);
        if (!recovery && previous && now - previous.reviewedAt < discoveryInstrumentCooldownMs) {
            cheap.push({ instrumentId: id, reason: "Already investigated within the shared ten-minute cooldown" }); continue;
        }
        const row = scan?.candidates[id]?.observation;
        const current = row && now - row.observedAt <= discoveryFreshnessMs ? row : null;
        if (n.nominatedFrom !== "market_move" && !recovery && !current) {
            cheap.push({ instrumentId: id, reason: "Discovery evidence is no longer fresh" }); continue;
        }
        if (candidates.length >= triageLimits.candidates) {
            cheap.push({ instrumentId: id, reason: "Bounded batch capacity; retain continuous monitoring" }); continue;
        }
        const needsDepth = depthWatch.get(id) || recovery;
        if (needsDepth && depthReads >= triageLimits.candidates) {
            cheap.push({ instrumentId: id, reason: "Bounded liquidity preflight capacity" }); continue;
        }
        if (needsDepth) depthReads++;
        const check = needsDepth ? await liquidity(book, id) : undefined;
        signal.throwIfAborted();
        if (check?.status === "insufficient" || (recovery && check?.status !== "sufficient")) {
            cheap.push({ instrumentId: id, reason: check?.status === "insufficient" ? "Fresh complete liquidity still fails entry or exit depth" : "Liquidity recovery is unconfirmed" }); continue;
        }
        candidates.push({ instrumentId: id, nomination: n.nominatedFrom ?? "market_change", changes: n.changes ??
            (Number.isFinite(n.move) ? [{ field: "fiveMinuteMove", before: n.previous, after: n.mid, fraction: n.move }] : []),
            current: current ? { observedAt: current.observedAt, price: current.price, setup: current.setup, return1hBps: current.return1hBps,
                return4hBps: current.return4hBps, oiChange1hPct: current.oiChange1hPct, fundingHourly: current.fundingHourly } : null,
            previous, liquidity: check });
    }
    const portfolio = await portfolioContext(prisma, book);
    // Admission reuse must not carry a full-book objection through an exit (or
    // a flat-book approval through a fill). Clocks alone do not invalidate it.
    const portfolioFingerprint = createHash("sha256").update(JSON.stringify({ capacity: portfolio.capacity,
        reconciled: portfolio.reconciledRecently, holdings: portfolio.holdings.map(p => ({ instrumentId: p.instrumentId, quantity: p.quantity,
            stopPrice: p.stopPrice, originalExitDeadline: p.originalExitDeadline })).sort((a, b) => a.instrumentId.localeCompare(b.instrumentId)) })).digest("hex");
    const key = { bookId: book.id, key: `review-triage-state:${book.version}` };
    const saved = await prisma.deskRecord.findUnique({ where: { bookId_key: key } });
    const state: TriageState = saved ? JSON.parse(saved.dataJson) : { nextAt: 0, failures: 0, decisions: {} };
    const verdicts: TriageVerdict[] = [];
    const fresh = candidates.filter(c => {
        const cached = state.decisions[c.instrumentId];
        if (cached?.portfolioFingerprint !== portfolioFingerprint || !reusableTriage(cached, c, now)) return true;
        verdicts.push(cached); return false;
    });
    let failure: string | null = null, modelCalled = false;
    if (fresh.length && now >= state.nextAt) {
        // Reserve before inference. Restarts cannot silently buy another triage turn.
        state.nextAt = now + triageLimits.intervalMs;
        await journalTransaction(prisma, book, shift, signal, tx => tx.deskRecord.upsert({ where: { bookId_key: key },
            create: { ...key, kind: "review_triage_state", role: "host", dataJson: JSON.stringify(state) },
            update: { dataJson: JSON.stringify(state) } }));
        try {
            const marketContext = await captureReviewContext(book, shift, scan?.snapshotId ?? undefined).catch(() => null);
            signal.throwIfAborted();
            const triageInput = { asOf: new Date(now).toISOString(), riskPolicy: bookRiskContext(book), portfolio, candidates: fresh };
            const enriched = JSON.stringify({ ...triageInput, ...(marketContext ? { marketContext } : {}) });
            const input = enriched.length + triageInstructions.length <= triageLimits.inputCharacters ? enriched : JSON.stringify(triageInput);
            modelCalled = true;
            const text = await transport({ role: "lead", shiftId: shift.id, meter: { kind: "triage", bookId: book.id },
                effort: "low", tools: [], signal, instructions: triageInstructions,
                input, schema: triageSchema,
                budget: triageLimits });
            const result = decodeTriage(text, fresh);
            verdicts.push(...result); state.failures = 0;
            for (const v of result) {
                const c = fresh.find(c => c.instrumentId === v.instrumentId)!;
                state.decisions[v.instrumentId] = { ...v, at: Date.now(), reviewedAt: c.previous?.reviewedAt ?? 0,
                    summaryAt: c.previous?.summaryAt, observed: c.current, portfolioFingerprint };
            }
        } catch (error) {
            signal.throwIfAborted();
            failure = error instanceof Error ? error.message.slice(0, 200) : "Triage unavailable";
            state.failures = Math.min(state.failures + 1, 3);
            state.nextAt = Date.now() + triageLimits.intervalMs * 2 ** state.failures;
        }
    } else for (const c of fresh) cheap.push({ instrumentId: c.instrumentId, reason: "Shared triage budget cooling down" });
    const accepted = new Set([...requiredIds, ...verdicts.filter(v => v.decision === "review").map(v => v.instrumentId)]);
    // A recovery may disappear while the small model runs. Verify before buying
    // full analysis, using the same depth arithmetic as the execution mandate.
    for (const t of triggers.filter(t => t.kind === "watch" && accepted.has(t.payload.instrumentId))) {
        if ((await liquidity(book, t.payload.instrumentId)).status !== "sufficient") {
            accepted.delete(t.payload.instrumentId);
            cheap.push({ instrumentId: t.payload.instrumentId, reason: "Liquidity recovery did not survive triage" });
        }
    }
    const latestRecord = accepted.size ? await prisma.deskRecord.findUnique({ where: { bookId_key: discoveryStateKey(book) } }) : null;
    const latest: DiscoveryState | null = latestRecord ? JSON.parse(latestRecord.dataJson) : null;
    for (const c of candidates.filter(c => accepted.has(c.instrumentId) && c.nomination !== "market_move" && c.nomination !== "depth_recovery")) {
        const point = latest?.candidates[c.instrumentId]?.observation;
        if (!point || Date.now() - point.observedAt > discoveryFreshnessMs ||
            (c.current && (materialDiscoveryChanges(c.current, point).length ||
                (c.current.price && Math.abs(point.price / c.current.price - 1) >= .01)))) {
            accepted.delete(c.instrumentId);
            cheap.push({ instrumentId: c.instrumentId, reason: "Discovery evidence expired or changed materially during triage" });
        }
    }
    const admitted = triggers.flatMap(t => {
        if (t.kind === "opportunity_scan") {
            const selected = t.payload.comparisonBrief.candidates.filter((c: { instrumentId: string }) => accepted.has(c.instrumentId) &&
                latest?.candidates[c.instrumentId] && Date.now() - latest.candidates[c.instrumentId].observation.observedAt <= discoveryFreshnessMs)
                .map((c: { instrumentId: string }) => {
                    const p = latest!.candidates[c.instrumentId].observation;
                    return { ...c, setup: p.setup, observedAt: new Date(p.observedAt).toISOString(), return1hBps: p.return1hBps, return4hBps: p.return4hBps,
                        fundingHourly: p.fundingHourly, oiChange1hPct: p.oiChange1hPct, relativeBtcBps: p.relativeBtcBps };
                });
            return selected.length ? [{ ...t, payload: { ...t.payload, asOf: new Date(latest!.scannedAt).toISOString(),
                evidenceKey: `opportunity-scan:${book.version}:${latest!.scannedAt}`,
                comparisonBrief: { ...t.payload.comparisonBrief, candidates: selected }, triage: verdicts } }] : [];
        }
        if (t.kind === "market_move") {
            const moves = t.payload.moves.filter((c: { instrumentId: string }) => accepted.has(c.instrumentId));
            return moves.length ? [{ ...t, payload: { ...t.payload, moves, triage: verdicts } }] : [];
        }
        return t.kind === "watch" && accepted.has(t.payload.instrumentId) ? [t] : [];
    });
    const result = { review: scheduled.length > 0 || admitted.length > 0, opening: { ...opening, triggers: [...scheduled, ...admitted],
        discoveryScanAt: admitted.some(t => t.kind === "opportunity_scan") ? latest?.scannedAt ?? null : opening.discoveryScanAt,
        admission: { candidates: verdicts, cheapChecks: cheap, modelCalled, failure, scheduledPortfolioReview: scheduled.length > 0,
            requiredWorkOnly: scheduled.length > 0 && admitted.length === 0,
            instruction: scheduled.length ? "Complete the scheduled portfolio assessment and admitted candidate questions together. Do not repeat a broad screen or refill the slate with deferred candidates. A failed or empty admission does not cancel portfolio work." : undefined } } };
    await journalTransaction(prisma, book, shift, signal, async tx => {
        state.decisions = Object.fromEntries(Object.entries(state.decisions).filter(([, v]) => Date.now() - v.at < 86400000));
        await tx.deskRecord.upsert({ where: { bookId_key: key }, create: { ...key, kind: "review_triage_state", role: "host", dataJson: JSON.stringify(state) },
            update: { dataJson: JSON.stringify(state) } });
        await record(tx, book.id, shift.id, `review-admission:${shift.id}`, "review_admission", "host", {
            ...result.opening.admission, accepted: [...accepted], decision: result.review ? "review" : "monitor", at: new Date().toISOString(),
        });
        for (const t of triggers.filter(t => t.kind === "watch" && !accepted.has(t.payload.instrumentId))) {
            const watch = await tx.deskWatch.findFirst({ where: { id: t.payload.watchId, bookId: book.id, kind: "pass", status: "open", deadline: { gt: new Date() } } });
            if (!watch) continue;
            const outcome = JSON.parse(watch.outcomeJson ?? "{}");
            delete outcome.depthReopenedAt;
            outcome.admissionRetryAt = Date.now() + (verdicts.some(v => v.instrumentId === watch.instrumentId && v.decision === "monitor") ? triageLimits.deferMs : 60000);
            await tx.deskWatch.updateMany({ where: { id: watch.id, outcomeJson: watch.outcomeJson }, data: { outcomeJson: JSON.stringify(outcome) } });
        }
        // Wake rows retain the original events. Persist the narrower model brief
        // so recovery and comparison bookkeeping use the evidence actually supplied.
        if (result.review) await tx.deskShift.updateMany({ where: { id: shift.id, lease: shift.lease, status: "running" },
            data: { briefJson: JSON.stringify(result.opening) } });
    });
    return result;
}
