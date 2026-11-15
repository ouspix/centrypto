import { createHash } from "node:crypto";
import type { DeskBook, PrismaClient } from "@prisma/client";
import { LIVE_ORDER_STATES } from "./execution-risk";
import type { AllocationReview } from "./allocation-review";

type Intent = { id: string; instrumentId: string; side: string; requestJson: string; state: string; reservedUsd: number; quantity: number; filledQty: number; limitPrice: number; createdAt: Date };
type Flow = { intentId: string | null; instrumentId: string; kind: string; quantity: number; pnlUsd: number; feeUsd: number; occurredAt: Date };
type Position = { instrumentId: string; quantity: number; basis: number; stopPrice: number | null; suspended: boolean; since: Date };
type Receipt = { intentId: string; allocation: AllocationReview };
type Episode = { instrumentId: string; side: string; family: string; drivers: string[]; entryIds: string[]; openedAt: string; closedAt: string | null; quantity: number; netUsd: number; feesUsd: number; fundingUsd: number };

export function summarizeAllocations(input: { intents: Intent[]; flows: Flow[]; positions: Position[]; receipts: Receipt[]; from: Date; now: Date }) {
    const intents = new Map(input.intents.map(i => [i.id, i]));
    const reviews = new Map(input.receipts.map(r => [r.intentId, r.allocation]));
    const active = new Map<string, Episode>(), episodes: Episode[] = [];
    let unattributedFlows = 0;
    for (const f of [...input.flows].sort((a, b) => +a.occurredAt - +b.occurredAt)) {
        const intent = f.intentId ? intents.get(f.intentId) : undefined;
        const request = intent ? JSON.parse(intent.requestJson) : null;
        const opening = !!intent && !request.reduceOnly && f.kind === "fill" && Math.sign(f.quantity) === (intent.side === "buy" ? 1 : -1);
        let episode = active.get(f.instrumentId);
        if (!episode && opening) {
            const review = reviews.get(intent!.id);
            episode = { instrumentId: f.instrumentId, side: intent!.side, family: review?.theme.family ?? "legacy_unclassified",
                drivers: review ? [review.theme.driver] : [], entryIds: [intent!.id], openedAt: f.occurredAt.toISOString(),
                closedAt: null, quantity: 0, netUsd: 0, feesUsd: 0, fundingUsd: 0 };
            active.set(f.instrumentId, episode);
        }
        if (!episode) { unattributedFlows++; continue; }
        if (opening && !episode.entryIds.includes(intent!.id)) {
            const review = reviews.get(intent!.id);
            if (episode.family !== (review?.theme.family ?? "legacy_unclassified")) episode.family = "mixed";
            if (review && !episode.drivers.includes(review.theme.driver)) episode.drivers.push(review.theme.driver);
            episode.entryIds.push(intent!.id);
        }
        // pnlUsd already includes the fill fee. Funding is a separate zero-size
        // cash flow; do not subtract fees twice or count each partial fill as a trade.
        const before = episode.quantity;
        episode.quantity += f.quantity;
        episode.netUsd += f.pnlUsd;
        episode.feesUsd += f.feeUsd;
        if (f.kind === "funding") episode.fundingUsd += f.pnlUsd;
        if (before && episode.quantity && Math.sign(before) !== Math.sign(episode.quantity) && Math.abs(episode.quantity) > 1e-9) {
            unattributedFlows++; active.delete(f.instrumentId); continue;
        }
        if (Math.abs(episode.quantity) < 1e-9) {
            episode.quantity = 0; episode.closedAt = f.occurredAt.toISOString();
            episodes.push(episode); active.delete(f.instrumentId);
        }
    }
    const open = [...active.values()];
    const groups = new Map<string, { family: string; side: string; closedEpisodes: number; openEpisodes: number; closedNetUsd: number; closedFeesUsd: number; closedFundingUsd: number }>();
    for (const e of [...episodes, ...open]) {
        const key = e.family + ":" + e.side;
        const g = groups.get(key) ?? { family: e.family, side: e.side, closedEpisodes: 0, openEpisodes: 0, closedNetUsd: 0, closedFeesUsd: 0, closedFundingUsd: 0 };
        if (e.closedAt) { g.closedEpisodes++; g.closedNetUsd += e.netUsd; g.closedFeesUsd += e.feesUsd; g.closedFundingUsd += e.fundingUsd; }
        else g.openEpisodes++;
        groups.set(key, g);
    }
    const holdings = input.positions.filter(p => p.quantity !== 0).map(p => {
        const episode = active.get(p.instrumentId);
        const matched = episode && Math.abs(episode.quantity - p.quantity) < 1e-9;
        return { instrumentId: p.instrumentId, side: p.quantity > 0 ? "buy" : "sell", quantity: p.quantity,
            family: matched ? episode.family : "unclassified", drivers: matched ? episode.drivers : [],
            basisNotionalUsd: Math.abs(p.quantity) * p.basis,
            basisToStopUsd: p.stopPrice && !p.suspended ? Math.max(0, (p.basis - p.stopPrice) * p.quantity) : null,
            suspended: p.suspended, openedAt: p.since.toISOString(), outcomeAttributionComplete: !!matched };
    });
    const pending = input.intents.filter(i => i.reservedUsd > 0 || LIVE_ORDER_STATES.includes(i.state)).filter(i => !JSON.parse(i.requestJson).reduceOnly)
        .map(i => ({ instrumentId: i.instrumentId, side: i.side, family: reviews.get(i.id)?.theme.family ?? "unclassified",
            remainingNotionalUsd: Math.max(0, i.quantity - i.filledQty) * i.limitPrice, state: i.state }));
    const directionalExposure = ["buy", "sell"].map(side => {
        const held = holdings.filter(h => h.side === side), waiting = pending.filter(p => p.side === side);
        return { side, instruments: [...new Set([...held, ...waiting].map(h => h.instrumentId))],
            basisNotionalUsd: held.reduce((s, h) => s + h.basisNotionalUsd, 0), pendingNotionalUsd: waiting.reduce((s, p) => s + p.remainingNotionalUsd, 0),
            basisToStopUsd: held.some(h => h.basisToStopUsd === null) ? null : held.reduce((s, h) => s + h.basisToStopUsd!, 0) };
    });
    return { asOf: input.now.toISOString(), source: "owned_fill_ledger", windowFrom: input.from.toISOString(),
        holdings, pending, directionalExposure, patternOutcomes: [...groups.values()],
        recentClosed: episodes.slice(-8).map(({ quantity: _, ...episode }) => episode),
        attribution: { unattributedFlows, unclassifiedHistory: episodes.some(e => e.family === "legacy_unclassified"),
            instruction: "Only episodes with an observed opening in this window are included. Legacy trades have no recorded family; do not invent one. Incomplete/pre-window cash flows are excluded and counted. Open episodes are not realized round trips. Different symbols/adjacent trades are not independent samples." },
        instruction: "Treat repeated recovery/continuation trades and shared event exposure as possible common bets, including pending orders. Family labels are trader judgments, not measured correlations; changing a label creates no diversification. Same-side totals remain visible across families. Basis notionals/stop distances are historical references, exclude costs/gaps and are not fresh forward risk: use current marks, execution checks and a common adverse scenario for the joint downside. Actual closed net includes fees and funding. This short selected sample neither proves nor disproves an edge, sets no performance cutoff, and never forces shorts or trades. Explain the incremental allocation versus cash in decisionPlan.allocation.theme." };
}

/** Seven days is a display window, never an admission threshold. No venue calls or mutations. */
export async function allocationContext(db: PrismaClient, book: Pick<DeskBook, "id">, now = Date.now()) {
    const from = new Date(now - 7 * 86400000);
    const [intents, flows, positions, receipts, execution] = await Promise.all([
        db.deskIntent.findMany({ where: { bookId: book.id, OR: [{ createdAt: { gte: from, lte: new Date(now) } }, { reservedUsd: { gt: 0 } }, { state: { in: LIVE_ORDER_STATES } }] } }),
        db.deskCashFlow.findMany({ where: { bookId: book.id, occurredAt: { gte: from, lte: new Date(now) } }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] }),
        db.deskInventory.findMany({ where: { bookId: book.id, quantity: { not: 0 } } }),
        db.deskRecord.findMany({ where: { bookId: book.id, kind: "entry_allocation", createdAt: { gte: from, lte: new Date(now) } }, select: { dataJson: true } }),
        db.deskExecutionState.findUnique({ where: { bookId: book.id }, select: { lastSync: true, lastError: true } }),
    ]);
    const context = { ...summarizeAllocations({ intents, flows, positions, receipts: receipts.map(r => JSON.parse(r.dataJson)), from, now: new Date(now) }),
        executionObservedAt: execution?.lastSync?.toISOString() ?? null, executionError: execution?.lastError ?? null };
    return { evidenceId: "allocation-context:" + createHash("sha256").update(JSON.stringify(context)).digest("hex"), ...context };
}
