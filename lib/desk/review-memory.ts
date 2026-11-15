import "server-only";
import type { DeskBook, Prisma } from "@prisma/client";
import type { CandidateComparison } from "./candidate-comparison";
import type { DiscoveryBaseline, DiscoveryState } from "./discovery-queue";

export const discoveryStateKey = (book: DeskBook) => ({ bookId: book.id, key: `opportunity-state:${book.version}` });

/** The journal, rather than availability of a collector snapshot, establishes that
 * an investigation happened. The cursor also imports recent pre-rollout reviews. */
export async function syncDiscoveryReviews(tx: Prisma.TransactionClient, book: DeskBook) {
    const key = discoveryStateKey(book);
    for (let attempt = 0; attempt < 3; attempt++) {
        const stored = await tx.deskRecord.findUnique({ where: { bookId_key: key } });
        const state: DiscoveryState = stored ? JSON.parse(stored.dataJson) : {
            scannedAt: 0, candidates: {}, reviews: {}, delivered: {}, lastDispatchedAt: null,
            rotationIds: [], coverage: { eligible: 0, scanned: 0, unavailable: 0 },
        };
        const cursor = state.reviewMemoryVersion === 1 ? state.reviewCursor ?? 0 : 0;
        const rows = await tx.deskRecord.findMany({ where: { bookId: book.id,
            id: { gt: cursor }, createdAt: { gte: new Date(Date.now() - 86400000) },
            kind: { in: ["candidate_comparison", "note"] }, shiftId: { not: null },
        }, orderBy: { id: cursor ? "asc" : "desc" }, take: 200 });
        rows.sort((a, b) => a.id - b.id);
        if (!rows.length) return;
        const shifts = await tx.deskShift.findMany({ where: { bookId: book.id, version: book.version, mode: "live",
            id: { in: [...new Set(rows.map(r => r.shiftId!))] }, status: { in: ["running", "paused", "completed"] },
        } });
        const openings = new Map(shifts.map(s => [s.id, JSON.parse(s.briefJson)]));
        const scanKeys = [...new Set(shifts.map(s => openings.get(s.id)?.discoveryScanAt).filter(Boolean))]
            .map(at => `opportunity-scan:${book.version}:${at}`);
        const scans = await tx.deskRecord.findMany({ where: { bookId: book.id, key: { in: scanKeys } } });
        const evidence = new Map(scans.map(r => [r.key, JSON.parse(r.dataJson).observations ?? []]));
        for (const row of rows) {
            const opening = openings.get(row.shiftId!);
            if (!opening) continue;
            const data = JSON.parse(row.dataJson);
            const triggerIds = [...new Set<string>((opening.triggers ?? []).flatMap((t: { payload?: { instrumentId?: string } }) =>
                t.payload?.instrumentId ? [t.payload.instrumentId] : []))];
            const cases: CandidateComparison["candidates"] = row.kind === "candidate_comparison"
                ? data.candidates.filter((c: { stage: string }) => c.stage === "investigated")
                : row.role === "lead" && triggerIds.length === 1 && data.evidenceIds?.some((id: string) => id.includes(triggerIds[0]))
                    ? [{ instrumentId: triggerIds[0], mechanism: data.thesis, objection: data.dissent,
                        nextStep: data.invalidation, evidenceIds: data.evidenceIds }] : [];
            for (const c of cases) {
                const prior = state.reviews[c.instrumentId];
                const summary = { sourceShiftId: row.shiftId!, summaryAt: +row.createdAt,
                    mechanism: c.mechanism?.slice(0, 500), objection: c.objection?.slice(0, 500),
                    nextStep: c.nextStep?.slice(0, 500), evidenceIds: c.evidenceIds?.slice(0, 8) };
                if (prior && prior.reviewedAt >= +row.createdAt) {
                    // Older producers saved the completion time and numerical baseline
                    // only. Enrich that checkpoint with its latest actual conclusion,
                    // preserving the baseline and cooldown through the upgrade.
                    if ((prior.summaryAt ?? 0) < +row.createdAt) Object.assign(prior, summary);
                    continue;
                }
                if (prior?.evidenceIds?.length && JSON.stringify(prior.evidenceIds) === JSON.stringify(c.evidenceIds)) continue;
                const point = evidence.get(`opportunity-scan:${book.version}:${opening.discoveryScanAt}`)
                    ?.find((p: [string, number | null]) => p[0] === c.instrumentId && p[1] !== null);
                const observed: DiscoveryBaseline | null = point ? { observedAt: point[1], return1hBps: point[2],
                    return4hBps: point[3], oiChange1hPct: point[6], fundingHourly: point[7], ...(point.length > 8 ? { setup: point[8] } : {}) } : null;
                state.reviews[c.instrumentId] = { observed, reviewedAt: +row.createdAt, ...summary };
                const candidate = state.candidates[c.instrumentId];
                if (candidate) Object.assign(candidate, { qualifiedAt: null, reason: null, consecutive: 0 });
            }
        }
        state.reviewCursor = rows.at(-1)!.id;
        state.reviewMemoryVersion = 1;
        const dataJson = JSON.stringify(state);
        if (!stored) {
            const created = await tx.deskRecord.upsert({ where: { bookId_key: key }, update: {},
                create: { ...key, dataJson, kind: "opportunity_state", role: "host" } });
            if (created.dataJson === dataJson) return;
        } else if ((await tx.deskRecord.updateMany({ where: { id: stored.id, dataJson: stored.dataJson }, data: { dataJson } })).count) return;
    }
    throw new Error("Discovery review checkpoint changed concurrently");
}
