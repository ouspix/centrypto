import { describe, expect, it } from "vitest";
import {
    breakevenStopPrice,
    directionalBps,
    givebackPct,
    netCurrentBps,
    stopDistanceBps,
    takeProfitDistanceBps,
    trailingStopPrice
} from "@/lib/trader/position-management-math";

describe("position-management math", () => {
    it("computes directional bps for long and short positions", () => {
        expect(directionalBps("long", 100, 101)).toBe(100);
        expect(directionalBps("short", 100, 99)).toBe(100);
    });

    it("computes net current bps after exit fees and buffer", () => {
        expect(netCurrentBps(25, 4, 5)).toBe(16);
    });

    it("computes giveback pct and allows values above 100", () => {
        expect(givebackPct(50, 20)).toBe(60);
        expect(givebackPct(50, -10)).toBe(100);
        expect(givebackPct(50, -200)).toBe(100);
    });

    it("computes breakeven stops for long and short positions", () => {
        expect(breakevenStopPrice("long", 100, 5)).toBeCloseTo(100.05, 8);
        expect(breakevenStopPrice("short", 100, 5)).toBeCloseTo(99.95, 8);
    });

    it("computes trailing stops for long and short positions", () => {
        expect(trailingStopPrice("long", 100, 20)).toBeCloseTo(99.8, 8);
        expect(trailingStopPrice("short", 100, 20)).toBeCloseTo(100.2, 8);
    });

    it("computes TP and SL distances for both sides", () => {
        expect(stopDistanceBps("long", 100, 99)).toBe(100);
        expect(stopDistanceBps("short", 100, 101)).toBe(100);
        expect(takeProfitDistanceBps("long", 100, 102)).toBe(200);
        expect(takeProfitDistanceBps("short", 100, 98)).toBe(200);
    });
});
