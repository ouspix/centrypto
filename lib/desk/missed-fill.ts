import type { DeskIntent } from "@prisma/client";

export const recoverySuffix = ":missed-fill-recovery";
export function missedFillReview(intent: Pick<DeskIntent, "id" | "intentKey" | "state" | "filledQty" | "reason" | "requestJson">, now = Date.now()) {
    const order = JSON.parse(intent.requestJson);
    const expires = Date.parse(order.entryExpiresAt);
    const eligible = intent.state === "rejected" && intent.filledQty === 0 &&
        /could not immediately match/i.test(intent.reason ?? "") &&
        !intent.intentKey.endsWith(recoverySuffix) && !order.reduceOnly &&
        !!order.strategyVersion && Number.isFinite(expires) && expires > now;
    return { eligible, intentId: intent.id, originalOrder: order,
        status: eligible ? "reassess_before_expiry" : "no_automatic_recovery",
        instruction: eligible
            ? "Zero-fill IOC rejection is an execution outcome, not thesis invalidation. Reassess current evidence and original entry window. If still justified, re-size and use recover_missed_fill once at the same or better limit and no larger quantity. Do not widen stops or extend expiry. A pass needs a current market, economics or execution reason; no obligation to trade."
            : "Do not blindly resubmit. Unknown/partial outcomes require reconciliation; expired or already-recovered tickets grant no further recovery." };
}
export function boundedRecoveryOrder(intent: Parameters<typeof missedFillReview>[0], quantity: number, limitPrice: number, now = Date.now()) {
    const review = missedFillReview(intent, now);
    if (!review.eligible) throw new Error("This intent is not eligible for bounded missed-fill recovery.");
    const original = review.originalOrder;
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > original.quantity ||
        !Number.isFinite(limitPrice) || limitPrice <= 0 ||
        (original.side === "buy" ? limitPrice > original.limitPrice : limitPrice < original.limitPrice))
        throw new Error("Recovery cannot increase quantity or chase beyond the original limit price.");
    return { ...original, quantity, limitPrice };
}
