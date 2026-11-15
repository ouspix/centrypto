// @vitest-environment node
import { expect, it, vi } from "vitest";
import { protectionEvidence, readProtectionStatus } from "@/lib/desk/protection-status";
import type { DeskAccount } from "@/lib/desk/execution-types";

const now = Date.parse("2026-11-12T17:00:00Z"), instrumentId = "mainnet:perp:ATOM";
const held = { instrumentId, quantity: 10, stopPrice: 1.39, suspended: false, since: new Date(now - 60000) };
const intent = { instrumentId, cloid: "entry", stopCloid: "owned-stop", groupKey: null };
const plan = { instrumentId, openedAt: held.since.toISOString(), maxHoldUntil: new Date(now + 60000).toISOString(), intentId: "entry" };
const order = { coin: "ATOM", cloid: "owned-stop", oid: 1, side: "A" as const, sz: "10", limitPx: "1.39", triggerPx: "1.39", reduceOnly: true, isTrigger: true, orderType: "Stop Market" };
const account = (orders = [order], quantity = 10) => ({ positions: new Map([["perp:ATOM", quantity]]), openOrders: orders }) as DeskAccount;
const evidence = (orders = [order], inventory = [held], plans = [plan], at = now) => protectionEvidence(inventory, [intent], plans, { account: account(orders), observedAt: new Date(at) }, now);

it("verifies an owned native stop and distinguishes the local persisted timer", () => {
    expect(evidence().positions[0]).toMatchObject({ verificationComplete: true, nativeStop: { status: "verified", orderId: 1, reduceOnly: true },
        timeExit: { status: "scheduled_local", requiresRunningWorker: true, maxHoldUntil: plan.maxHoldUntil } });
});
it.each([
    { reduceOnly: false }, { isTrigger: false }, { side: "B" as const }, { sz: "9" }, { triggerPx: "1.3" },
    { orderType: "Take Profit Market" }, { cloid: "manual-stop" }, { reduceOnly: undefined },
])("never verifies incomplete, unrelated or mismatched stop evidence (%j)", changed => {
    expect(evidence([{ ...order, ...changed } as typeof order]).positions[0].verificationComplete).toBe(false);
});
it("cannot verify stale, suspended, post-observation or different-fill inventory", () => {
    expect(evidence([order], [held], [plan], now - 31000).positions[0].verificationComplete).toBe(false);
    expect(evidence([order], [{ ...held, suspended: true }]).positions[0].verificationComplete).toBe(false);
    expect(evidence([order], [{ ...held, since: new Date(now + 1) }]).positions[0].verificationComplete).toBe(false);
    expect(evidence([order], [held], [{ ...plan, openedAt: new Date(now - 50000).toISOString() }]).positions[0].timeExit.status).toBe("unverified");
});
it("exposes a due deadline without claiming the exit executed", () => {
    expect(evidence([order], [held], [{ ...plan, maxHoldUntil: new Date(now - 1).toISOString() }]).positions[0])
        .toMatchObject({ verificationComplete: false, timeExit: { status: "due" } });
});
it("keeps a native stop visible when no local time plan can be verified", () => {
    expect(evidence([order], [held], []).positions[0]).toMatchObject({ nativeStop: { status: "verified" }, timeExit: { status: "unverified" }, verificationComplete: false });
});
it("degrades cached evidence on outage, inventory changes and elapsed deadlines", async () => {
    const db = { deskRecord: { findUnique: vi.fn(async () => ({ dataJson: JSON.stringify(evidence()) })) },
        deskIntent: { findMany: vi.fn(async () => []) },
        deskExecutionState: { findUnique: vi.fn(async () => ({ lastSync: new Date(now), lastError: null as string | null })) },
        deskInventory: { findMany: vi.fn(async () => [held]) } };
    const read = (at = now) => readProtectionStatus(db as any, { id: "book", version: 12 }, at);
    expect((await read()).positions[0].verificationComplete).toBe(true);
    db.deskExecutionState.findUnique.mockResolvedValueOnce({ lastSync: new Date(now), lastError: "venue unavailable" });
    expect((await read()).positions[0].nativeStop.status).toBe("unverified");
    db.deskInventory.findMany.mockResolvedValueOnce([{ ...held, quantity: 11 }]);
    expect((await read()).positions[0].verificationComplete).toBe(false);
    expect((await read(now + 31000)).status).toBe("stale");
    db.deskRecord.findUnique.mockResolvedValueOnce({ dataJson: JSON.stringify(evidence([order], [held], [{ ...plan, maxHoldUntil: new Date(now + 1).toISOString() }])) });
    expect((await read(now + 2)).positions[0].timeExit.status).toBe("due");
});


it("verifies flat exits only with fresh venue, inventory and order evidence", async () => {
    const flat = { ...held, quantity: 0, updatedAt: new Date(now - 1000) };
    const observe = (inventory = flat, orders: typeof order[] = [], quantity = 0, intents = [intent]) =>
        protectionEvidence([inventory], intents, [], { account: account(orders, quantity), observedAt: new Date(now) }, now);
    const proof = observe();
    expect(proof.flatPositions).toMatchObject([{ instrumentId, quantity: 0, noVenueOrders: true }]);
    expect(observe(flat, [order]).flatPositions).toEqual([]);
    expect(observe(flat, [], 1).flatPositions).toEqual([]);
    expect(observe({ ...flat, suspended: true }).flatPositions).toEqual([]);
    expect(observe({ ...flat, updatedAt: new Date(now + 1) }).flatPositions).toEqual([]);
    expect(protectionEvidence([flat], [{ ...intent, state: "unknown", reservedUsd: 0 }], [],
        { account: account([], 0), observedAt: new Date(now) }, now).flatPositions).toEqual([]);
    const db = { deskRecord: { findUnique: vi.fn(async () => ({ dataJson: JSON.stringify(proof) })) },
        deskExecutionState: { findUnique: vi.fn(async () => ({ lastSync: new Date(now), lastError: null })) },
        deskInventory: { findMany: vi.fn(async () => [flat]) },
        deskIntent: { findMany: vi.fn(async (): Promise<Array<{ instrumentId: string }>> => []) } };
    const read = (at = now) => readProtectionStatus(db as any, { id: "book", version: 12 }, at);
    expect((await read()).flatPositions).toHaveLength(1);
    expect((await read(now + 31000)).flatPositions).toEqual([]);
    db.deskInventory.findMany.mockResolvedValueOnce([{ ...flat, quantity: 1 }]);
    expect((await read()).flatPositions).toEqual([]);
    db.deskInventory.findMany.mockResolvedValueOnce([{ ...flat, updatedAt: new Date(now) }]);
    expect((await read()).flatPositions).toEqual([]);
    db.deskIntent.findMany.mockResolvedValueOnce([{ instrumentId }]);
    expect((await read()).flatPositions).toEqual([]);
});
