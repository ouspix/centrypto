// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertAllocationTicket, validateAllocationReview } from "@/lib/desk/allocation-review";
import { summarizeAllocations } from "@/lib/desk/allocation-context";
import { allocationReview, reviewedProposal } from "./fixtures/allocation-review";
import type { DeskOrder } from "@/lib/desk/execution-types";

const now = Date.now();
const order: DeskOrder = { instrumentId: "mainnet:perp:ETH", side: "buy", quantity: 2, limitPrice: 100, stopPrice: 98,
    thesis: "Range recovery with explicit contrary evidence", strategyVersion: "desk-discretionary-1", proposalKey: "recovery", maxHoldHours: 2,
    entryExpiresAt: new Date(now + 60000).toISOString() };

describe("discretionary allocation admission", () => {
    it("accepts unequal payoff geometry, unknown magnitudes and either direction without numeric alpha gates", () => {
        const p = reviewedProposal(order);
        expect(assertAllocationTicket(p, order, now).allocation.payoff.failure.netReturnBps).toBe(-80);
        p.decisionPlan!.allocation!.payoff.continuation.netReturnBps = null;
        expect(() => assertAllocationTicket(p, order, now)).not.toThrow();
        const short = { ...order, side: "sell" as const, stopPrice: 102 };
        expect(() => assertAllocationTicket(reviewedProposal(short), short, now)).not.toThrow();
    });
    it("rejects missing reviews and mismatched tickets while accepting a better price and smaller quantity", () => {
        const p = reviewedProposal(order);
        delete p.decisionPlan!.allocation;
        expect(() => assertAllocationTicket(p, order, now)).toThrow(/allocation/);
        const valid = reviewedProposal(order);
        for (const change of [{ side: "sell" as const }, { quantity: 3 }, { limitPrice: 101 }, { stopPrice: 97 }, { maxHoldHours: 3 }])
            expect(() => assertAllocationTicket(valid, { ...order, ...change }, now)).toThrow(/differs/);
        expect(() => assertAllocationTicket(valid, { ...order, limitPrice: 99.9, quantity: 1 }, now)).not.toThrow();
        expect(() => assertAllocationTicket({ ...valid, status: "closed" }, order, now)).toThrow(/current live/);
    });
    it("requires support for extension without treating a prior high as a hard payoff ceiling", () => {
        const review = allocationReview(); review.payoff.extensionRequired = true;
        expect(() => validateAllocationReview(review)).toThrow(/extension/);
        review.payoff.extensionEvidence = "Observed range expansion at this horizon supports extension, with unidentified future demand explicitly unresolved.";
        expect(() => validateAllocationReview(review)).not.toThrow();
    });
    it("makes event sizing, abstention and timing decisions constrain the actual ticket", () => {
        const p = reviewedProposal(order), event = p.decisionPlan!.allocation!.eventRisk;
        event.status = "identified"; event.events = [{ name: "PPI", at: new Date(now + 3 * 3600000).toISOString(), relevance: "Can reverse this and other recovery allocations together." }];
        event.action = "reduce_size"; event.maxNotionalUsd = 150;
        expect(() => assertAllocationTicket(p, order, now)).toThrow(/notional cap/);
        expect(() => assertAllocationTicket(p, { ...order, quantity: 1 }, now)).not.toThrow();
        event.action = "wait";
        expect(() => assertAllocationTicket(p, { ...order, quantity: 1 }, now)).toThrow(/does not authorize/);
        event.action = "exit_before_event"; event.maxNotionalUsd = null; event.exitBefore = new Date(now + 2 * 3600000).toISOString();
        expect(() => assertAllocationTicket(p, order, now)).toThrow(/expiry plus holding/);
        event.exitBefore = new Date(now + 3 * 3600000).toISOString();
        expect(() => assertAllocationTicket(p, order, now)).not.toThrow();
        event.action = "enter_as_sized"; event.exitBefore = null;
        expect(() => assertAllocationTicket(p, order, now)).not.toThrow();
    });
});

describe("actual theme outcomes and shared exposure", () => {
    const intent = (id: string, side = "buy", reduceOnly = false) => ({ id, side, instrumentId: "mainnet:perp:ETH", requestJson: JSON.stringify({ reduceOnly }), state: "filled", reservedUsd: 0, quantity: 2, filledQty: 2, limitPrice: 100, createdAt: new Date(now) });
    const flow = (intentId: string | null, quantity: number, pnlUsd: number, feeUsd: number, offset: number, kind = "fill") => ({ intentId, quantity, pnlUsd, feeUsd, instrumentId: "mainnet:perp:ETH", occurredAt: new Date(now + offset), kind });
    it("groups partial fills into episodes, includes fees once and funding, and retains immutable family attribution across reentries", () => {
        const second = allocationReview(); second.theme.family = "continuation";
        const result = summarizeAllocations({ from: new Date(now), now: new Date(now + 100), positions: [],
            intents: [intent("entry"), intent("exit", "sell", true), intent("again"), intent("exit2", "sell", true)],
            receipts: [{ intentId: "entry", allocation: allocationReview() }, { intentId: "again", allocation: second }],
            flows: [flow("entry", 1, -.1, .1, 0), flow("entry", 1, -.1, .1, 1), flow(null, 0, -.02, 0, 2, "funding"),
                flow("exit", -1, 1.9, .1, 3), flow("entry", -1, 1.9, .1, 4, "protection"), flow("again", 2, -.2, .2, 5), flow("exit2", -2, -2.2, .2, 6)] });
        expect(result.patternOutcomes).toHaveLength(2);
        expect(result.patternOutcomes[0]).toMatchObject({ family: "recovery", closedEpisodes: 1, closedFeesUsd: .4, closedFundingUsd: -.02 });
        expect(result.patternOutcomes[0].closedNetUsd).toBeCloseTo(3.58);
        expect(result.patternOutcomes[1].closedNetUsd).toBeCloseTo(-2.4);
    });
    it("counts common-direction pending exposure without mistaking legacy history or incomplete episodes for validated performance", () => {
        const result = summarizeAllocations({ from: new Date(now), now: new Date(now + 100), receipts: [],
            positions: [{ instrumentId: "mainnet:perp:ETH", quantity: 2, basis: 100, stopPrice: 98, suspended: false, since: new Date(now) }],
            intents: [intent("entry"), { ...intent("pending"), instrumentId: "mainnet:perp:BNB", filledQty: 0, state: "unknown", reservedUsd: 200 }],
            flows: [flow(null, -1, 2, .1, -1), flow("entry", 2, -.2, .2, 0)] });
        expect(result.patternOutcomes[0]).toMatchObject({ family: "legacy_unclassified", closedEpisodes: 0, openEpisodes: 1, closedNetUsd: 0 });
        expect(result.directionalExposure[0]).toMatchObject({ instruments: ["mainnet:perp:ETH", "mainnet:perp:BNB"], basisNotionalUsd: 200, pendingNotionalUsd: 200, basisToStopUsd: 4 });
        expect(result.attribution.unattributedFlows).toBe(1);
    });
});
