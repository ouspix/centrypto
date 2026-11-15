// @vitest-environment node
import { describe,it,expect } from "vitest";
import { discoverMarket } from "@/lib/desk/discovery";
import { aggregateBars,swingFeatures,type SwingBar } from "@/lib/desk/swing";
import { candleHistoryCoverage } from "@/lib/desk/candle-history";
import { sizeSwingRisk } from "@/lib/desk/risk-sizing";
import { SWING_DESK_MANDATE } from "@/lib/desk/mandate";
import { validateResearchRequest } from "@/lib/desk/backtest/request";
import { simulateCandles,runCandleResearch,type CandleDataset } from "@/lib/desk/backtest/candles";
import type { DeskInstrument } from "@/lib/desk/instruments";
import type { ResearchRequest,Rule } from "@/lib/desk/backtest/types";

const hour=3600000,start=Date.UTC(2026,7,1);
const instrument=(coin:string)=>({id:`mainnet:perp:${coin}`,coin,base:coin,quote:"USDC",kind:"perp",isTestnet:false,szDecimals:3,asset:0} as DeskInstrument);
const rule:Rule={name:"fixed",signal:"momentum",side:"both",lookbackBars:2,thresholdBps:1,orderUsd:250,stopBps:100,targetBps:200,maxHoldBars:4,cooldownBars:1};
const request:ResearchRequest={engine:"candles",source:"venue_candles",hypothesis:"A frozen causal research test",instrumentIds:[instrument("ALT").id],start:new Date(start).toISOString(),end:new Date(start+40*24*hour).toISOString(),intervalSeconds:3600,feeBpsPerSide:4.5,extraSlippageBps:3,variants:[rule]};
const context={bookId:"b",bookVersion:1,isTestnet:false,mandate:SWING_DESK_MANDATE};
function fixture(count=40*24):CandleDataset{
    const bars=Array.from({length:count+168},(_,i)=>{const close=100+Math.sin(i/10)*3+i/100;return {at:start+(i-168)*hour,open:close-.1,high:close+.5,low:close-.5,close,volume:100000};});
    return [{instrument:instrument("ALT"),bars,funding:bars.map(b=>({at:b.at,rate:.0000125})),coverage:candleHistoryCoverage(bars,start,start+count*hour,hour),provenance:{}}];
}
describe("whole-market swing architecture",()=>{
    it("assesses beyond top-20 volume, pins and nominates instruments, rotates the rest",()=>{
        const items=Array.from({length:179},(_,i)=>instrument(`C${i}`)),now=start;
        const ticks=items.map((i,n)=>({symbol:i.coin,ts:new Date(now),markPrice:n===178?120:100,volume24h:1e9-n*1e6,openInterest:100,fundingRate:0}));
        const past=ticks.map(t=>({...t,markPrice:100,openInterest:50}));
        const a=discoverMarket(items,ticks,past,past,[items[90].id],[items[170].id],now);
        expect(a.scanned).toBe(179);expect(a.shortlist.map(r=>r.instrumentId)).toEqual(expect.arrayContaining([items[178].id,items[90].id,items[170].id]));
        expect(a.coverage.find(r=>r.instrumentId===items[178].id)?.oiChange1hPct).toBe(100);
        const b=discoverMarket(items,ticks,past,past,[],[],now+600000);
        expect(b.shortlist.map(r=>r.instrumentId)).not.toEqual(a.shortlist.map(r=>r.instrumentId));
    });
    it("never consumes open/future bars and does not build 4h bars across missing constituent hours",()=>{
        const bars=fixture()[0].bars,asOf=start+20*hour;
        const a=swingFeatures(bars,hour,asOf),modified=bars.map(b=>b.at>=asOf?{...b,close:1e9,high:1e9}:b);
        expect(swingFeatures(modified,hour,asOf)).toEqual(a);
        const rows=bars.filter(b=>b.at>=start&&b.at<start+4*hour);
        expect(aggregateBars(rows,4*hour,hour,start+4*hour)).toHaveLength(1);
        expect(aggregateBars(rows.slice(1),4*hour,hour,start+4*hour)).toHaveLength(0);
        expect(candleHistoryCoverage(rows.slice(1),start,start+4*hour,hour)).toMatchObject({missing:1,complete:false});
    });
    it("sizes within 1245 even if account equity and editable caps are higher, costs included",()=>{
        const result=sizeSwingRisk({entry:100,stop:98,side:"buy",equityUsd:5000,committedUsd:1100,openRiskUsd:6,instrumentUsd:0,depthUsd:10000,szDecimals:3,mandate:{...SWING_DESK_MANDATE,capitalUsd:5000,maxOrderUsd:5000,maxInstrumentUsd:5000,maxGrossLeverage:10}});
        expect(result.notionalUsd).toBeLessThanOrEqual(145);expect(result.plannedLossUsd).toBeCloseTo(result.notionalUsd*.025);
        expect(()=>sizeSwingRisk({entry:100,stop:101,side:"buy",equityUsd:1245,committedUsd:0,openRiskUsd:0,instrumentUsd:0,depthUsd:5000,szDecimals:3,mandate:SWING_DESK_MANDATE})).toThrow();
    });
    it("accepts multi-day candles but rejects depth masquerading as swing evidence",()=>{
        expect(validateResearchRequest(request,false)).toMatchObject({engine:"candles"});
        expect(()=>validateResearchRequest({...request,engine:"depth"},false)).toThrow();
        expect(()=>validateResearchRequest({...request,additionalWindows:[{start:request.start,end:request.end}]},false)).toThrow();
    });
    it("executes next-bar causal entries, applies funding/costs and retains one capital pool",()=>{
        const data=fixture(),r=simulateCandles(data,context,request,rule,start,start+120*hour);
        expect(r.metrics.closedTrades).toBeGreaterThan(0);expect(r.metrics.feesUsd).toBeGreaterThan(0);
        expect(r.metrics.initialCapitalUsd).toBe(1245);
        expect(r.metrics.netPnlUsd).toBeCloseTo(r.trades.reduce((n,t)=>n+t.netPnlUsd,0),5);
        const first=r.fills[0],bar=data[0].bars.find(b=>b.at===Date.parse(first.at))!;
        expect(first.price).toBeCloseTo(bar.open*(first.side==="buy"?1.0003:.9997));
        const future=data.map(d=>({...d,bars:d.bars.map(b=>b.at>=start+120*hour?{...b,close:1e8,high:1e8}:b)}));
        expect(simulateCandles(future,context,request,rule,start,start+120*hour)).toEqual(r);
    });
    it("matches real settled funding with sub-second venue timestamp jitter without inventing missing hours",()=>{
        const data=fixture(),exact=simulateCandles(data,context,request,rule,start,start+120*hour);
        const jitter=data.map(d=>({...d,funding:d.funding.map((f,i)=>({...f,at:f.at+6+i%60}))}));
        const observed=simulateCandles(jitter,context,request,rule,start,start+120*hour);
        expect(observed.metrics.fundingUsd).toBe(exact.metrics.fundingUsd);
        expect(observed.dataQuality.missingFundingWhileExposed).toBe(0);
        const none=data.map(d=>({...d,funding:[]}));
        expect(simulateCandles(none,context,request,rule,start,start+120*hour).dataQuality.missingFundingWhileExposed).toBeGreaterThan(0);
    });
    it("uses worse gap openings and stop first on ambiguous bars; flags exposed data gaps",()=>{
        const data=fixture(),base=simulateCandles(data,context,request,rule,start,start+30*hour),entry=base.fills.find(f=>f.reason==="next_bar_entry")!;
        const entryAt=Date.parse(entry.at),sign=entry.side==="buy"?1:-1;
        const altered=data.map(d=>({...d,bars:d.bars.map(b=>b.at===entryAt?{...b,high:entry.price*1.5,low:entry.price*.5}:b)}));
        const r=simulateCandles(altered,context,request,rule,start,start+30*hour);
        expect(r.trades[0].reason).toBe("stop_first_if_ambiguous");expect(r.trades[0].netPnlUsd).toBeLessThan(0);
        const wideRule={...rule,stopBps:500,targetBps:1000};
        const gap=data.map(d=>({...d,bars:d.bars.filter(b=>b.at!==entryAt+hour).map(b=>b.at===entryAt+2*hour?{...b,open:entry.price*(sign>0?.8:1.2)}:b)}));
        const g=simulateCandles(gap,context,request,wideRule,start,start+30*hour);
        expect(g.dataQuality.missingExposedBars).toBeGreaterThan(0);expect(g.dataQuality.usableForSelection).toBe(false);
        expect(g.trades.some(t=>t.reason==="first_price_after_gap")).toBe(true);
    });
    it("does not create impossible short validation folds after applying the holding purge twice",()=>{
        const days=12,shortRule={...rule,maxHoldBars:12};
        const r=runCandleResearch(fixture(days*24),context,{...request,end:new Date(start+days*24*hour).toISOString(),variants:[shortRule]});
        expect(r.validationFolds[0].foldCount).toBe(1);
        expect(r.validationFolds[0].folds[0].metrics.closedTrades).toBeGreaterThan(0);
        expect(r.validationFolds[0].folds[0].through).toBe(r.variants[0].validation.through);
        expect(r.assessment.limitations.join(" ")).toContain("Fewer than three");
    });
    it("purges max holding horizon and keeps the candidate frozen when holdout prices change",()=>{
        const data=fixture(),req={...request,variants:[rule,{...rule,name:"alternative",thresholdBps:20}]};
        const first=runCandleResearch(data,context,req),holdoutStart=first.partitions.holdout[0];
        const altered=data.map(d=>({...d,bars:d.bars.map(b=>b.at>=holdoutStart?{...b,open:b.open*2,high:b.high*2,low:b.low*2,close:b.close*2}:b)}));
        const second=runCandleResearch(altered,context,req);
        expect(second.selectedVariant).toBe(first.selectedVariant);expect(second.variants).toEqual(first.variants);
        expect(first.partitions.purgeHours).toBe(4);expect(first.holdout?.metrics.initialCapitalUsd).toBe(1245);
    });
});
