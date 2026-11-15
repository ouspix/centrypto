import type { discoverMarket } from "./discovery";

export const discoveryReviewIntervalMs = 300_000;
export const discoveryInstrumentCooldownMs = 600_000;
export const discoveryFreshnessMs = 120_000;
export const discoveryRetentionMs = 86_400_000;
export const discoveryChanges = {
    return1hBps: 100, return4hBps: 200, oiChange1hPct: 5, fundingHourly: 0.0001,
} as const;

type Scan = ReturnType<typeof discoverMarket>;
export type DiscoveryScan = Omit<Scan, "featureVersion" | "snapshotId"> & Partial<Pick<Scan, "featureVersion" | "snapshotId">>;
export type Observation = Extract<DiscoveryScan["coverage"][number], { status: "observed" }>;
export type DiscoveryBaseline = Pick<Observation, keyof typeof discoveryChanges | "observedAt"> & { setup?: Observation["setup"] };
type Reason = "priority_entry" | "material_change";
type Candidate = {
    observation: Observation; freshSamples?: number; priority: boolean; prioritySince: number | null;
    reason: Reason | null; consecutive: number; qualifiedAt: number | null;
};
export type DiscoveryReview = { observed: DiscoveryBaseline | null; reviewedAt: number;
    mechanism?: string; objection?: string; nextStep?: string; evidenceIds?: string[]; sourceShiftId?: string; summaryAt?: number };
export type DiscoveryState = {
    scannedAt: number;
    featureVersion?: number;
    snapshotId?: string | null;
    candidates: Record<string, Candidate>;
    reviews: Record<string, DiscoveryReview>;
    reviewCursor?: number;
    reviewMemoryVersion?: number;
    delivered: Record<string, number>;
    lastDispatchedAt: number | null;
    rotationIds: string[];
    coverage: { eligible: number; scanned: number; unavailable: number };
};

export function materialDiscoveryChanges(previous: DiscoveryBaseline, current: DiscoveryBaseline) {
    if (previous.setup !== undefined && current.setup !== undefined && Boolean(previous.setup) !== Boolean(current.setup))
        return [{ field: "setup", before: JSON.stringify(previous.setup), after: JSON.stringify(current.setup) }];
    if (previous.setup && current.setup) {
        const a = previous.setup, b = current.setup;
        const before = JSON.stringify(a), after = JSON.stringify(b);
        if (a.view !== b.view || a.side !== b.side || a.beyond !== b.beyond || a.eventKey !== b.eventKey ||
            (a.displacement != null && b.displacement != null && Math.abs(a.displacement - b.displacement) >= 1))
            return [{ field: "setup", before, after }];
        return [];
    }
    return (Object.keys(discoveryChanges) as (keyof typeof discoveryChanges)[]).flatMap(field => {
        const before = previous[field], after = current[field];
        return before !== null && after !== null && Math.abs(after - before) >= discoveryChanges[field] - 1e-12
            ? [{ field, before, after }] : [];
    });
}

const fresh = (observation: Observation, now: number) =>
    observation.observedAt >= now - discoveryFreshnessMs && observation.observedAt <= now + 1000;

export function advanceDiscovery(previous: DiscoveryState | null, scan: DiscoveryScan, now: number): DiscoveryState | null {
    const observed = scan.coverage.filter((row): row is Observation => row.status === "observed" && fresh(row, now));
    if (previous && (previous.featureVersion ?? 0) === (scan.featureVersion ?? 0) && previous.coverage.eligible === scan.eligible && observed.length === Object.keys(previous.candidates).length &&
        observed.every(row => previous.candidates[row.instrumentId]?.observation.observedAt === row.observedAt &&
            JSON.stringify(previous.candidates[row.instrumentId]?.observation.setup) === JSON.stringify(row.setup))) return null;
    const priority = new Set(scan.priorityIds);
    const reviews = previous?.reviews ?? {};
    const candidates: DiscoveryState["candidates"] = {};
    for (const observation of observed) {
        const id = observation.instrumentId, old = previous?.candidates[id], reviewed = reviews[id];
        // A gap or replayed observation cannot count toward two fresh samples.
        const continuous = !!old && (previous?.featureVersion ?? 0) === (scan.featureVersion ?? 0) && now - (previous?.scannedAt ?? 0) <= discoveryFreshnessMs;
        const isPriority = priority.has(id) && (scan.featureVersion === 1 || observation.return1hBps !== null || observation.return4hBps !== null);
        // Recovering coverage after a gap is not itself a new ranking signal for a reviewed name.
        const prioritySince = !isPriority ? null : continuous
            ? (old.priority ? old.prioritySince ?? now : now)
            : reviewed?.reviewedAt ?? now;
        // An investigation still counts when collector data was unavailable. The first
        // recovered observation establishes a baseline; recovery is not a market move.
        if (reviewed && !reviewed.observed) reviewed.observed = observation;
        if (reviewed?.observed && scan.featureVersion === 1 && reviewed.observed.setup === undefined)
            reviewed.observed = { ...reviewed.observed, setup: observation.setup };
        const changed = reviewed?.observed && materialDiscoveryChanges(reviewed.observed, observation).length > 0;
        const reason = changed ? "material_change" : prioritySince !== null && (!reviewed || prioritySince > reviewed.reviewedAt)
            ? "priority_entry" : null;
        const sameReason = continuous && old.reason === reason;
        const newer = !old || observation.observedAt > old.observation.observedAt;
        const consecutive = reason ? (sameReason ? old.consecutive + Number(newer) : Number(newer)) : 0;
        const qualifiedAt = consecutive >= 2 ? (sameReason ? old.qualifiedAt ?? now : now) : null;
        candidates[id] = { observation, freshSamples: continuous ? (old.freshSamples ?? 1) + Number(newer) : 1, priority: isPriority, prioritySince, reason, consecutive, qualifiedAt };
    }
    return {
        scannedAt: now, featureVersion: scan.featureVersion, snapshotId: scan.snapshotId, candidates, reviews, delivered: previous?.delivered ?? {},
        lastDispatchedAt: previous?.lastDispatchedAt ?? null, rotationIds: scan.rotationIds, reviewCursor: previous?.reviewCursor,
        reviewMemoryVersion: previous?.reviewMemoryVersion,
        coverage: { eligible: scan.eligible, scanned: observed.length, unavailable: scan.eligible - observed.length },
    };
}

export function selectDiscoveryBatch(state: DiscoveryState, now: number) {
    if (now - state.scannedAt > discoveryFreshnessMs ||
        (state.lastDispatchedAt !== null && now - state.lastDispatchedAt < discoveryReviewIntervalMs)) return [];
    const eligible = (candidate: Candidate) => {
        const id = candidate.observation.instrumentId;
        const last = Math.max(state.delivered[id] ?? -Infinity, state.reviews[id]?.reviewedAt ?? -Infinity);
        return (state.featureVersion !== 1 || (candidate.freshSamples ?? 0) >= 2) && fresh(candidate.observation, now) && now - last >= discoveryInstrumentCooldownMs;
    };
    const queued = Object.values(state.candidates).filter(c => c.qualifiedAt !== null && eligible(c));
    queued.sort((a, b) => b.observation.score - a.observation.score || a.observation.instrumentId.localeCompare(b.observation.instrumentId));
    const selected: Candidate[] = [];
    if (state.featureVersion === 1) {
        if (queued[0]) selected.push(queued[0]);
        const oldest = queued.slice(1).sort((a, b) =>
            Number(a.observation.setup?.view === selected[0]?.observation.setup?.view) -
            Number(b.observation.setup?.view === selected[0]?.observation.setup?.view) || a.qualifiedAt! - b.qualifiedAt!)[0];
        if (oldest) selected.push(oldest);
        const remaining = Object.values(state.candidates).filter(c => eligible(c) && !selected.includes(c));
        const last = (c: Candidate) => Math.max(state.delivered[c.observation.instrumentId] ?? 0, state.reviews[c.observation.instrumentId]?.reviewedAt ?? 0);
        remaining.sort((a, b) => last(a) - last(b) || a.observation.instrumentId.localeCompare(b.observation.instrumentId));
        if (remaining[0]) selected.push(remaining[0]);
        for (const c of queued) if (selected.length < 3 && !selected.includes(c)) selected.push(c);
    } else {
        selected.push(...queued.slice(0, 2));
        if (!selected.length) return [];
        const oldest = queued.slice(2).sort((a, b) => a.qualifiedAt! - b.qualifiedAt!)[0];
        if (oldest) selected.push(oldest);
        else {
            const rotating = state.rotationIds.map(id => state.candidates[id]).find(c => c && eligible(c) &&
                !state.reviews[c.observation.instrumentId] && !state.delivered[c.observation.instrumentId] && !selected.includes(c));
            if (rotating) selected.push(rotating);
        }
    }
    return selected.map(c => ({
        ...c.observation, reason: c.reason ?? "rotating_coverage", qualifiedAt: c.qualifiedAt,
        changes: state.reviews[c.observation.instrumentId]?.observed
            ? materialDiscoveryChanges(state.reviews[c.observation.instrumentId].observed!, c.observation) : [],
    }));
}
