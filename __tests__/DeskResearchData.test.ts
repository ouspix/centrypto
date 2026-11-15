// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
    candleCoverage,
    historicalMoveStudy,
    type ResearchCandle,
} from "@/lib/desk/research-data";
const now = Date.UTC(2026, 10, 6, 12);
const candles = (n = 300): ResearchCandle[] =>
    Array.from({ length: n }, (_, i) => {
        const close = 100 * 1.001 ** i;
        return {
            openTime: new Date(now - (n - i) * 60000),
            open: close,
            high: close,
            low: close,
            close,
            volume: 10,
        };
    });
describe("desk research data quality", () => {
    it("excludes open/invalid candles and exposes gaps instead of filling prices", () => {
        const rows = candles(10);
        rows.splice(6, 1);
        rows.push(
            { ...rows[0], openTime: new Date(now), close: 1000 },
            { ...rows[0], openTime: new Date(now - 11 * 60000), volume: -1 },
        );
        const c = candleCoverage(rows, now);
        expect(c).toMatchObject({
            count: 9,
            contiguous: 3,
            missingMinutes: 1,
            fresh: true,
        });
        expect(candleCoverage(candles(), now + 240000).fresh).toBe(false);
    });
    it("reports non-overlapping historical sensitivities and refuses small samples", () => {
        const result = historicalMoveStudy(candles(), 5, 5, "up", 1, now);
        expect(result.status).toBe("descriptive_sample");
        expect(result.samples).toBe(58);
        expect(result.forwardReturnBps!.median).toBeCloseTo(
            (1.001 ** 5 - 1) * 10000,
            5,
        );
        expect(
            historicalMoveStudy(candles(60), 5, 5, "up", 1, now),
        ).toMatchObject({
            status: "insufficient_sample",
            forwardReturnBps: null,
        });
        expect(
            historicalMoveStudy(candles(), 5, 5, "down", 1, now).samples,
        ).toBe(0);
    });
});
