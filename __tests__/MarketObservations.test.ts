// @vitest-environment node
import { describe, expect, it } from "vitest";
import { candleObservation, observationsAsOf, liquidityFeatures } from "@/lib/market-observations";

describe("market observation availability", () => {
    const base = candleObservation({ symbol: "BTC", timeframe: "1m", openTime: new Date(0), receivedAt: new Date(61000), source: "test", open: 100, high: 115, low: 99, close: 110, volume: 10 });
    it("cannot move a late backfill or corrected candle into an earlier decision", () => {
        const original = { ...base, recordedAt: new Date(62000) };
        const corrected = { ...base, close: 112, receivedAt: new Date(120000), recordedAt: new Date(121000) };
        expect(observationsAsOf([corrected, original], new Date(65000))).toEqual([original]);
        expect(observationsAsOf([original, corrected], new Date(125000))).toEqual([corrected]);
        expect(observationsAsOf([base], new Date(125000))).toEqual([]);
        expect(observationsAsOf([original], new Date(61500))).toEqual([]);
    });
    it("waits for the candle close even when an intrabar revision is already received", () => {
        expect(observationsAsOf([{ ...base, receivedAt: new Date(30000), recordedAt: new Date(31000) }], new Date(40000))).toEqual([]);
    });
    it("computes spread without sizes and leaves size-dependent liquidity missing", () => {
        const values = liquidityFeatures({ bid: 99, ask: 101, receivedAt: new Date(0) }, new Date(1000));
        expect(values.liquidity_spread_bps).toBe(200);
        expect(values.liquidity_log_min_side_usd).toBeNull();
        expect(values.liquidity_imbalance).toBeNull();
        expect(liquidityFeatures({ bid: 99, ask: 101, receivedAt: new Date(0) }, new Date(60001)).liquidity_spread_bps).toBeNull();
        expect(liquidityFeatures({ bid: 99, ask: 101, receivedAt: new Date(2000) }, new Date(1000)).liquidity_spread_bps).toBeNull();
    });
});
