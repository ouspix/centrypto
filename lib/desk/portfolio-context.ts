import type { DeskBook, PrismaClient } from "@prisma/client";
import { parseDeskMandate, LEGACY_SIZING_DEFAULTS } from "./mandate";
import { LIVE_ORDER_STATES } from "./execution-risk";

/** Compact local context only. No venue queries, inference, new wakes or authority. */
export async function portfolioContext(db: Pick<PrismaClient, "deskInventory" | "deskIntent" | "deskRecord" | "deskExecutionState">, book: DeskBook, now = Date.now(), includeHistory = true) {
    const [positions, pending, plans, state, comparisons] = await Promise.all([
        db.deskInventory.findMany({ where: { bookId: book.id, OR: [{ quantity: { not: 0 } }, { suspended: true }] } }),
        db.deskIntent.findMany({ where: { bookId: book.id, OR: [{ reservedUsd: { gt: 0 } }, { state: { in: LIVE_ORDER_STATES } }] },
            select: { instrumentId: true, reservedUsd: true } }),
        db.deskRecord.findMany({ where: { bookId: book.id, kind: "position_plan" }, select: { dataJson: true } }),
        db.deskExecutionState.findUnique({ where: { bookId: book.id }, select: { lastSync: true, lastError: true } }),
        includeHistory ? db.deskRecord.findMany({ where: { bookId: book.id, kind: "portfolio_comparison", role: "lead" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200, select: { dataJson: true, createdAt: true } }) : [],
    ]);
    const holdings = positions.filter(p => p.quantity !== 0);
    const reconciliationIssues = positions.filter(p => p.suspended).map(p => ({ instrumentId: p.instrumentId,
        quantity: p.quantity, reason: p.reason, instruction: p.quantity === 0
            ? "Zero owned quantity is not a holding. Host reconciliation owns this issue; do not repeat hold/exit comparisons or submit another exit."
            : "Exposure remains unresolved; retain risk review and reconciliation safeguards." }));
    const parsed = plans.map(r => JSON.parse(r.dataJson));
    const mandate = parseDeskMandate(book.mandateJson);
    const occupied = new Set([...positions.map(p => p.instrumentId), ...pending.map(p => p.instrumentId)]);
    const choices = new Map<string, Record<string, unknown>>();
    for (const r of comparisons) {
        const c = JSON.parse(r.dataJson), p = holdings.find(p => p.instrumentId === c.holdingInstrumentId);
        if (!p || choices.has(p.instrumentId) || c.mode !== "live" || (c.bookVersion !== undefined && c.bookVersion !== book.version)) continue;
        if (!c.portfolio?.holdings?.some((h: { instrumentId: string; openedAt: string }) => h.instrumentId === p.instrumentId && Date.parse(h.openedAt) === +p.since)) continue;
        choices.set(p.instrumentId, { at: r.createdAt.toISOString(), holdingInstrumentId: c.holdingInstrumentId, candidateInstrumentId: c.candidateInstrumentId,
            choice: c.choice, reason: c.reason, changeCondition: c.changeCondition, forwardCase: c.forwardCase ?? null,
            historical: true, recoveredFromToolReceipt: !!c.recovery });
    }
    return {
        asOf: new Date(now).toISOString(), source: "owned_ledger_not_whole_account", executionObservedAt: state?.lastSync?.toISOString() ?? null,
        reconciledRecently: !!state?.lastSync && +state.lastSync <= now + 1000 && now - +state.lastSync <= 30000 && !state.lastError && !positions.some(p => p.suspended),
        capacity: { occupiedOrReserved: occupied.size, limit: mandate.maxConcurrentPositions ?? LEGACY_SIZING_DEFAULTS.concurrentPositions,
            availableSlots: Math.max(0, (mandate.maxConcurrentPositions ?? LEGACY_SIZING_DEFAULTS.concurrentPositions) - occupied.size), pendingCommitments: pending.length },
        reconciliationIssues,
        holdings: holdings.map(p => {
            const plan = parsed.find(x => x.instrumentId === p.instrumentId && Date.parse(x.openedAt) === +p.since);
            const deadline = plan && Number.isFinite(Date.parse(plan.maxHoldUntil)) ? plan.maxHoldUntil : null;
            return { instrumentId: p.instrumentId, quantity: p.quantity, stopPrice: p.stopPrice, targetPrice: p.targetPrice,
                openedAt: p.since.toISOString(), suspended: p.suspended, originalExitDeadline: deadline,
                remainingHours: deadline ? Math.max(0, (Date.parse(deadline) - now) / 3600000) : null,
                proposalKey: plan?.proposalKey ?? null };
        }),
        recentChoices: [...choices.values()],
        instruction: "Capacity limits simultaneous exposure, not investigation or the choice to exit. Compare hold, exit to cash and replacement from NOW at a common horizon with costs and uncertainty. Existing protection is not a reason to prefer holding. Prior entry cost/PnL is sunk for forward comparison. Unknown whole-account exposure or stale reconciliation requires normal fresh checks. Rotation is sequential: reconcile any exit before sizing/previewing a replacement under unchanged risk limits; this context grants no orders and does not extend deadlines.",
    };
}
