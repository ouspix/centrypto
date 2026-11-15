import { deskRoles, type DeskRole } from "./roles";

/** Route the event to its owner; specialist discovery need not wait for a lead turn.
 * Scheduled/operator reviews start with the lead and request specialists selectively. */
export function openingSpecialists(brief: unknown): DeskRole[] {
    const protection = (brief as { protection?: { status?: string; validUntil?: string; flatPositions?: Array<{ instrumentId: string; noVenueOrders: boolean }> } } | null)?.protection;
    const verifiedExits = new Set(protection?.status === "observed" && Date.parse(protection.validUntil ?? "") > Date.now()
        ? protection.flatPositions?.filter(p => p.noVenueOrders).map(p => p.instrumentId) : []);
    const triggers = (brief && typeof brief === "object" ? (brief as { triggers?: unknown }).triggers : null);
    if (!Array.isArray(triggers)) return [];
    const owners = new Set<DeskRole>();
    for (const trigger of triggers) {
        if (!trigger || typeof trigger !== "object") continue;
        const { kind, payload } = trigger;
        if (["watch", "follow_up"].includes(kind) && deskRoles.includes(payload?.role)) owners.add(payload.role);
        else if (["research", "discovery", "correction"].includes(kind)) owners.add("catalyst");
        else if (["market_move", "price_alert"].includes(kind)) owners.add("derivatives");
        else if (kind === "risk") owners.add("risk");
        // The host has already reconciled these exits against the venue. The
        // lead acknowledges the event and owns remaining task/proposal closure.
        // Partial fills, stale observations and pending orders still go to execution.
        else if (kind === "order_ticket" || (kind === "fill" && !verifiedExits.has(payload?.instrumentId))) owners.add("execution");
    }
    return deskRoles.filter(role => role !== "lead" && owners.has(role));
}
