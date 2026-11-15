// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bandLiquidity } from "@/lib/desk/liquidity";
import type { DeskL2, Level } from "@/lib/desk/execution-types";

const mandate = { maxSlippageBps: 15, minDepthUsd: 2500 };
const levels = (rows: number[][]): Level[] => rows.map(([px, sz]) => ({ px: String(px), sz: String(sz) }));
const book = (bids: number[][], asks: number[][]): DeskL2 => ({ time: Date.now(), levels: [levels(bids), levels(asks)] });

describe("mandate band liquidity", () => {
    it("replays MEGA's saved book and excludes displayed prices outside the midpoint band", () => {
        const q = book([[.045478,15623],[.045476,7958],[.045457,4730],[.045439,8803],[.045414,8808],[.045413,16489]],
            [[.045539,4730],[.04554,7818],[.045541,1097],[.045567,4730],[.045579,8776],[.04558,16489]]);
        const result = bandLiquidity(q, mandate, 1);
        expect(result.asks.observedDepthUsd).toBeCloseTo(836.921577, 6);
        expect(result.asks).toMatchObject({ status: "insufficient", coverage: "complete_within_band", levelsWithinBand: 4 });
        expect(result.bids.observedDepthUsd).toBeCloseTo(1287.412412, 6);
    });
    it("counts liquidity beyond the sixth level and distinguishes a lower bound from a full band", () => {
        const asks = Array.from({ length: 7 }, (_, n) => [100.01 + n * .01, n === 6 ? 30 : 1]);
        const q = book([[99.99, 1],[99.80,100]], asks);
        expect(bandLiquidity(q, mandate, 1).asks).toMatchObject({ status: "sufficient", coverage: "lower_bound", returnedLevels: 7 });
        q.levels[1] = q.levels[1].slice(0, 6);
        expect(bandLiquidity(q, mandate, 1).asks).toMatchObject({ status: "incomplete", coverage: "lower_bound" });
        q.levels[1].push({ px: "100.16", sz: "1000" });
        expect(bandLiquidity(q, mandate, 1).asks).toMatchObject({ status: "insufficient", coverage: "complete_within_band" });
    });
    it("uses the correct side, inclusive boundaries, and explicit USD conversion", () => {
        const q = book([[99.99,1],[99.85,30],[99.84,1000]], [[100.01,1],[100.15,1],[100.16,1000]]);
        const result=bandLiquidity(q,mandate,1);
        expect(result.bids).toMatchObject({ orderSide: "sell", status: "sufficient", levelsWithinBand: 2 });
        expect(result.asks).toMatchObject({ orderSide: "buy", status: "insufficient", levelsWithinBand: 2 });
        expect(bandLiquidity(q,mandate,undefined).asks).toMatchObject({ observedDepthUsd: null, status: "usd_conversion_unavailable" });
        expect(bandLiquidity(q,mandate,2).asks.observedDepthUsd).toBeCloseTo(400.32);
    });
    it("rejects stale, crossed, malformed and unordered books instead of certifying depth", () => {
        const q = book([[99.99,1]], [[100.01,1],[100.02,1]]);
        expect(() => bandLiquidity({...q,time:Date.now()-6000},mandate,1)).toThrow(/Stale/);
        expect(() => bandLiquidity(book([[101,1]],[[100,1]]),mandate,1)).toThrow(/Crossed/);
        expect(() => bandLiquidity(book([[99,1]],[[100,1],[99.5,1]]),mandate,1)).toThrow(/Unsorted/);
        expect(() => bandLiquidity(book([[99,1]],[[100,-1]]),mandate,1)).toThrow(/quantity/);
    });
});
