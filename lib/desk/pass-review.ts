import type { DeskBook, DeskWatch, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { queueWake } from "./books";
import { LIVE_ORDER_STATES } from "./execution-risk";
import { bandLiquidity } from "./liquidity";
import { quoteUsdRates } from "./instruments";
import { parseDeskMandate } from "./mandate";
import { collectMids, publicQuote } from "./market";
import { newsExposure } from "./news-exposure";

type Observation = {
    watch: DeskWatch;
    outcome: Record<string, unknown>;
    blocked: boolean;
    bidUsd?: number;
    askUsd?: number;
    observedAt: number;
};

export const liquidityWatchIntervalMs = 15_000;
export const liquidityWatchBatchSize = 4;
const scopes = new Map<string, { at: number; read: ReturnType<typeof newsExposure> }>();
function monitorScope(book: DeskBook) {
    const key = `${book.id}:${book.version}`;
    const now = Date.now();
    const prior = scopes.get(key);
    if (prior && now - prior.at < 60_000) return prior.read;
    for (const [id, entry] of scopes) if (now - entry.at >= 60_000) scopes.delete(id);
    const read = newsExposure(book);
    scopes.set(key, { at: now, read });
    return read;
}

// Ordinary passes can only park a name when neither side has executable depth.
// A live lead may instead specify which side blocked its thesis, including exit liquidity.
export async function observePasses(book: DeskBook, mids: Map<string, number>, moving: Set<string>, now: Date,
    lastChecked?: Map<string, number>) {
    if (!book.enabled || book.kind !== "directional") return [];
    const watches = await prisma.deskWatch.findMany({
        where: { bookId: book.id, mode: "live", kind: "pass", status: "open", deadline: { gt: now },
            key: { startsWith: `routine:lead:${book.version}:live:` }, instrumentId: { not: null } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const newest = new Map<string, DeskWatch>();
    for (const watch of watches) if (!newest.has(watch.instrumentId!)) newest.set(watch.instrumentId!, watch);
    const candidates = [...newest.values()].map(watch => ({ watch, outcome: JSON.parse(watch.outcomeJson ?? "{}") }))
        .filter(({ watch, outcome }) => !outcome.monitoringDisabled && !outcome.depthReopenedAt && !outcome.evidenceReopenedAt &&
            !(Number(outcome.admissionRetryAt) > +now) &&
            outcome.revisitWhen !== "material_news" && (outcome.depthBlockedAt || outcome.revisitWhen || moving.has(watch.instrumentId!)));
    if (lastChecked) {
        const ids = new Set(candidates.map(c => c.watch.id));
        for (const id of lastChecked.keys()) if (!ids.has(id)) lastChecked.delete(id);
        candidates.sort((a, b) => (lastChecked.get(a.watch.id) ?? 0) - (lastChecked.get(b.watch.id) ?? 0));
    }
    if (!candidates.length) return [];
    const [scope, pending, inventory] = await Promise.all([
        lastChecked ? monitorScope(book) : newsExposure(book),
        prisma.deskIntent.findMany({ where: { bookId: book.id, OR: [
            { reservedUsd: { gt: 0 } }, { state: { in: LIVE_ORDER_STATES } },
        ] }, select: { instrumentId: true } }),
        prisma.deskInventory.findMany({ where: { bookId: book.id, OR: [
            { quantity: { not: 0 } }, { suspended: true },
        ] }, select: { instrumentId: true } }),
    ]);
    if (scope.coverage.needsReconciliation) return [];
    const skip = new Set([...scope.heldIds, ...pending.map(p => p.instrumentId), ...inventory.map(i => i.instrumentId)]);
    const directory = new Map(scope.directory.map(i => [i.id, i]));
    if (lastChecked && candidates.some(({ watch }) => {
        const item = directory.get(watch.instrumentId!);
        return item?.kind === "spot" && item.quoteTokenIndex !== 0;
    })) mids = new Map((await collectMids(book.isTestnet)).map(m => [m.instrumentId, m.mid]));
    const rates = quoteUsdRates(scope.directory, mids);
    const mandate = parseDeskMandate(book.mandateJson);
    const observations: Observation[] = [];
    const checks: Promise<void>[] = [];
    for (const { watch, outcome } of candidates) {
        const id = watch.instrumentId!;
        if (skip.has(id)) continue;
        skip.add(id);
        const item = directory.get(id);
        if (!item) continue;
        const fx = item.kind === "perp" ? 1 : rates.get(item.quoteTokenIndex!);
        if (!fx || !Number.isFinite(fx)) continue;
        lastChecked?.set(watch.id, +now);
        const check = async () => { try {
            const q = await publicQuote(item, book.isTestnet, true);
            const liquidity=bandLiquidity({time:q.time,levels:[q.bids,q.asks]},mandate,fx);
            const selected=outcome.revisitWhen==="bid_depth"?[liquidity.bids]:outcome.revisitWhen==="ask_depth"?[liquidity.asks]:[liquidity.bids,liquidity.asks];
            const both=outcome.revisitWhen==="both_depth";
            const blocked=both?selected.some(s=>s.status==="insufficient"):selected.every(s=>s.status==="insufficient");
            // A recovered entry side cannot reopen an idea whose exit side now fails.
            const recovered=[liquidity.bids,liquidity.asks].every(s=>s.status==="sufficient");
            if(!blocked&&!recovered)return; // Incomplete coverage cannot suppress a move or confirm recovery.
            observations.push({ watch, outcome, bidUsd:liquidity.bids.observedDepthUsd!,askUsd:liquidity.asks.observedDepthUsd!, observedAt: q.time, blocked });
        } catch {
            // Missing market data never suppresses a move or confirms recovery.
        } };
        if (lastChecked) {
            checks.push(check());
            if (checks.length >= liquidityWatchBatchSize) break;
        } else await check();
    }
    await Promise.all(checks);
    return observations;
}

export async function monitorLiquidityWatches(book: DeskBook, lastChecked: Map<string, number>, signal: AbortSignal) {
    const observations = await observePasses(book, new Map(), new Set(), new Date(), lastChecked);
    signal.throwIfAborted();
    if (!observations.length) return;
    await prisma.$transaction(async tx => {
        if (await tx.deskBook.count({ where: { id: book.id, version: book.version, enabled: true } }))
            await routePasses(tx, book, observations, new Date());
    });
}

function superseded(tx: Prisma.TransactionClient, book: DeskBook, watch: DeskWatch) {
    return tx.deskWatch.findFirst({ where: { bookId: book.id, instrumentId: watch.instrumentId,
        kind: "pass", key: { startsWith: `routine:lead:${book.version}:live:` },
        OR: [{ createdAt: { gt: watch.createdAt } }, { createdAt: watch.createdAt, id: { gt: watch.id } }],
    }, select: { id: true } });
}

export async function routePasses(tx: Prisma.TransactionClient, book: DeskBook, observations: Observation[], now: Date) {
    const handled = new Map<string, { watchId: string; condition: unknown; disposition: string }>();
    for (const { watch, outcome, blocked, bidUsd, askUsd, observedAt } of observations) {
        if (watch.deadline <= now || +now - observedAt > 10000 || observedAt - +now > 1000) continue;
        // A newer decision supersedes this pass even if its own horizon already elapsed.
        if (await superseded(tx, book, watch)) continue;
        if (!blocked && !outcome.depthBlockedAt && !outcome.revisitWhen) continue;
        const first = blocked && !outcome.depthBlockedAt && outcome.revisitWhen !== "material_news";
        const where = { id: watch.id, status: "open", outcomeJson: watch.outcomeJson };
        const updated = first || !blocked
            ? (await tx.deskWatch.updateMany({ where, data: { outcomeJson: JSON.stringify({
                ...outcome, [blocked ? "depthBlockedAt" : "depthReopenedAt"]: new Date(observedAt).toISOString(), bidUsd, askUsd,
            }) } })).count
            : await tx.deskWatch.count({ where });
        if (!updated) continue;
        handled.set(watch.instrumentId!, {
            watchId: watch.id, condition: outcome.revisitWhen ?? "either_depth",
            disposition: blocked ? "deferred" : "lead_notified",
        });
        if (!blocked) await queueWake(tx, book, "depth-recovery:" + watch.id + ":" + observedAt, "watch", "live", {
            role: "lead", watchId:watch.id, condition: "depth_recovery", instrumentId: watch.instrumentId, eventKey: watch.eventKey,
            thesis: watch.thesis, side: watch.side, revisitWhen: outcome.revisitWhen ?? "either_depth",
            bidUsd, askUsd, observedAt, threshold: parseDeskMandate(book.mandateJson).minDepthUsd,
        }, 6, now, new Date(Math.min(+watch.deadline, +now + 300000)));
    }
    return handled;
}


// Called in the same transaction that delivers the revision. Unrelated or unscoped
// news cannot release a pass. Urgent notices always retain the full risk route.
export async function releaseNewsPasses(tx: Prisma.TransactionClient, book: DeskBook, ids: string[]) {
    if (!ids.length) return false;
    const candidates = await tx.deskWatch.findMany({
        where: { bookId: book.id, kind: "pass", instrumentId: { in: ids }, status: "open",
            deadline: { gt: new Date() }, key: { startsWith: `routine:lead:${book.version}:live:` } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const released = new Set<string>();
    for (const pass of candidates) {
        const outcome = JSON.parse(pass.outcomeJson ?? "{}");
        if (outcome.monitoringDisabled || released.has(pass.instrumentId!) || outcome.evidenceReopenedAt || outcome.depthReopenedAt ||
            !(outcome.revisitWhen || outcome.depthBlockedAt) || await superseded(tx, book, pass)) continue;
        await tx.deskWatch.update({ where: { id: pass.id }, data: {
            outcomeJson: JSON.stringify({ ...outcome, evidenceReopenedAt: new Date().toISOString() }),
        } });
        released.add(pass.instrumentId!);
    }
    return ids.every(id => released.has(id));
}
