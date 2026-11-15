// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { DeskBook } from "@prisma/client";
import type { DeskInstrument } from "@/lib/desk/instruments";
import { DEFAULT_DESK_MANDATE } from "@/lib/desk/mandate";
const fixture = vi.hoisted(() => ({
    candles: vi.fn(),
    ticks: vi.fn(),
    tick: vi.fn(),
    sentiment: vi.fn(),
    opportunities: vi.fn(),
    historical: vi.fn(),
}));
vi.mock("@/lib/market-db", () => ({
    marketDbMain: {
        marketCandle: { findMany: fixture.candles },
        marketTick: { findMany: fixture.ticks, findFirst: fixture.tick },
    },
    marketDbTest: {},
}));
vi.mock("@/lib/db", () => ({
    prisma: {
        deskInventory: {findMany:async()=>[]}, deskIntent:{findMany:async()=>[]},
        deskRecord: { findMany: fixture.opportunities, findUnique: async () => null },
    },
}));
vi.mock("@/lib/desk/candle-history", async original => ({...await original<typeof import("@/lib/desk/candle-history")>(), historicalCandles:fixture.historical}));
import { quantitativeTools } from "@/lib/desk/analytics";
vi.mock("@/lib/desk/news-sentiment", () => ({ deskNewsSentiment: fixture.sentiment }));
const btc = {
    id: "mainnet:perp:BTC",
    coin: "BTC",
    base: "BTC",
    quote: "USDC",
    kind: "perp",
    isTestnet: false,
} as DeskInstrument;
const book = {
    id: "book",
    isTestnet: false,
    ownerAddress: "owner",
    mandateJson: JSON.stringify(DEFAULT_DESK_MANDATE),
} as DeskBook;
const context = {
    role: "derivatives" as const,
    shiftId: "s",
    callId: "c",
    signal: new AbortController().signal,
};
function setup() {
    const quote = vi.fn(async () => ({
        instrumentId: btc.id,
        bid: 100,
        ask: 100.01,
        time: Date.now(),
        spreadBps: 1,
        bids: [{ px: "100", sz: "10000" }],
        asks: [{ px: "100.01", sz: "10000" }],
    }));
    const tools = quantitativeTools({
        book,
        instruments: async () => [btc],
        instrument: async (id) => {
            if (id !== btc.id) throw new Error("Unknown instrument");
            return btc;
        },
        quote,
    });
    return {
        tools,
        quote,
        call: (
            name: string,
            args: Record<string, unknown> = { instrumentId: btc.id },
        ) => tools.find((t) => t.name === name)!.run(args, context),
    };
}
let snapshotClock = Date.now();
beforeEach(() => {
    // Each case supplies a different collector snapshot; expire the shared minute cache.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(snapshotClock += 120000);
    vi.clearAllMocks();
    fixture.candles.mockResolvedValue([]);
    fixture.ticks.mockResolvedValue([]);
    fixture.sentiment.mockResolvedValue({status:"unavailable",source:"news_intelligence"});
    fixture.opportunities.mockResolvedValue([]);
    fixture.historical.mockResolvedValue({bars:[],coverage:{},source:"test",retention:{}});
});
afterEach(() => { vi.useRealTimers(); });
describe("Centrypto analytical tool exposure", () => {
    it("exposes analytical capabilities read-only without fetching on construction", () => {
        const { tools, quote } = setup();
        expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining([
            "screen_markets",
            "technical_analysis",
            "market_regime",
            "market_structure",
            "sentiment_snapshot",
            "historical_move_study",
            "opportunity_diagnostics",
            "backtest_catalog",
            "backtest_strategy", "strategy_profile", "swing_context",
        ]));
        expect(tools.every((t) => t.access === "read" || t.access === "journal")).toBe(true);
        expect(quote).not.toHaveBeenCalled();
        expect(fixture.candles).not.toHaveBeenCalled();
    });
    it("returns missing history and sentiment as unavailable, not neutral or zero-valued metrics", async () => {
        const { call } = setup();
        expect(await call("technical_analysis")).toMatchObject({
            status: "data_unavailable",
            metrics: null,
            coverage: { count: 0 },
        });
        expect(await call("sentiment_snapshot")).toMatchObject({
            status: "unavailable",
            source: "news_intelligence",
        });
        expect(await call("opportunity_diagnostics")).toMatchObject({
            status: "unavailable",
            observations: [],
        });
        expect(fixture.opportunities).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({bookId:"book",dataJson:{contains:btc.id}}),
            }),
        );
    });
    it("retains supported indicators while masking unsupported longer-horizon defaults", async () => {
        const end = Math.floor(Date.now() / 60000) * 60000;
        fixture.candles.mockResolvedValue(
            Array.from({ length: 120 }, (_, i) => ({
                openTime: new Date(end - (120 - i) * 60000),
                open: 100 + i,
                high: 101 + i,
                low: 99 + i,
                close: 100 + i,
                volume: 10,
            })),
        );
        const { call } = setup();
        const result = (await call("technical_analysis")) as any;
        expect(result.status).toBe("observed");
        expect(result.metrics.returns.h1).toBeGreaterThan(0);
        expect(result.metrics.returns.h4).toBeNull();
        expect(result.metrics.macd.h1).toBeNull();
        expect(result.metrics.atr.h1).toBeNull();
        expect(result.metrics.rsi.m15).toBeNull();
        expect(result.coverage.contiguousMinutes).toBe(120);
    });
    it("does not run a live default-universe fallback when the collector has no fresh markets", async () => {
        const { call, quote } = setup();
        expect(await call("screen_markets", {})).toMatchObject({
            status: "no_qualified_candidates",
            scanned: 0,
            candidates: [],
            regime: { current: null, status: "insufficient_coverage" },
        });
        expect(quote).not.toHaveBeenCalled();
        expect(fixture.ticks).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    ts: { gte: expect.any(Date), lte: expect.any(Date) },
                    symbol: { in: ["BTC"] },
                }),
            }),
        );
    });
    it("ranks collector snapshots without hydrating technicals or books", async () => {
        const end = Math.floor(Date.now() / 60000) * 60000;
        fixture.candles.mockResolvedValue(
            Array.from({ length: 300 }, (_, i) => ({
                openTime: new Date(end - (300 - i) * 60000),
                open: 100 + Math.sin(i) * 0.3,
                high: 101,
                low: 99,
                close: 100 + Math.sin(i) * 0.3,
                volume: 10000,
            })),
        );
        fixture.ticks.mockResolvedValue([
            {
                symbol: "BTC",
                ts: new Date(),
                markPrice: 100,
                volume24h: 100000000,
                fundingRate: 0,
                openInterest: 100000,
            },
        ]);
        const { call } = setup(),
            result = (await call("screen_markets", {})) as any;
        expect(result.status).toBe("research_candidates");
        expect(result.researchShortlist[0].instrumentId).toBe(btc.id);
        expect(result.researchShortlist[0].liquidity.status).toBe("deferred");
        expect(fixture.candles).not.toHaveBeenCalled();
        expect(result.regime).toMatchObject({
            status: "insufficient_coverage",
            current: null,
            validSymbols: 0,
        });
    });
    it("rejects fresh-looking synthetic tails and stale or broken history", async () => {
        const end = Math.floor(Date.now() / 60000) * 60000;
        const rows = Array.from({ length: 120 }, (_, i) => ({
            openTime: new Date(end - (120 - i) * 60000),
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 0,
        }));
        fixture.candles.mockResolvedValue(rows);
        expect(await setup().call("technical_analysis")).toMatchObject({
            status: "data_unavailable",
            metrics: null,
        });
        fixture.candles.mockResolvedValue(
            rows.map((r) => ({
                ...r,
                volume: 10,
                openTime: new Date(+r.openTime - 600000),
            })),
        );
        expect(await setup().call("technical_analysis")).toMatchObject({
            status: "data_unavailable",
            metrics: null,
        });
        fixture.candles.mockResolvedValue(
            rows.filter((_, i) => i !== 80).map((r) => ({ ...r, volume: 10 })),
        );
        expect(await setup().call("technical_analysis")).toMatchObject({
            status: "data_unavailable",
            metrics: null,
            coverage: { contiguousMinutes: 39 },
        });
    });
});

it("allows explicit fine-grained context despite an unqualified reference pattern",async()=>{
    const {call,quote}=setup();
    const result=await call("swing_context",{instrumentId:btc.id,stage:"entry"}) as any;
    expect(fixture.historical.mock.calls.map(c=>c[1])).toEqual(["1h","15m","5m"]);
    expect(result).toMatchObject({mandatoryForDiscretionary:false,referencePatternReady:false});
    expect(quote).not.toHaveBeenCalled();
});
it("keeps automatic context reads staged when deeper evidence was not requested",async()=>{
    await setup().call("swing_context");
    expect(fixture.historical.mock.calls.map(c=>c[1])).toEqual(["1h"]);
});
