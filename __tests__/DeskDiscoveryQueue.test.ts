// @vitest-environment node
import { expect, it } from "vitest";
import { discoverMarket } from "@/lib/desk/discovery";
import { nativeInstruments } from "@/lib/desk/instruments";
import { advanceDiscovery, selectDiscoveryBatch, type DiscoveryState } from "@/lib/desk/discovery-queue";

const origin = Date.parse("2026-11-12T09:00:00Z");
const ids = Array.from({ length: 12 }, (_, n) => `COIN${n}`);
const instruments = nativeInstruments(false, ids.map(name => ({ name, szDecimals: 2 })), { tokens: [], universe: [] });
const scan = (at: number, options: { missing?: string; move?: number; funding?: number } = {}) => {
    const ticks = ids.filter(symbol => symbol !== options.missing).map((symbol, n) => ({ symbol, ts: new Date(at),
        markPrice: 120 - n + (n === 0 ? options.move ?? 0 : 0), openInterest: 1000,
        volume24h: 1_000_000, fundingRate: n === 0 ? options.funding ?? 0 : 0 }));
    const history = ticks.map(t => ({ ...t, markPrice: 100 }));
    return discoverMarket(instruments, ticks, history, history, [], [], at);
};

it("covers all eligible symbols and requires two distinct fresh collector snapshots", () => {
    const first = scan(origin, { missing: "COIN11" });
    const state = advanceDiscovery(null, first, origin)!;
    expect(state.coverage).toEqual({ eligible: 12, scanned: 11, unavailable: 1 });
    expect(selectDiscoveryBatch(state, origin)).toEqual([]);
    expect(advanceDiscovery(state, first, origin + 60000)).toBeNull();
    const later = origin + 60000;
    const updated = advanceDiscovery(state, scan(later), later)!;
    expect(selectDiscoveryBatch(updated, later)).toHaveLength(3);
    expect(updated.candidates["mainnet:perp:COIN11"].consecutive).toBe(0);
    expect(selectDiscoveryBatch(updated, later + 120001)).toEqual([]);
});

it("uses two highest scores plus oldest and applies both persisted cooldowns", () => {
    const later = origin + 60000;
    const state = advanceDiscovery(advanceDiscovery(null, scan(origin), origin), scan(later), later)!;
    state.candidates["mainnet:perp:COIN4"].qualifiedAt = origin;
    expect(selectDiscoveryBatch(state, later).map(c => c.symbol)).toEqual(["COIN0", "COIN1", "COIN4"]);
    state.lastDispatchedAt = later;
    state.delivered["mainnet:perp:COIN0"] = later;
    const restored = JSON.parse(JSON.stringify(state)) as DiscoveryState;
    const retry = later + 299999;
    const newer = advanceDiscovery(restored, scan(retry), retry)!;
    const qualified = advanceDiscovery(newer, scan(retry + 1), retry + 1)!;
    expect(selectDiscoveryBatch(qualified, retry)).toEqual([]);
    expect(selectDiscoveryBatch(qualified, retry + 1).map(c => c.symbol)).not.toContain("COIN0");
});

it("uses a rotating unexamined name only to fill available batch capacity", () => {
    const later = origin + 60000;
    const state = advanceDiscovery(advanceDiscovery(null, scan(origin), origin), scan(later), later)!;
    for (const row of Object.values(state.candidates)) if (!["COIN0", "COIN1"].includes(row.observation.symbol)) row.qualifiedAt = null;
    const batch = selectDiscoveryBatch(state, later);
    expect(batch).toHaveLength(3);
    expect(batch[2].reason).toBe("rotating_coverage");
});

it("does not treat missing or recovered data as a change and requeues material changes after two samples", () => {
    const id = "mainnet:perp:COIN0";
    let state = advanceDiscovery(null, scan(origin), origin)!;
    state.reviews[id] = { observed: state.candidates[id].observation, reviewedAt: origin };
    let now = origin;
    const step = (options: Parameters<typeof scan>[1]) => {
        now += 60000;
        state = advanceDiscovery(state, scan(now, options), now)!;
        return state.candidates[id];
    };
    expect(step({ missing: "COIN0" })).toBeUndefined();
    expect(step({}).reason).toBeNull();
    expect(step({ move: .99 }).reason).toBeNull();
    expect(step({ move: 1 }).qualifiedAt).toBeNull();
    expect(step({ move: 1 }).reason).toBe("material_change");
    expect(state.candidates[id].qualifiedAt).toBe(now);
    expect(selectDiscoveryBatch(state, now).map(c => c.symbol)).not.toContain("COIN0");
    while (now < origin + 600000) step({ funding: .0001 });
    expect(selectDiscoveryBatch(state, now)[0].changes).toContainEqual({ field: "fundingHourly", before: 0, after: .0001 });
});
