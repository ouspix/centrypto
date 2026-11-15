// @vitest-environment node
import { describe, it, expect } from "vitest";
import { venuePrice, venueLimitPrice, decimalPrice } from "@/lib/desk/venue-price";
import { runResearchCampaign, researchWindows } from "@/lib/desk/backtest/campaign";
import { replayDesk, runDeskResearch } from "@/lib/desk/backtest/engine";
import {
  validateResearchRequest,
  ruleDirection,
} from "@/lib/desk/backtest/request";
import { DEFAULT_DESK_MANDATE } from "@/lib/desk/mandate";
import { nativeInstruments } from "@/lib/desk/instruments";
import type {
  Dataset,
  ResearchContext,
  ResearchRequest,
  Rule,
} from "@/lib/desk/backtest/types";

const start = Date.UTC(2026, 10, 1),
  id = "mainnet:perp:BTC",
  minute = 60000;
const instruments = nativeInstruments(false, [{ name: "BTC", szDecimals: 4 }], {
  tokens: [],
  universe: [],
});
const ctx: ResearchContext = {
  bookId: "b",
  bookVersion: 1,
  isTestnet: false,
  mandate: { ...DEFAULT_DESK_MANDATE },
};
const iso = (n: number) => new Date(start + n * minute).toISOString();
function data(prices: number[]): Dataset {
  return {
    network: "mainnet",
    instruments,
    funding: [],
    coverage: {
      source: "fixture",
      missingBooks: 0,
      expectedBooks: prices.length,
      missingFunding: 0,
      recovery: null,
      limitations: [],
    },
    observations: prices.map((p, i) => ({
      at: start + i * minute,
      instrumentId: id,
      oracle: p,
      depth: {
        time: start + i * minute,
        levels: [
          [{ px: String(p - 0.005), sz: "1000" }],
          [{ px: String(p + 0.005), sz: "1000" }],
        ],
      },
    })),
  };
}
function request(): ResearchRequest {
  return {
    hypothesis: "A dated order tests execution and accounting",
    source: "collector",
    start: iso(0),
    end: iso(120),
    instrumentIds: [id],
    intervalSeconds: 60,
    feeBpsPerSide: 0,
    extraSlippageBps: 0,
    orders: [],
  };
}
const order = {
  instrumentId: id,
  side: "buy" as const,
  quantity: 0.25,
  limitPrice: 100.1,
  stopPrice: 98,
  takeProfitPrice: 130,
  thesis: "Evidence-backed example",
};
function recorded(at = 0) {
  return {
    decidedAt: iso(at),
    evidenceAvailableAt: iso(at),
    order: { ...order },
  };
}
const rule: Rule = {
  name: "momentum",
  signal: "momentum",
  side: "both",
  lookbackBars: 2,
  thresholdBps: 1,
  orderUsd: 25,
  stopBps: 100,
  targetBps: 200,
  maxHoldBars: 10,
  cooldownBars: 1,
};

describe("desk historical execution", () => {
  it("keeps explicit empty decisions empty", () => {
    const r = replayDesk(
      data([100, 101, 102]),
      ctx,
      request(),
      start,
      start + 3 * minute,
    );
    expect(r.metrics.fills).toBe(0);
    expect(r.metrics.netPnlUsd).toBe(0);
  });
  it("executes only after the decision observation, using the next book", () => {
    const d = data([100, 100, 101]),
      q = { ...request(), orders: [recorded()] },
      r = replayDesk(d, ctx, q, start, start + 3 * minute);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0].at).toBe(iso(1));
    expect(r.fills[0].price).toBeCloseTo(100.005);
    expect(d.observations[1].depth.levels[1][0].sz).toBe("1000");
  });
  it("retains the last valid mark through a missing observation", () => {
    const d = data([100, 100, 105, 105]);
    d.observations.pop();
    const r = replayDesk(
      d,
      ctx,
      { ...request(), orders: [recorded()] },
      start,
      start + 8 * minute,
    );
    expect(r.metrics.unrealizedPnlUsd).toBeCloseTo(0.25 * (105 - 100.005));
    expect(r.endingPositions[0].mark).toBe(105);
    expect(r.limitations.join(" ")).toMatch(/stale marks/);
  });
  it("uses the same order cap as the live desk", () => {
    const q = {
        ...request(),
        orders: [{ ...recorded(), order: { ...order, quantity: 2 } }],
      },
      r = replayDesk(data([100, 100]), ctx, q, start, start + 2 * minute);
    expect(r.metrics.fills).toBe(0);
    expect(r.rejections[0].reason).toMatch(/Order cap/);
  });
  it("enforces perpetual stop protection", () => {
    const o = { ...order };
    delete (o as any).stopPrice;
    const r = replayDesk(
      data([100, 100]),
      ctx,
      { ...request(), orders: [{ ...recorded(), order: o }] },
      start,
      start + 2 * minute,
    );
    expect(r.rejections[0].reason).toMatch(/requires an exchange stop/);
  });
  it("does not invent missing depth", () => {
    const d = data([100, 100]);
    d.observations[1].depth.levels[1][0].sz = "0.01";
    const r = replayDesk(
      d,
      ctx,
      { ...request(), orders: [recorded()] },
      start,
      start + 2 * minute,
    );
    expect(r.metrics.fills).toBe(0);
    expect(r.rejections[0].reason).toMatch(/depth/);
  });
  it("reconciles fees and hourly funding at the oracle price", () => {
    const d = data(Array(65).fill(100));
    d.funding = [
      { at: start + 60 * minute, instrumentId: id, rate: 0.001, oracle: 90 },
    ];
    const r = replayDesk(
      d,
      ctx,
      { ...request(), feeBpsPerSide: 10, orders: [recorded()] },
      start,
      start + 65 * minute,
    );
    expect(r.metrics.fundingUsd).toBeCloseTo(-0.25 * 90 * 0.001);
    expect(r.metrics.feesUsd).toBeCloseTo(0.25 * 100.005 * 0.001);
    expect(r.metrics.netPnlUsd).toBeCloseTo(
      r.metrics.realizedPnlUsd +
        r.metrics.unrealizedPnlUsd -
        r.metrics.feesUsd +
        r.metrics.fundingUsd,
    );
  });
  it("settles funding before a newly filled order at the same timestamp", () => {
    const d = data(Array(65).fill(100));
    d.funding = [
      { at: start + 60 * minute, instrumentId: id, rate: 0.01, oracle: 100 },
    ];
    const r = replayDesk(
      d,
      ctx,
      { ...request(), orders: [recorded(59)] },
      start,
      start + 65 * minute,
    );
    expect(r.metrics.fundingUsd).toBe(0);
  });
  it("exposes missing oracle funding instead of treating it as complete", () => {
    const d = data(Array(65).fill(100));
    d.funding = [
      { at: start + 60 * minute, instrumentId: id, rate: 0.001, oracle: null },
    ];
    const r = replayDesk(
      d,
      ctx,
      { ...request(), orders: [recorded()] },
      start,
      start + 65 * minute,
    );
    expect(r.limitations.join(" ")).toMatch(/incomplete/);
  });
  it("fires a stop only after entry and walks the observed exit price", () => {
    const r = replayDesk(
      data([100, 100, 97]),
      ctx,
      { ...request(), orders: [recorded()] },
      start,
      start + 3 * minute,
    );
    expect(r.fills[1].reason).toBe("stop");
    expect(r.fills[1].price).toBeCloseTo(96.995);
    expect(r.metrics.closedTrades).toBe(1);
  });
  it("rejects a late observation rather than filling across a gap", () => {
    const d = data([100, 100, 100, 100, 100]);
    d.observations = d.observations.filter((_, i) => i === 0 || i === 4);
    const r = replayDesk(
      d,
      ctx,
      { ...request(), orders: [recorded()] },
      start,
      start + 5 * minute,
    );
    expect(r.metrics.fills).toBe(0);
    expect(r.rejections[0].reason).toMatch(/timely/);
  });
  it("separates mainnet and testnet", () => {
    expect(() =>
      runDeskResearch(data([100]), { ...ctx, isTestnet: true }, request()),
    ).toThrow(/network mismatch/);
  });
  it("reports recorded-order scope and a reproducible dataset hash", () => {
    const a = runDeskResearch(data([100, 100]), ctx, request()),
      b = runDeskResearch(data([100, 100]), ctx, request());
    expect(a.scope).toBe("recorded_desk_orders");
    expect(a.dataHash).toBe(b.dataHash);
    expect(a.replay?.metrics.fills).toBe(0);
  });
  it("never selects a holdout candidate from incomplete data", () => {
    const d = data(Array.from({ length: 120 }, (_, i) => 100 + i * 0.01));
    d.coverage.missingFunding = 1;
    const q = { ...request(), orders: undefined, variants: [rule] };
    const r = runDeskResearch(d, ctx, q);
    expect(r.holdout).toBeNull();
    expect(r.selectedVariant).toBeNull();
  });
  it("keeps policy size inside the fixed mandate", () => {
    expect(() =>
      runDeskResearch(data([100]), ctx, {
        ...request(),
        orders: undefined,
        variants: [{ ...rule, orderUsd: 101 }],
      }),
    ).toThrow(/fixed book mandate/);
  });
  it("computes signals using trailing observations and respects direction", () => {
    expect(ruleDirection(rule, [100, 100.01, 100.02])).toBe(1);
    expect(
      ruleDirection({ ...rule, side: "short" }, [100, 100.01, 100.02]),
    ).toBe(0);
    expect(
      ruleDirection(
        { ...rule, signal: "mean_reversion" },
        [100, 100.01, 100.02],
      ),
    ).toBe(-1);
  });
});

describe("research request contract", () => {
  it("accepts a no-trade recorded run without substituting another policy", () =>
    expect(validateResearchRequest(request(), false).orders).toEqual([]));
  it("rejects future evidence", () =>
    expect(() =>
      validateResearchRequest(
        {
          ...request(),
          orders: [{ ...recorded(), evidenceAvailableAt: iso(1) }],
        },
        false,
      ),
    ).toThrow(/evidence/));
  it("rejects mandate overrides and arbitrary code", () => {
    expect(() =>
      validateResearchRequest({ ...request(), mandate: ctx.mandate }, false),
    ).toThrow(/Unknown research/);
    expect(() =>
      validateResearchRequest({ ...request(), python: "print(1)" }, false),
    ).toThrow(/Unknown research/);
  });
  it("rejects mixed networks, future and unbounded windows", () => {
    expect(() => validateResearchRequest(request(), true)).toThrow(/network/);
    expect(() =>
      validateResearchRequest(
        { ...request(), end: "2099-01-01T00:00:00Z" },
        false,
      ),
    ).toThrow(/completed window/);
    expect(() =>
      validateResearchRequest({ ...request(), end: iso(500) }, false),
    ).toThrow(/six hours/);
  });
  it("requires either explicit rules or recorded orders", () =>
    expect(() =>
      validateResearchRequest({ ...request(), variants: [rule] }, false),
    ).toThrow(/never both/));
});


describe("campaign and price regressions", () => {
  it("keeps legal ticks idempotent across binary tails and exponent notation", () => {
    for(const px of [2323.8, 2323.7, 2310.1, 0.00000012, 1000000]) {
      const precision=px<1?0:4, perp=px>=1;
      const once=venuePrice(px,precision,perp);
      expect(venuePrice(once,precision,perp)).toBe(once);
    }
    expect(venuePrice(2323.8,4,true)).toBe(2323.8);
    expect(venueLimitPrice(2323.8123,4,true,false)).toBe(2323.9);
    expect(venueLimitPrice(2323.8123,4,true,true)).toBe(2323.8);
    expect(decimalPrice(1.2e-7)).toBe("0.00000012");
  });
  it("accepts a legal ETH-scale sell limit through the shared execution checker",()=>{
    const req=request(); req.orders=[{decidedAt:iso(0),evidenceAvailableAt:iso(0),order:{...order,side:"sell",quantity:0.01,limitPrice:2323.8,stopPrice:2350,takeProfitPrice:2300}}];
    const result=replayDesk(data([2323.81,2323.81,2323.81]),ctx,req,start,start+3*minute);
    expect(result.rejections).toEqual([]);expect(result.metrics.fills).toBe(1);
  });
  const campaign = (): ResearchRequest => ({...request(),orders:undefined,variants:[rule],
    additionalWindows:[1,2].map(day=>({start:iso(day*1440),end:iso(day*1440+120)}))});
  it("rejects overlapping, reordered and same-day campaign windows",()=>{
    expect(validateResearchRequest(campaign(),false,Date.UTC(2026,10,6)).additionalWindows).toHaveLength(2);
    const bad=campaign();bad.additionalWindows![0]={start:iso(60),end:iso(180)};
    expect(()=>validateResearchRequest(bad,false,Date.UTC(2026,10,6))).toThrow(/chronological/);
    const orders={...campaign(),variants:undefined,orders:[]};
    expect(()=>validateResearchRequest(orders,false,Date.UTC(2026,10,6))).toThrow(/fixed variants/);
  });
  it("selects one pooled-validation candidate and resets all partitions",()=>{
    const req=campaign();
    const datasets=researchWindows(req).map((w,day)=>{
      const d=data(Array.from({length:120},(_,i)=>100+Math.floor(i/4)*0.02));
      d.observations.forEach(o=>{o.at+=day*86400000;o.depth.time=o.at;});return d;
    });
    const result=runResearchCampaign(datasets,ctx,req);
    expect(result.windows).toHaveLength(3);
    expect(result.variants[0].validation.metrics.initialCapitalUsd).toBe(ctx.mandate.capitalUsd);
    expect(result.variants[0].validation.metrics.closedTrades).toBe(result.windows.reduce((n,w)=>n+w.variants[0].validation.metrics.closedTrades,0));
    expect(result.assessment.status).not.toBe("evidence_for_review");
    expect(result.holdout?.metrics.initialCapitalUsd).toBe(ctx.mandate.capitalUsd);
    expect(result.windows.every(w=>w.variants.length===1)).toBe(true);
  });
  it("never selects on incomplete data or turns no trades into negative edge",()=>{
    const req=campaign(), datasets=researchWindows(req).map(()=>data(Array(120).fill(100)));
    datasets[0].coverage.missingBooks=1;
    const result=runResearchCampaign(datasets,ctx,req);
    expect(result.selectedVariant).toBeNull();expect(result.holdout).toBeNull();
    expect(result.assessment.status).toBe("unresolved_exposure");
  });
});


describe("exposure-aware historical gap policy",()=>{
  const candle=(minuteIndex:number,low=99,high=101,volume=100)=>({instrumentId:id,openTime:start+minuteIndex*minute,availableAt:start+(minuteIndex+1)*minute,open:100,high,low,close:100,volume,source:"archive_real_1m" as const});
  it("keeps a flat missing minute usable and scopes quality to the actual partition",()=>{
    const d=data(Array(60).fill(100));d.observations.splice(5,1);d.coverage.missingBooks=1;
    const full=replayDesk(d,ctx,request(),start,start+60*minute);
    expect(full.dataQuality).toMatchObject({missingBooks:1,carriedPriceSteps:1,exposedGapIntervals:0,usableForSelection:true});
    const validation=replayDesk(d,ctx,request(),start+30*minute,start+60*minute);
    expect(validation.dataQuality).toMatchObject({missingBooks:0,usableForSelection:true});
  });
  it("uses closed candle adverse prices, stop before target, and explicit modeled fills",()=>{
    const d=data([100,100,100,100]);d.observations.splice(2,1);d.coverage.missingBooks=1;
    d.priceCandles=[candle(1),candle(2,90,110)];
    const req={...request(),orders:[{...recorded(),order:{...order,takeProfitPrice:102}}]};
    const result=replayDesk(d,ctx,req,start,start+4*minute);
    expect(result.fills).toHaveLength(2);
    expect(result.fills[1]).toMatchObject({at:iso(3),executionModel:"candle_gap_conservative",reason:"gap_candle_stop"});
    expect(result.fills[1].price).toBeLessThanOrEqual(90);
    expect(result.metrics.netPnlUsd).toBeLessThan(-2.5);
    expect(result.dataQuality).toMatchObject({usableForSelection:true,modeledExitFills:1,modelDependentClosedTrades:1});
    const beforeClose=replayDesk(d,ctx,req,start,start+2.9*minute);
    expect(beforeClose.fills).toHaveLength(1);expect(beforeClose.endingPositions).toHaveLength(1);
  });
  it("caps modeled exits by observed candle volume and preserves the remaining position",()=>{
    const d=data([100,100,100,100]);d.observations.splice(2,1);d.priceCandles=[candle(1),candle(2,90,101,1)];
    const result=replayDesk(d,ctx,{...request(),orders:[recorded()]},start,start+3*minute);
    expect(result.fills[1].quantity).toBeCloseTo(0.01);
    expect(result.endingPositions[0].quantity).toBeCloseTo(0.24);
    expect(result.dataQuality).toMatchObject({modeledExitFills:1,modelDependentClosedTrades:0});
    const continued=replayDesk(d,ctx,{...request(),orders:[recorded()]},start,start+4*minute);
    expect(continued.fills[2]).toMatchObject({executionModel:"observed_depth",reason:"gap_deferred_stop"});
    expect(continued.endingPositions).toEqual([]);
  });
  it("never uses proxy prices as entry liquidity or fills an order across a missing book",()=>{
    const d=data([100,100,100,100,100]);d.observations.splice(2,1);d.priceCandles=[candle(1),candle(2)];
    const result=replayDesk(d,ctx,{...request(),orders:[recorded(1)]},start,start+5*minute);
    expect(result.fills).toEqual([]);expect(result.rejections[0].reason).toMatch(/timely execution/);
  });
  it("rejects synthetic candles and exposes unbounded held-position intervals",()=>{
    const d=data([100,100,100,100,100]);d.observations.splice(2,2);
    d.priceCandles=[{...candle(1),source:"synthetic_from_features" as any}];
    const result=replayDesk(d,ctx,{...request(),orders:[recorded()]},start,start+5*minute);
    expect(result.dataQuality?.carriedPriceSteps).toBe(1);
    expect(result.dataQuality?.unpricedSteps).toBeGreaterThan(0);
    expect(result.dataQuality?.usableForSelection).toBe(false);
    expect(result.dataQuality?.unresolvedExposureIntervals).toBeGreaterThan(0);
    expect(result.fills.every(f=>f.executionModel==="observed_depth")).toBe(true);
  });
  it("only missing funding while exposed affects completeness",()=>{
    const d=data(Array(60).fill(100));d.coverage.missingFunding=2;
    d.fundingGaps=[{at:start+minute,instrumentId:id,reason:"no rate"},{at:start+40*minute,instrumentId:id,reason:"no rate"}];
    expect(replayDesk(d,ctx,request(),start+30*minute,start+60*minute).dataQuality).toMatchObject({missingFundingWhileExposed:0,usableForSelection:true});
    const req={...request(),orders:[recorded(31)]};
    expect(replayDesk(d,ctx,req,start+30*minute,start+60*minute).dataQuality).toMatchObject({missingFundingWhileExposed:1,usableForSelection:false});
  });
  it("selects and evaluates holdout when the only gaps are outside validation",()=>{
    const req:ResearchRequest={...request(),orders:undefined,variants:[rule],additionalWindows:[1,2].map(day=>({start:iso(day*1440),end:iso(day*1440+120)}))};
    const datasets=researchWindows(req).map((w,day)=>{
      const d=data(Array.from({length:120},(_,i)=>100+Math.floor(i/4)*0.02));d.observations.splice(5,1);d.coverage.missingBooks=1;
      d.observations.forEach(o=>{o.at+=day*86400000;o.depth.time=o.at;});return d;
    });
    const result=runResearchCampaign(datasets,ctx,req);
    expect(result.selectedVariant).toBe(rule.name);expect(result.holdout).not.toBeNull();
    expect(result.variants[0].validation.dataQuality?.missingBooks).toBe(0);
    expect(result.variants[0].usableValidationWindows).toBe(3);
  });
});
