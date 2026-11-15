// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { DeskBook, DeskShift } from "@prisma/client";
import { nativeInstruments } from "@/lib/desk/instruments";
import { SWING_DESK_MANDATE } from "@/lib/desk/mandate";

const fixture = vi.hoisted(() => ({
    book: {} as DeskBook, shift: {} as DeskShift,
    intent: vi.fn(), plan: vi.fn(), account: vi.fn(), preview: vi.fn(), execute: vi.fn(), wake: vi.fn(), instruments: vi.fn(), quote: vi.fn(), snapshot: vi.fn(), history: vi.fn(), record: vi.fn(), candles: vi.fn(),
}));
vi.mock("@/lib/rate-limit/hyperliquid-limiter", async original => ({
    ...await original<typeof import("@/lib/rate-limit/hyperliquid-limiter")>(), hyperliquidInfoPost: fixture.candles,
}));
vi.mock("@/lib/db", () => ({ prisma: {
    deskIntent: { findUnique: fixture.intent, findMany: async()=>[] }, deskInventory:{findMany:async()=>[],findUnique:async()=>null}, deskWake: { upsert: fixture.wake },
    deskArtifact: { upsert: async () => ({}) },
    deskBook: { findUnique: async () => fixture.book },
    deskShift: { findUnique: async () => fixture.shift },
    deskRecord: { upsert: fixture.record, findUnique: fixture.plan, findMany: async()=>[{dataJson:JSON.stringify({status:"researching",validUntil:new Date(Date.now()+3600000).toISOString(),legs:[{instrumentId:perpId},{instrumentId:spotId}],researchPlan:[{nextTool:"funding_and_basis",status:"ready"}]})}] },
} }));
vi.mock("@/lib/desk/instruments", async original => ({
    ...await original<typeof import("@/lib/desk/instruments")>(), listInstruments: fixture.instruments,
}));
vi.mock("@/lib/desk/market", async original => ({
    ...await original<typeof import("@/lib/desk/market")>(), publicQuote: fixture.quote, accountExposure:fixture.account,
}));
vi.mock("@/lib/desk/derivatives", async original => ({
    ...await original<typeof import("@/lib/desk/derivatives")>(), deskFundingSnapshot: fixture.snapshot, deskFundingHistory: fixture.history,
}));
import Ajv from "ajv";
vi.mock("@/lib/desk/execution", async original => ({
    ...await original<typeof import("@/lib/desk/execution")>(), previewDeskOrder: fixture.preview, executeDeskOrder: fixture.execute,
}));
import { deskTools } from "@/lib/desk/tools";

it("keeps candle resolution caches separate and preserves forming status across a boundary", async () => {
    const tools = deskTools(fixture.book, fixture.shift);
    const history = tools.find(t => t.name === "market_history")!;
    const since = new Date(now - 6 * 3600000).toISOString();
    fixture.candles.mockResolvedValue([{ t: now - 900000, T: now - 1, c: "100", v: "1000" }, { t: now, T: now + 1000, c: "101", v: "1" }]);
    const first: any = await history.run({ instrumentId: perpId, interval: "15m", since }, context);
    expect(first.candles.map((c: any) => c.closed)).toEqual([true, false]);
    expect(fixture.candles.mock.calls[0][2].req.interval).toBe("15m");
    expect(fixture.candles.mock.calls[0][3]).toMatchObject({ allowStale: false });
    vi.advanceTimersByTime(2000);
    const cached: any = await history.run({ instrumentId: perpId, interval: "15m", since }, { ...context, callId: "cached" });
    expect(cached.candles[1].closed).toBe(false);
    expect(fixture.candles).toHaveBeenCalledTimes(1);
    await history.run({ instrumentId: perpId, interval: "1h", since }, { ...context, callId: "hour" });
    expect(fixture.candles).toHaveBeenCalledTimes(2);
});

it("exposes scenario arithmetic as a read-only tool for the resolved venue instrument", async () => {
    const tool = deskTools(fixture.book, fixture.shift).find(t => t.name === "assess_trade_scenarios")!;
    const args = { instrumentId: perpId, side: "buy", quantity: 1, entryPrice: 100,
        entryFeeRate: 0.001, exitFeeRate: 0.001, horizonHours: 6, assumptions: "Sensitivity only", evidenceIds: [],
        scenarios: [110, 95].map(exitPrice => ({ label: String(exitPrice), exitPrice, probability: null, fundingQuote: 0, otherCostsQuote: 0 })) };
    expect(tool.access).toBe("read");
    expect(await tool.run(args, context)).toMatchObject({ quoteCurrency: "USDC", expectedNetPnlQuote: null, assessment: "probabilities_unestimated", currentEntrySensitivity: { entryPrice: 101, expectedNetPnlQuote: null } });
    expect(await tool.run({ ...args, side: "sell" }, { ...context, callId: "short" })).toMatchObject({ currentEntrySensitivity: { entryPrice: 99 } });
    await expect(tool.run({ ...args, instrumentId: "unknown" }, context)).rejects.toThrow(/unavailable/);
    expect(fixture.quote).toHaveBeenCalledTimes(1);
});

const now = Date.UTC(2026, 10, 4, 12, 30);
const perpId = "mainnet:perp:SOL", spotId = "mainnet:spot:1";
const context = { role: "derivatives" as const, shiftId: "shift", callId: "test", signal: new AbortController().signal };
beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers(); vi.setSystemTime(now);
    fixture.book = { id: "book", version: 1, isTestnet: false,mandateJson:JSON.stringify(SWING_DESK_MANDATE) } as DeskBook;
    fixture.account.mockResolvedValue({positions:[],collateral:{accountMode:"unifiedAccount",spotUsdcAvailable:1254,status:"unified_usdc_collateral_present"}});
    fixture.shift = { id: "shift", bookId: "book", version: 1, mode: "research", status: "running", lease: "test",
        leaseUntil: new Date(now + 60000), briefJson: '{"triggers":[]}' } as DeskShift;
    fixture.instruments.mockResolvedValue(nativeInstruments(false, [{ name: "SOL", szDecimals: 2 }], {
        tokens: [{ index: 0, name: "USDC", szDecimals: 8, tokenId: "cash" }, { index: 1, name: "SOL", szDecimals: 2, tokenId: "sol" }],
        universe: [{ name: "@1", index: 1, tokens: [1, 0] }],
    }));
    fixture.snapshot.mockResolvedValue({ universe: [{ name: "SOL" }], assetCtxs: [{ funding: "0.0000125", markPx: "102", oraclePx: "100", openInterest: "50" }] });
    fixture.quote.mockImplementation(async item => ({ instrumentId: item.id, time: now, bid: 99, ask: 101, bids: [{px:"99",sz:"1"}], asks: [{px:"101",sz:"1"}] }));
    fixture.history.mockResolvedValue({ sampleCount: 24 });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shares full depth with sizing while exposing calculated band totals alongside a compact preview",async()=>{
    const asks=Array.from({length:7},(_,n)=>({px:String(100.01+n*.01),sz:n===6?"30":"1"}));
    fixture.quote.mockResolvedValue({instrumentId:perpId,time:now,bid:99.99,ask:100.01,bids:[{px:"99.99",sz:"50"}],asks});
    const tools=deskTools(fixture.book,fixture.shift);
    const q:any=await tools.find(t=>t.name==="order_book")!.run({instrumentId:perpId},context);
    expect(q.asks).toHaveLength(6);
    expect(q.liquidity.asks).toMatchObject({status:"sufficient",returnedLevels:7,coverage:"lower_bound"});
    expect(q.liquidity.asks.observedDepthUsd).toBeGreaterThan(2500);
    expect(q.displayedLevels.asksTruncated).toBe(true);
    const size:any=await tools.find(t=>t.name==="size_swing_trade")!.run({instrumentId:perpId,side:"buy",limitPrice:100.04,stopPrice:99},context);
    expect(size.quantity).toBeGreaterThan(0);
    expect(size.liquidity.asks.observedDepthUsd).toBe(q.liquidity.asks.observedDepthUsd);
    expect(fixture.quote).toHaveBeenCalledTimes(1);
    expect(fixture.quote.mock.calls[0][2]).toBe(true);
    expect(await tools.sharedObservations()).toContainEqual(expect.objectContaining({tool:"order_book",liquidity:expect.objectContaining({reference:"midpoint"})}));
});

it("does not count depth outside execution's midpoint band when sizing at a different limit",async()=>{
    fixture.quote.mockResolvedValue({instrumentId:perpId,time:now,bid:99.99,ask:100.01,
        bids:[{px:"99.99",sz:"50"}],asks:[{px:"100.01",sz:"1"},{px:"100.16",sz:"100"}]});
    const size:any=await deskTools(fixture.book,fixture.shift).find(t=>t.name==="size_swing_trade")!
        .run({instrumentId:perpId,side:"buy",limitPrice:100.1,stopPrice:99},context);
    expect(size.quantity).toBe(0);
    expect(size.liquidity.asks).toMatchObject({observedDepthUsd:100.01,status:"insufficient"});
});

it("shares fresh funding and books, binds composite expiry to the earliest quote, and exposes hourly units to later roles", async () => {
    const tools = deskTools(fixture.book, fixture.shift);
    const funding = tools.find(t => t.name === "funding_and_basis")!;
    const [a, b] = await Promise.all([funding.run({ instrumentId: perpId, purpose:"carry_research",proposalKey:"sol-carry",includeBasis:true }, context), funding.run({ instrumentId: perpId, purpose:"carry_research",proposalKey:"sol-carry",includeBasis:true }, { ...context, callId: "other" })]) as Record<string, any>[];
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);
    expect(fixture.quote).toHaveBeenCalledTimes(2);
    expect(a.observation.expiresAt).toBe(new Date(now + 3000).toISOString());
    expect(a.fundingObservation.expiresAt).toBe(new Date(now + 10000).toISOString());
    expect(a.spotMatch.status).toBe("ticker_candidate_only");
    expect(a.basisBps).toBeCloseTo(200);
    expect(a.entryBasis.longSpotShortPerpBps).toBeLessThan(0);
    expect(b.fundingRate).toBe(a.fundingRate);
    expect(await tools.sharedObservations()).toContainEqual(expect.objectContaining({ tool: "funding_and_basis", fundingIntervalHours: 1, positiveRate: "longs pay shorts" }));
});

it("returns valid funding with explicit missing spot liquidity and enforces perp-only bounded history", async () => {
    fixture.quote.mockImplementation(async item => {
        if (item.id === spotId) throw new Error("Empty spot book");
        return { instrumentId: item.id, time: now, bid: 99, ask: 101, bids: [{px:"99",sz:"1"}], asks: [{px:"101",sz:"1"}] };
    });
    const tools = deskTools(fixture.book, fixture.shift);
    const funding = tools.find(t => t.name === "funding_and_basis")!;
    expect(await funding.run({ instrumentId: perpId, purpose:"carry_research",proposalKey:"sol-carry",includeBasis:true }, context)).toMatchObject({ fundingRate: 0.0000125, spot: null, basisBps: null, entryBasis: null, quoteErrors: { spot: "Fresh spot quote unavailable" } });
    const history = tools.find(t => t.name === "funding_history")!;
    await expect(history.run({ purpose:"carry_research",proposalKey:"sol-carry", instrumentId: spotId, hours: 24 }, context)).rejects.toThrow(/perpetual/);
    await expect(history.run({ purpose:"carry_research",proposalKey:"sol-carry", instrumentId: perpId, hours: 73 }, context)).rejects.toThrow(/1 to 72/);
    await history.run({ purpose:"carry_research",proposalKey:"sol-carry", instrumentId: perpId, hours: 24 }, context);
    await history.run({ purpose:"carry_research",proposalKey:"sol-carry", instrumentId: perpId, hours: 24 }, context);
    expect(fixture.history).toHaveBeenCalledTimes(1);
    expect(fixture.history).toHaveBeenCalledWith(false, "SOL", 24);
});


it("defers premature setup funding before any metadata, funding, account or book request",async()=>{
    const tool=deskTools(fixture.book,fixture.shift).find(t=>t.name==="funding_and_basis")!;
    expect(await tool.run({instrumentId:perpId,purpose:"setup_cost"},context)).toMatchObject({status:"deferred"});
    expect(fixture.instruments).not.toHaveBeenCalled();expect(fixture.snapshot).not.toHaveBeenCalled();expect(fixture.quote).not.toHaveBeenCalled();
});
it("does not fetch spot metadata or either book when only the funding rate is requested",async()=>{
    const tool=deskTools(fixture.book,fixture.shift).find(t=>t.name==="funding_and_basis")!;
    expect(await tool.run({instrumentId:perpId,purpose:"carry_research",proposalKey:"sol-carry"},context)).toMatchObject({fundingRate:0.0000125,spotMatch:{status:"not_requested"}});
    expect(fixture.instruments).toHaveBeenCalledTimes(1);expect(fixture.instruments).toHaveBeenCalledWith(false,"perp");expect(fixture.quote).not.toHaveBeenCalled();
});

it("lets a specialist investigate funding before candle qualification without unnecessary books",async()=>{
    const tools=deskTools(fixture.book,fixture.shift),question="Does negative funding materially change the six-hour short economics?";
    const funding=tools.find(t=>t.name==="funding_and_basis")!;
    expect(await funding.run({instrumentId:perpId,purpose:"decision_research",question},context)).toMatchObject({fundingRate:0.0000125,spotMatch:{status:"not_requested"}});
    await tools.find(t=>t.name==="funding_history")!.run({instrumentId:perpId,purpose:"decision_research",question,hours:6},context);
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);expect(fixture.history).toHaveBeenCalledWith(false,"SOL",6);
    expect(fixture.quote).not.toHaveBeenCalled();
});

it("identifies missing strategy expiry before attempting an advisory preview", async () => {
    const tool = deskTools(fixture.book, fixture.shift).find(t => t.name === "preview_order")!;
    const args = { instrumentId: perpId, side: "buy", quantity: 749, limitPrice: 0.14559,
        stopPrice: 0.13818, thesis: "Retained recovery", strategyVersion: "desk-discretionary-1",
        proposalKey: "init-recovery", maxHoldHours: 4 };
    const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
    expect(validate(args)).toBe(false);
    expect(validate.errors?.some(e => e.params.missingProperty === "entryExpiresAt")).toBe(true);
    await expect(tool.run(args, context)).rejects.toThrow("requires entryExpiresAt");
    expect(fixture.quote).not.toHaveBeenCalled();
    expect(validate({ ...args, entryExpiresAt: new Date(now + 60000).toISOString() })).toBe(true);
});

it("previews an exact work_order payload without submitting or consuming its ticket", async () => {
    const tools = deskTools(fixture.book, fixture.shift);
    const preview = tools.find(t => t.name === "preview_order")!;
    const work = tools.find(t => t.name === "work_order")!;
    const args = { instrumentId: perpId, side: "buy", quantity: 1, limitPrice: 101,
        stopPrice: 99, thesis: "Retained recovery", ticket: "same-ticket",
        strategyVersion: "desk-discretionary-1", proposalKey: "sol-recovery", maxHoldHours: 2,
        entryExpiresAt: new Date(now + 60000).toISOString() };
    const ajv = new Ajv({ strict: false });
    expect(ajv.compile(preview.inputSchema)(args)).toBe(true);
    expect(ajv.compile(work.inputSchema)(args)).toBe(true);
    expect(ajv.compile(preview.inputSchema)({ ...args, bypassRisk: true })).toBe(false);
    fixture.preview.mockResolvedValue({ eligible: true });
    await preview.run(args, context);
    const { ticket: _ticket, ...order } = args;
    expect(fixture.preview).toHaveBeenCalledWith("book", order);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.intent).not.toHaveBeenCalled();
});

it("recovery rechecks a bounded ticket and reuses its durable intent without submitting twice", async () => {
    fixture.book.enabled = true; fixture.shift.mode = "live";
    const original = { id: "original", bookId: "book", policyVersion: 1, intentKey: "old:ticket", state: "rejected", filledQty: 0,
        reason: "Order could not immediately match against any resting orders.",
        requestJson: JSON.stringify({ instrumentId: perpId, side: "buy", quantity: 2, limitPrice: 101, stopPrice: 99,
            strategyVersion: "desk-discretionary-1", proposalKey: "sol", maxHoldHours: 4, entryExpiresAt: new Date(now + 60000).toISOString() }) };
    let recovered: any = null;
    fixture.intent.mockImplementation(async a => a.where.id ? original : recovered);
    fixture.preview.mockResolvedValue({ quantity: 1 });
    fixture.execute.mockImplementation(async (_book, key, order) => recovered = { ...original, id: "recovery", intentKey: key, requestJson: JSON.stringify(order) });
    const tool = deskTools(fixture.book, fixture.shift).find(t => t.name === "recover_missed_fill")!;
    const args = { intentId: "original", quantity: 1, limitPrice: 100, reassessment: "Fresh evidence retains the thesis within the original cap" };
    const lead = { ...context, role: "lead" as const };
    await tool.run(args, lead);
    expect(fixture.preview).toHaveBeenCalledWith("book", expect.objectContaining({ quantity: 1, limitPrice: 100, stopPrice: 99 }));
    expect((await tool.run(args, { ...lead, callId: "again" }) as any).reused).toBe(true);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.preview).toHaveBeenCalledTimes(1);
});


it("recovers only an omitted strategy identity from the exact active unexpired plan", async () => {
    const args = { instrumentId: perpId, side: "buy", quantity: 1, limitPrice: 101, stopPrice: 99,
        thesis: "Retained recovery", proposalKey: "sol-recovery", maxHoldHours: 2,
        entryExpiresAt: new Date(now + 60000).toISOString() };
    const plan = { status: "active", validUntil: args.entryExpiresAt, legs: [{ instrumentId: perpId }],
        setup: { strategyVersion: "desk-discretionary-1", entryExpiresAt: args.entryExpiresAt } };
    fixture.plan.mockResolvedValue({ dataJson: JSON.stringify(plan) });
    const preview = deskTools(fixture.book, fixture.shift).find(t => t.name === "preview_order")!;
    fixture.preview.mockResolvedValue({ eligible: true });
    await preview.run(args, context);
    expect(fixture.plan).toHaveBeenCalledWith({ where: { bookId_key: { bookId: "book", key: "proposal:1:live:sol-recovery" } } });
    expect(fixture.preview).toHaveBeenCalledWith("book", { ...args, strategyVersion: "desk-discretionary-1" });
    const { entryExpiresAt: _expiry, ...missingExpiry } = args;
    await expect(preview.run(missingExpiry, context)).rejects.toThrow("requires entryExpiresAt");
    fixture.preview.mockClear();
    for (const invalid of [null, { ...plan, status: "closed" }, { ...plan, legs: [{ instrumentId: spotId }] },
        { ...plan, setup: { ...plan.setup, entryExpiresAt: new Date(now - 1).toISOString() } }]) {
        fixture.plan.mockResolvedValue(invalid ? { dataJson: JSON.stringify(invalid) } : null);
        await expect(preview.run(args, context)).rejects.toThrow("Missing strategyVersion");
    }
    expect(fixture.preview).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
});
