// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assessNewsMomentum, NEWS_STRATEGY_PROFILE, type NewsStrategyInput } from "@/lib/desk/news-strategy";
import { parseDeskOrder } from "@/lib/desk/execution-risk";

function input(): NewsStrategyInput {
    const now = Date.parse("2026-11-10T10:20:02Z"), url = "https://issuer.example/selection";
    return { now, instrumentId: "mainnet:perp:AVAX", side: "buy",
        event: { key: "selection", revisionId: 12, firstSeenAt: now - 15 * 60_000,
            publishedAt: now - 16 * 60_000, availableAt: now - 10 * 60_000,
            expiresAt: now + 3600_000, change: "announcement", impact: "catalyst", direction: "bullish",
            material: true, contradictions: [], instrumentMatched: true, primaryUrls: [url] },
        primary: { url, evidenceId: "web-123", verifiedAt: now - 3 * 60_000, expiresAt: now + 2 * 60_000 },
        arrival: { price: 8.4, at: now - 10 * 60_000 + 1000 },
        quote: { bid: 8.55, ask: 8.551, at: now - 500 },
        bars: [
            { at: Date.parse("2026-11-10T10:10:00Z"), open: 8.4, high: 8.5, low: 8.38, close: 8.48, volume: 100 },
            { at: Date.parse("2026-11-10T10:15:00Z"), open: 8.48, high: 8.56, low: 8.45, close: 8.55, volume: 150 },
        ] };
}

describe("news-momentum-1 causal candidate assessment", () => {
    it("evaluates a post-verification breakout without 4h alignment, but never authorizes an order", () => {
        const r = assessNewsMomentum(input());
        expect(r.status).toBe("candidate");
        expect(r.blockers).toEqual([]);
        expect(r.executionAuthorized).toBe(false);
        expect(r.stopPrice).toBe(8.38);
        expect(r.entryExpiresAt).toBe("2026-11-10T10:22:02.000Z");
        expect(NEWS_STRATEGY_PROFILE.activationSupported).toBe(false);
    });

    it.each<[string, (i: NewsStrategyInput) => void]>([
        ["event_window_expired", i => { i.event.firstSeenAt = i.now - 2 * 3600_000; }],
        ["event_window_expired", i => { i.event.publishedAt = i.now - 2 * 3600_000; }],
        ["invalid_or_expired_event_times", i => { i.event.availableAt = i.now + 1000; }],
        ["invalid_or_expired_event_times", i => { i.event.expiresAt = i.now; }],
        ["invalid_or_expired_event_times", i => { i.event.firstSeenAt = NaN; }],
        ["not_a_new_catalyst_announcement", i => { i.event.change = "repeat"; }],
        ["not_a_new_catalyst_announcement", i => { i.event.change = "retraction"; }],
        ["not_a_new_catalyst_announcement", i => { i.event.material = false; }],
        ["direction_or_contradiction_unresolved", i => { i.event.contradictions = ["counterparty denial"]; }],
        ["direction_or_contradiction_unresolved", i => { i.event.direction = "mixed"; }],
        ["exact_native_perpetual_link_required", i => { i.event.instrumentMatched = false; }],
        ["exact_native_perpetual_link_required", i => { i.instrumentId = "mainnet:spot:AVAX0"; }],
        ["current_primary_read_required", i => { i.primary = null; }],
        ["current_primary_read_required", i => { i.primary!.verifiedAt = i.now + 1000; }],
        ["current_primary_read_required", i => { i.primary!.verifiedAt = i.event.availableAt - 1; }],
        ["current_primary_read_required", i => { i.primary!.expiresAt = i.now; }],
        ["primary_source_not_bound_to_event", i => { i.primary!.url = "https://issuer.example/tokenomics"; }],
        ["timely_event_arrival_quote_required", i => { i.arrival = null; }],
        ["timely_event_arrival_quote_required", i => { i.arrival!.at = i.event.availableAt - 1; }],
        ["timely_event_arrival_quote_required", i => { i.arrival!.at = i.event.availableAt + 60_001; }],
        ["maximum_chase_exceeded", i => { i.quote.bid = 9; i.quote.ask = 9.001; }],
        ["spread_too_wide", i => { i.quote.ask = 8.6; }],
        ["fresh_executable_quote_required", i => { i.quote.at = i.now - 5001; }],
        ["fresh_executable_quote_required", i => { i.quote.at = i.now + 1001; }],
        ["fresh_executable_quote_required", i => { i.quote.ask = 8; }],
        ["fresh_contiguous_closed_bars_required", i => { i.bars[0].at -= 300_000; }],
        ["fresh_contiguous_closed_bars_required", i => { i.bars[1].at += 300_000; }],
        ["fresh_contiguous_closed_bars_required", i => { i.bars[1].low = 9; }],
        ["wait_for_post_verification_bar", i => { i.primary!.verifiedAt = i.now - 1000; }],
        ["closed_bar_breakout_required", i => { i.bars[1].close = 8.49; }],
        ["executed_volume_expansion_required", i => { i.bars[1].volume = 99; }],
        ["structural_stop_invalid", i => { i.quote.bid = 8.3; i.quote.ask = 8.301; }],
    ])("blocks %s", (blocker, mutate) => {
        const i = input(); mutate(i);
        const r = assessNewsMomentum(i);
        expect(r.status).toBe("blocked"); expect(r.blockers).toContain(blocker);
        expect(r.executionAuthorized).toBe(false);
    });

    it("supports a mirrored bearish hypothesis using executable bid and a stop above entry", () => {
        const i = input(); i.side = "sell"; i.event.direction = "bearish";
        i.quote = { bid: 8.2, ask: 8.201, at: i.now };
        i.bars[1] = { ...i.bars[1], open: 8.4, high: 8.45, low: 8.19, close: 8.2 };
        const r = assessNewsMomentum(i);
        expect(r.status).toBe("candidate"); expect(r.stopPrice).toBe(8.5); expect(r.entryPrice).toBe(8.2);
    });

    it("cannot turn a candidate into a live order through the common parser", () => {
        const r = assessNewsMomentum(input());
        expect(() => parseDeskOrder({ instrumentId: r.instrumentId, side: "buy", quantity: 1,
            limitPrice: 8.551, stopPrice: 8.38, thesis: "Selection announcement", strategyVersion: r.strategyVersion,
            proposalKey: "news-selection", eventId: r.eventKey, maxHoldHours: 2, entryExpiresAt: r.entryExpiresAt! }))
            .toThrow(/implementation-only/);
    });
});
