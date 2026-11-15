import { describe, expect, it } from "vitest";
import { barFeatures, instrumentFeatures, intervals, marketBreadth, minute, type MarketFeatureRow, type MarketFeatureSnapshot } from "@/lib/desk/market-features";
import { parseScreenQuery, rankScreen } from "@/lib/desk/market-screen";
import { discoverMarket } from "@/lib/desk/discovery";
import { advanceDiscovery, materialDiscoveryChanges, selectDiscoveryBatch } from "@/lib/desk/discovery-queue";
import { nativeInstruments } from "@/lib/desk/instruments";

const step = intervals["15m"];
const end = Date.UTC(2026, 10, 13, 8);
function candles(price = 100) {
    return Array.from({ length: 50 }, (_, i) => ({
        at: end - (50 - i) * step, open: price, close: price, high: price + (i < 45 ? 2 : .1),
        low: price - (i < 45 ? 2 : .1), volume: i === 49 ? 20 : 10,
    }));
}
function row(symbol: string, features = instrumentFeatures(candles(), end)): MarketFeatureRow {
    return { ...features, instrumentId: "mainnet:perp:" + symbol, symbol, observedAt: end, price: 100,
        volume24h: 50000, fundingHourly: null, fundingSamples: 0, fundingPercentile: null,
        openInterestBase: 4, openInterestUsd: 400, oiChange1hPct: null, basisBps: null, spreadBps: null };
}
function snapshot(rows: MarketFeatureRow[]): MarketFeatureSnapshot {
    return { version: 1, id: "test", asOf: end, network: "mainnet", instruments: rows, candleError: null, durationMs: 0 };
}

describe("market context and screening", () => {
    it("uses the prior range and volume baseline, and excludes forming or gapped bars", () => {
        const bars = candles();
        bars.push({ ...bars.at(-1)!, at: end, close: 500, high: 600, volume: 500 });
        const result = barFeatures(bars, step, end + minute)!;
        expect(result).toMatchObject({ priorHigh: 102, priorLow: 98, close: 100, relativeVolume: 2 });
        expect(result.compression).toBeCloseTo(.05);
        expect(barFeatures(bars.filter((_, i) => i !== 48), step, end)).toBeNull();
        expect(barFeatures(bars.map(x => ({ ...x, high: x.close, low: x.close })), step, end)?.atrBps).toBeNull();
    });
    it("finds quiet compression and counts missing filters separately", () => {
        const input = snapshot([row("BTC"), row("ALT"), row("NEW", instrumentFeatures([], end))]);
        const query = parseScreenQuery({ preset: "compression", timeframe: "15m", direction: "short",
            filters: [{ metric: "compression", op: "lte", value: .1 }], limit: 1 });
        const result = rankScreen(input, query, [], end);
        expect(result.coverage).toMatchObject({ fresh: 3, structural: 2, missingFilter: 1 });
        expect(result.candidates.map(c => [c.symbol, c.direction])).toEqual([["ALT", "short"], ["BTC", "short"]]);
        expect(() => parseScreenQuery({ limit: 0 })).toThrow();
        expect(() => parseScreenQuery({ sort: [{ metric: "__proto__", order: "asc" }] })).toThrow();
    });
    it("excludes stale rows and mismatched benchmark closes from breadth comparisons", () => {
        const btc = row("BTC"), alt = row("ALT");
        alt.returnClosedAt = end - step;
        const result = marketBreadth([btc, alt, { ...row("OLD"), observedAt: end - 3 * minute }], end);
        expect(result["15m"]).toMatchObject({ eligible: 3, measured: 2, versusBtcMeasured: 0, outperformBtc: null });
    });
    it("dispatches a quiet exploration candidate after two distinct ticks even without priorities", () => {
        const universe = nativeInstruments(false, [{ name: "ALT", szDecimals: 2 }], { tokens: [], universe: [] });
        const scan = (now: number) => ({
            ...discoverMarket(universe, [{ symbol: "ALT", ts: new Date(now), markPrice: 100, volume24h: null, fundingRate: null, openInterest: null }], [], [], [], [], now),
            featureVersion: 1, priorityIds: [],
        });
        const first = advanceDiscovery(null, scan(end), end)!;
        expect(selectDiscoveryBatch(first, end)).toEqual([]);
        expect(advanceDiscovery(first, scan(end), end)).toBeNull();
        const next = advanceDiscovery(first, scan(end + minute), end + minute)!;
        expect(selectDiscoveryBatch(next, end + minute)).toMatchObject([{ symbol: "ALT", reason: "rotating_coverage" }]);
    });
    it("treats setup changes as material while ignoring identical setup facts and timestamp churn", () => {
        const setup = { view: "breakout" as const, side: "long" as const, boundary: 105, beyond: false, displacement: -.2 };
        const base = { observedAt: end, return1hBps: 0, return4hBps: 0, fundingHourly: null, oiChange1hPct: null, setup };
        expect(materialDiscoveryChanges(base, { ...base, observedAt: end + minute })).toEqual([]);
        expect(materialDiscoveryChanges(base, { ...base, setup: { ...setup, beyond: true } })).toMatchObject([{ field: "setup" }]);
    });
});
