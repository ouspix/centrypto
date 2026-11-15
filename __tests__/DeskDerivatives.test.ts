// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeInstruments } from "@/lib/desk/instruments";
import { deskFundingHistory, deskFundingSnapshot, fundingMetrics, spotBasisCandidates, summarizeFundingHistory } from "@/lib/desk/derivatives";
import { clearHyperliquidLimiterState, hyperliquidInfoPost } from "@/lib/rate-limit/hyperliquid-limiter";
import { roleInstructions } from "@/lib/desk/roles";

const context = { funding: "0.0000125", markPx: "102", oraclePx: "100", openInterest: "20", premium: "0.002" };

describe("derivatives economics", () => {
    it("uses hourly decimals and oracle notional, preserving payer direction and zero rates", () => {
        const result = fundingMetrics(context, 1, null, null);
        expect(result.hourlyFundingBps).toBe(0.125);
        expect(result.shortFundingPerHourPerVenueUnit).toBe(0.00125);
        expect(result.longFundingPerHourPerVenueUnit).toBe(-0.00125);
        expect(result.openInterestNotionalAtOracle).toBe(2000);
        expect(result.premiumBps).toBe(20);
        expect(fundingMetrics({ ...context, funding: "-0.00002" }, 1, null, null).shortFundingPerHourPerVenueUnit).toBe(-0.002);
        expect(fundingMetrics({ ...context, funding: "0", openInterest: "0", premium: null }, 1, null, null)).toMatchObject({ fundingRate: 0, openInterest: 0, premiumBps: null });
    });
    it("can show positive mark basis but negative executable carry in both directions", () => {
        const result = fundingMetrics(context, 1, { bid: 99, ask: 103 }, { bid: 99, ask: 101 });
        expect(result.basisBps).toBeCloseTo(200);
        expect(result.entryBasis!.longSpotShortPerpBps).toBeCloseTo((99 / 101 - 1) * 1e4);
        expect(result.entryBasis!.shortSpotLongPerpBps).toBeCloseTo((99 / 103 - 1) * 1e4);
    });
    it("normalizes k-contract prices without dividing oracle funding notional twice", () => {
        const result = fundingMetrics(context, 1000, { bid: 102, ask: 103 }, { bid: 0.099, ask: 0.101 });
        expect(result.basisBps).toBeCloseTo(200);
        expect(result.entryBasis!.longSpotShortPerpBps).toBeCloseTo((0.102 / 0.101 - 1) * 1e4);
        expect(result.shortFundingPerHourPerVenueUnit).toBe(0.00125);
        expect(result.openInterestNotionalAtOracle).toBe(2000);
    });
    it("rejects malformed funding and avoids inventing basis or open interest", () => {
        for (const funding of [undefined, null, "", "Infinity", "bad"]) {
            expect(() => fundingMetrics({ ...context, funding }, 1, null, null)).toThrow(/Invalid funding/);
        }
        expect(fundingMetrics({ ...context, openInterest: "-1" }, 1, null, { bid: 0, ask: 1 })).toMatchObject({ basisBps: null, entryBasis: null, openInterest: null });
        expect(fundingMetrics(context, 1, { bid: 105, ask: 100 }, { bid: 99, ask: 101 }).entryBasis).toBeNull();
    });
    it("requires canonical USDC and retains ambiguous ticker matches without aliasing wrappers", () => {
        const items = nativeInstruments(false, [{ name: "BTC", szDecimals: 5 }], {
            tokens: [
                { index: 0, name: "USDC", szDecimals: 8, tokenId: "cash" },
                { index: 1, name: "BTC", szDecimals: 5, tokenId: "one" },
                { index: 2, name: "BTC", szDecimals: 5, tokenId: "two" },
                { index: 3, name: "USDC", szDecimals: 8, tokenId: "fake-cash" },
                { index: 4, name: "UBTC", szDecimals: 5, tokenId: "wrapped" },
            ],
            universe: [
                { index: 1, name: "@1", tokens: [1, 0] },
                { index: 2, name: "@2", tokens: [2, 0] },
                { index: 3, name: "@3", tokens: [1, 3] },
                { index: 4, name: "@4", tokens: [4, 0] },
            ],
        });
        expect(spotBasisCandidates(items[0], items).map(i => i.id)).toEqual(["mainnet:spot:1", "mainnet:spot:2"]);
    });
    it("summarizes settled history without counting duplicates, missing hours or other instruments as payments", () => {
        const row = (time: number, fundingRate: string, coin = "BTC") => ({ time, fundingRate, coin });
        const start = Date.UTC(2026, 10, 4, 0, 30), end = start + 4 * 3600000;
        const hour = Date.UTC(2026, 10, 4, 1);
        const result = summarizeFundingHistory([
            row(hour + 2 * 3600000, "-0.0001"), row(hour, "0.0002"), row(hour, "0.0002"),
            row(hour + 3600000, "bad"), row(hour + 3600000, "0.5", "ETH"), row(end + 1, "0.5"),
        ], "BTC", start, end);
        expect(result).toMatchObject({ sampleCount: 2, missingHourlySamples: 2, positiveHours: 1, negativeHours: 1, meanHourlyRate: 0.00005, sumHourlyRates: 0.0001 });
        expect(result.recent[0].at).toBe(new Date(hour).toISOString());
        expect(summarizeFundingHistory([], "BTC", start, end)).toMatchObject({ sampleCount: 0, missingHourlySamples: 4, sumHourlyRates: null, lastAt: null });
    });
    it("keeps the role focused on changed evidence and separates missing data from negative edge", () => {
        const prompt = roleInstructions("derivatives", { live: true, consult: false });
        expect(prompt).toContain("funding_history");
        expect(prompt).toContain("perpetuals have no contractual maturity");
        expect(prompt).toContain("unknown economics");
        expect(prompt).toContain("Do not rebuild unchanged BTC/ETH carry");
        expect(prompt).toContain("catalyst trader's directional thesis");
    });
});

describe("fresh derivatives data", () => {
    beforeEach(() => { clearHyperliquidLimiterState(); vi.stubEnv("HL_MIN_DELAY_MS", "0"); });
    it("does not relabel the general stale cache as a fresh funding snapshot", async () => {
        const snapshot = [{ universe: [{ name: "BTC" }] }, [context]];
        const fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => snapshot })
            .mockRejectedValue(new Error("offline"));
        vi.stubGlobal("fetch", fetch);
        try {
            await hyperliquidInfoPost("hl:info:metaAndAssetCtxs", "https://api.hyperliquid.xyz/info",
                { type: "metaAndAssetCtxs" }, { ttlMs: 60_000, staleMs: 60_000, allowStale: true });
            await expect(deskFundingSnapshot(false)).rejects.toThrow("offline");
            expect(fetch).toHaveBeenCalledTimes(2);
        } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it("bounds history queries, uses the selected network, and rejects malformed snapshots", async () => {
        const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
        vi.stubGlobal("fetch", fetch);
        try {
            for (const hours of [0, 73, 1.5, NaN]) await expect(deskFundingHistory(true, "BTC", hours)).rejects.toThrow(/1 to 72/);
            expect(fetch).not.toHaveBeenCalled();
            const end = Date.UTC(2026, 10, 4, 12, 30);
            const result = await deskFundingHistory(true, "BTC", 24, end);
            expect(fetch).toHaveBeenCalledWith("https://api.hyperliquid-testnet.xyz/info", expect.objectContaining({ body: JSON.stringify({ type: "fundingHistory", coin: "BTC", startTime: end - 24 * 3600000, endTime: end }) }));
            expect(result.missingHourlySamples).toBe(24);
            await expect(deskFundingSnapshot(false)).rejects.toThrow(/unavailable/);
        } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
});
