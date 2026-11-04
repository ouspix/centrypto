import type { DeskBook, DeskWatch, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { queueWake } from "./books";
import { LIVE_ORDER_STATES, depthWithinBand } from "./execution-risk";
import { quoteUsdRates } from "./instruments";
import { parseDeskMandate } from "./mandate";
import { publicQuote } from "./market";
import { newsExposure } from "./news-exposure";

type Observation = {
    watch: DeskWatch;
    outcome: Record<string, unknown>;
    blocked: boolean;
    bidUsd?: number;
    askUsd?: number;
    observedAt: number;
};

// Ordinary passes can only park a name when neither side has executable depth.
// A live lead may instead specify which side blocked its thesis, including exit liquidity.
export async function observePasses(book: DeskBook, mids: Map<string, number>, moving: Set<string>, now: Date) {
    if (!book.enabled || book.kind !== "directional") return [];
    const watches = await prisma.deskWatch.findMany({
        where: { bookId: book.id, mode: "live", kind: "pass", status: "open", deadline: { gt: now },
            key: { startsWith: `routine:lead:${book.version}:live:` }, instrumentId: { not: null } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!watches.length) return [];
    const [scope, pending, inventory] = await Promise.all([
        newsExposure(book),
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
    const rates = quoteUsdRates(scope.directory, mids);
    const mandate = parseDeskMandate(book.mandateJson);
    const observations: Observation[] = [];
    for (const watch of watches) {
        const id = watch.instrumentId!;
        if (skip.has(id)) continue;
        skip.add(id);
        const item = directory.get(id);
        const outcome = JSON.parse(watch.outcomeJson ?? "{}");
        if (!item || outcome.depthReopenedAt || outcome.evidenceReopenedAt) continue;
        if (outcome.revisitWhen === "material_news") {
            if (moving.has(id)) observations.push({ watch, outcome, observedAt: Date.now(), blocked: true });
            continue;
        }
        if (!moving.has(id) && !outcome.depthBlockedAt && !outcome.revisitWhen) continue;
        const fx = item.kind === "perp" ? 1 : rates.get(item.quoteTokenIndex!);
        if (!fx || !Number.isFinite(fx)) continue;
        try {
            const q = await publicQuote(item, book.isTestnet, true);
            const mid = (q.bid + q.ask) / 2, delta = mid * mandate.maxSlippageBps / 10000;
            const bidUsd = depthWithinBand(q.bids, false, mid - delta, fx);
            const askUsd = depthWithinBand(q.asks, true, mid + delta, fx);
            const depth = outcome.revisitWhen === "bid_depth" ? bidUsd : outcome.revisitWhen === "ask_depth" ? askUsd :
                outcome.revisitWhen === "both_depth" ? Math.min(bidUsd, askUsd) : Math.max(bidUsd, askUsd);
            observations.push({ watch, outcome, bidUsd, askUsd, observedAt: q.time, blocked: depth < mandate.minDepthUsd });
        } catch {
            // Missing market data never suppresses a move or confirms recovery.
        }
    }
    return observations;
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
        if (!blocked) await queueWake(tx, book, "depth-recovery:" + watch.id, "watch", "live", {
            role: "lead", condition: "depth_recovery", instrumentId: watch.instrumentId, eventKey: watch.eventKey,
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
        if (released.has(pass.instrumentId!) || outcome.evidenceReopenedAt || outcome.depthReopenedAt ||
            !(outcome.revisitWhen || outcome.depthBlockedAt) || await superseded(tx, book, pass)) continue;
        await tx.deskWatch.update({ where: { id: pass.id }, data: {
            outcomeJson: JSON.stringify({ ...outcome, evidenceReopenedAt: new Date().toISOString() }),
        } });
        released.add(pass.instrumentId!);
    }
    return ids.every(id => released.has(id));
}
