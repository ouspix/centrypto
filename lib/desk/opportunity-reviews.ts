import "server-only";
import type { DeskBook, DeskShift, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { queueWake, record } from "./books";
import { featureDiscovery } from "./market-context";
import { contextMode } from "./market-snapshots";
import { parseScreenQuery, rankScreen } from "./market-screen";
import type { DiscoverySetup } from "./discovery";
import { readDiscoveryScan } from "./discovery-scan";
import { syncDiscoveryReviews } from "./review-memory";
import {
    advanceDiscovery, selectDiscoveryBatch, discoveryFreshnessMs, discoveryRetentionMs,
    discoveryReviewIntervalMs, type DiscoveryState,
} from "./discovery-queue";

export const opportunityScanKind = "opportunity_scan";
export const discoveryMode = () => process.env.DESK_DISCOVERY_MODE ?? "live";
const stateKey = (book: DeskBook) => ({ bookId: book.id, key: `opportunity-state:${book.version}` });
const scanKey = (book: DeskBook, at: number) => `opportunity-scan:${book.version}:${at}`;

export async function monitorOpportunities(book: DeskBook, signal: AbortSignal) {
    const started = Date.now();
    const legacy = await readDiscoveryScan(book.isTestnet);
    const mode = contextMode();
    const input = mode !== "legacy" ? await featureDiscovery(book.isTestnet).catch(() => null) : null;
    const result = input ? rankScreen(input.snapshot, parseScreenQuery({}), input.catalysts, input.at) : null;
    const top = result?.candidates.slice(0, 10) ?? [];
    const setups = new Map(result?.candidates.map((c, index) => {
        const distance = c.direction === "long" ? c.values.highDistanceAtr : c.values.lowDistanceAtr;
        const setup: DiscoverySetup | null = c.view === "custom" ? null : {
            view: c.view, side: c.direction, boundary: c.direction === "long" ? c.priorHigh : c.priorLow,
            beyond: distance == null ? null : distance > 0, displacement: distance ?? c.values.displacementAtr,
            eventKey: c.catalyst?.eventKey,
        };
        return [c.instrumentId, { setup, score: result.candidates.length - index }] as const;
    }) ?? []);
    const scan = mode === "enabled" && input && result && result.coverage.structural > 0 ? {
        ...legacy, featureVersion: 1, snapshotId: input.snapshot.id,
        priorityIds: top.map(row => row.instrumentId),
        coverage: legacy.coverage.map(row => row.status === "observed" ?
            { ...row, ...(setups.get(row.instrumentId) ?? { setup: null, score: 0 }) } : row),
    } : legacy;
    signal.throwIfAborted();
    const now = Date.now();
    const key = stateKey(book);
    await prisma.$transaction(async tx => {
        if (!await tx.deskBook.count({ where: { id: book.id, version: book.version, enabled: true } })) return;
        await syncDiscoveryReviews(tx, book);
        const stored = await tx.deskRecord.findUnique({ where: { bookId_key: key } });
        const prior = stored ? JSON.parse(stored.dataJson) as DiscoveryState : null;
        const next = advanceDiscovery(prior, scan, now);
        if (next) {
            const dataJson = JSON.stringify(next);
            if (stored) {
                const updated = await tx.deskRecord.updateMany({ where: { id: stored.id, dataJson: stored.dataJson }, data: { dataJson } });
                if (!updated.count) return; // A claim or review changed the checkpoint. Read it next cycle.
            } else {
                const created = await tx.deskRecord.upsert({ where: { bookId_key: key }, update: {},
                    create: { ...key, dataJson, kind: "opportunity_state", role: "host" } });
                if (created.dataJson !== dataJson) return;
            }
        }
        const current = next ?? prior!;
        const active = await tx.deskShift.findFirst({ where: { bookId: book.id, status: "running" }, select: { createdAt: true } });
        const dispatchable = selectDiscoveryBatch(current, now);
        await record(tx, book.id, null, scanKey(book, now), opportunityScanKind, "host", {
            ...(mode === "shadow" ? { shadow: { status: result ? "observed" : "unavailable",
                featureDurationMs: input?.snapshot.durationMs ?? null, coverage: result?.coverage ?? null,
                legacy: legacy.priorityIds, candidates: top.map(c => ({ instrumentId: c.instrumentId, view: c.view, direction: c.direction })),
            } } : {}),
            featureVersion: scan.featureVersion, snapshotId: scan.snapshotId,
            scannedAt: now, durationMs: now - started, unchanged: !next, coverage: current.coverage,
            newestObservationAt: Math.max(0, ...Object.values(current.candidates).map(c => c.observation.observedAt)) || null,
            activeReviewAt: active?.createdAt ?? null,
            deferral: !current.coverage.scanned ? "unavailable" : active ? "active_review" :
                current.lastDispatchedAt !== null && now - current.lastDispatchedAt < discoveryReviewIntervalMs ? "review_interval" :
                dispatchable.length ? null : "no_eligible_candidates",
            nominations: Object.values(current.candidates).filter(c => c.qualifiedAt !== null)
                .map(c => ({ instrumentId: c.observation.instrumentId, qualifiedAt: c.qualifiedAt, reason: c.reason })),
            removed: Object.keys(prior?.candidates ?? {}).filter(id => prior?.candidates[id].qualifiedAt !== null &&
                !current.candidates[id]?.qualifiedAt),
            ...(next ? { observations: scan.coverage.map(row => row.status === "observed" ? [row.instrumentId, row.observedAt,
                row.return1hBps, row.return4hBps, row.relativeBtcBps, row.relativeEthBps, row.oiChange1hPct, row.fundingHourly, row.setup] : [row.instrumentId, null]) } : {}),
        });
        await tx.deskRecord.deleteMany({ where: { bookId: book.id, kind: { in: [opportunityScanKind, "opportunity_review", "review_admission"] },
            createdAt: { lt: new Date(now - discoveryRetentionMs) } } });
    }, { timeout: 8000 });
}

/** Claims spend the budget only when the same transaction assigns the wake to a shift. */
export async function claimOpportunityWake(tx: Prisma.TransactionClient, book: DeskBook, now: Date) {
    const none = { wake: null, scanAt: null };
    if (book.kind !== "directional" || discoveryMode() !== "live") return none;
    await syncDiscoveryReviews(tx, book);
    const stored = await tx.deskRecord.findUnique({ where: { bookId_key: stateKey(book) } });
    if (!stored) return none;
    const state = JSON.parse(stored.dataJson) as DiscoveryState;
    const scanAt = +now - state.scannedAt <= discoveryFreshnessMs ? state.scannedAt : null;
    const candidates = selectDiscoveryBatch(state, +now);
    if (!candidates.length) return { wake: null, scanAt };
    const next = { ...state, lastDispatchedAt: +now, delivered: { ...state.delivered } };
    for (const candidate of candidates) next.delivered[candidate.instrumentId] = +now;
    const changed = await tx.deskRecord.updateMany({ where: { id: stored.id, dataJson: stored.dataJson }, data: { dataJson: JSON.stringify(next) } });
    if (!changed.count) return none;
    const wake = await queueWake(tx, book, `opportunity:${book.version}:${+now}`, opportunityScanKind, "live", {
        status: "research_candidates", asOf: new Date(state.scannedAt).toISOString(), evidenceKey: scanKey(book, state.scannedAt),
        ...state.coverage,
        snapshotId: state.snapshotId,
        comparisonBrief: { candidates: candidates.map(c => ({ instrumentId: c.instrumentId, symbol: c.symbol,
            setup: c.setup, nominatedFrom: c.reason, observedAt: new Date(c.observedAt).toISOString(), return1hBps: c.return1hBps,
            return4hBps: c.return4hBps, relativeBtcBps: c.relativeBtcBps, fundingHourly: c.fundingHourly,
            oiChange1hPct: c.oiChange1hPct, changes: c.changes, queueDelayMs: c.qualifiedAt === null ? null : +now - c.qualifiedAt,
        })) },
    }, 5, now, new Date(+now + discoveryFreshnessMs));
    return { wake, scanAt };
}

export async function finishOpportunityReview(tx: Prisma.TransactionClient, book: DeskBook, shift: DeskShift, endedAt: Date) {
    if (shift.mode !== "live") return;
    const opening = JSON.parse(shift.briefJson);
    const trigger = opening.triggers?.find((t: { kind: string }) => t.kind === opportunityScanKind);
    const scanAt: number | null = opening.discoveryScanAt ?? null;
    await syncDiscoveryReviews(tx, book);
    const comparison = await tx.deskRecord.findUnique({ where: { bookId_key: { bookId: book.id, key: `candidate-comparison:${shift.id}:lead` } } });
    const investigated: string[] = comparison ? JSON.parse(comparison.dataJson).candidates
        .filter((c: { stage: string }) => c.stage === "investigated").map((c: { instrumentId: string }) => c.instrumentId) : [];
    if (trigger) await record(tx, book.id, shift.id, `opportunity-review:${shift.id}`, "opportunity_review", "host", {
        scanAt, completedAt: endedAt, investigated, candidates: trigger.payload.comparisonBrief.candidates,
        comparisonRecorded: !!comparison,
    });
}
