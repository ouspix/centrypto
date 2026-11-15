// @vitest-environment node
import { describe, it, expect } from "vitest";
import { missedFillReview, boundedRecoveryOrder, recoverySuffix } from "@/lib/desk/missed-fill";
const now = Date.parse("2026-11-11T21:24:00Z");
const order = { side: "buy", quantity: 817, limitPrice: .14492, stopPrice: .13818,
    takeProfitPrice: .1543, maxHoldHours: 4, entryExpiresAt: "2026-11-11T21:28:00Z", strategyVersion: "desk-discretionary-1" };
const intent = { id: "original", intentKey: "shift:ticket", state: "rejected", filledQty: 0,
    reason: "Order could not immediately match against any resting orders. asset=193", requestJson: JSON.stringify(order) };
describe("bounded missed fill recovery", () => {
    it("preserves all original protections and accepts only same or better prices and smaller size", () => {
        expect(missedFillReview(intent, now).eligible).toBe(true);
        expect(boundedRecoveryOrder(intent, 800, .1448, now)).toEqual({ ...order, quantity: 800, limitPrice: .1448 });
        expect(() => boundedRecoveryOrder(intent, 818, .1448, now)).toThrow("cannot increase");
        expect(() => boundedRecoveryOrder(intent, 817, .14493, now)).toThrow("cannot increase");
        const short = { ...intent, requestJson: JSON.stringify({ ...order, side: "sell" }) };
        expect(() => boundedRecoveryOrder(short, 800, .1448, now)).toThrow();
        expect(boundedRecoveryOrder(short, 800, .145, now).limitPrice).toBe(.145);
    });
    it("excludes expired, uncertain, partial, unrelated and repeat rejections", () => {
        for (const change of [{ state: "unknown" }, { state: "submitting" }, { filledQty: 1 },
            { reason: "Insufficient margin" }, { intentKey: intent.intentKey + recoverySuffix },
            { requestJson: JSON.stringify({ ...order, reduceOnly: true }) }]) {
            expect(missedFillReview({ ...intent, ...change }, now).eligible).toBe(false);
            expect(() => boundedRecoveryOrder({ ...intent, ...change }, 800, .1448, now)).toThrow();
        }
        expect(missedFillReview(intent, Date.parse(order.entryExpiresAt)).eligible).toBe(false);
    });
});
