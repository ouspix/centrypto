// @vitest-environment node
import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import type {DeskBook,PrismaClient} from "@prisma/client";
import type {Rule,ResearchRequest} from "@/lib/desk/backtest/types";
import {ENGINE_VERSION} from "@/lib/desk/backtest/types";
import {SWING_DESK_MANDATE} from "@/lib/desk/mandate";
import {assessCandleEvidence} from "@/lib/desk/backtest/evidence";
import {candleRuleDirection} from "@/lib/desk/rule-signal";
import {simulateCandles,type CandleDataset} from "@/lib/desk/backtest/candles";
const io=vi.hoisted(()=>({history:vi.fn(),funding:vi.fn(),wake:vi.fn()}));
vi.mock("@/lib/desk/candle-history",async orig=>({...await orig<typeof import("@/lib/desk/candle-history")>(),historicalCandles:io.history,historicalFunding:io.funding}));
vi.mock("@/lib/desk/books",()=>({queueWake:io.wake}));
import {prospectiveDecision,observeProspectiveTests} from "@/lib/desk/prospective";
import {technicalTransition,technicalState,observeTechnicalWatches,validateTechnicalWatch} from "@/lib/desk/technical-watches";
const hour=3600000,start=Date.UTC(2026,10,1),instrument={id:"mainnet:perp:ALT",coin:"ALT",base:"ALT",quote:"USDC",kind:"perp",isTestnet:false,szDecimals:3,asset:0} as CandleDataset[number]["instrument"];
const rule:Rule={name:"frozen-short",signal:"momentum",side:"short",lookbackBars:2,thresholdBps:1,orderUsd:100,stopBps:200,targetBps:400,maxHoldBars:2,cooldownBars:1};
const request:ResearchRequest={engine:"candles",source:"venue_candles",hypothesis:"Frozen negative momentum",instrumentIds:[instrument.id],start:new Date(start).toISOString(),end:new Date(start+30*24*hour).toISOString(),intervalSeconds:3600,feeBpsPerSide:4.5,extraSlippageBps:3,variants:[rule]};
const context={bookId:"test",bookVersion:1,isTestnet:false,mandate:SWING_DESK_MANDATE};
function bars(from=start-7*24*hour,count=7*24+24,fall=true){return Array.from({length:count},(_,i)=>{const close=fall?120-i*.05:100+i*.05;return {at:from+i*hour,open:close+.01,high:close+.02,low:close-.02,close,volume:100000};});}
const part=(p:number,n=3,usable=true)=>({metrics:{netPnlUsd:p,closedTrades:n},dataQuality:{usableForSelection:usable}});
beforeEach(()=>{vi.clearAllMocks();vi.useFakeTimers();vi.setSystemTime(start+hour+5000);io.history.mockImplementation(async(_c,_i,from,to)=>({bars:bars().filter(b=>b.at>=from&&b.at+hour<=to)}));io.funding.mockImplementation(async(_c,from,to)=>Array.from({length:Math.ceil((to-from)/hour)},(_,i)=>({at:from+i*hour,rate:.0001})));});
afterEach(()=>{vi.useRealTimers();});
describe("evidence economics and uncertainty",()=>{
 it("keeps positive sparse results preliminary without a sample-size veto",()=>{expect(assessCandleEvidence({coverage:true,validation:part(5),holdout:part(2),stress:part(1)})).toMatchObject({status:"promising_for_review",economics:"positive_after_stress",reliability:"preliminary",executionApproval:false});});
 it("does not hide thin negative or stressed losses behind insufficient sample",()=>{expect(assessCandleEvidence({coverage:true,validation:part(-2),holdout:part(-3),stress:part(-4)})).toMatchObject({status:"hypothesis_challenged",economics:"adverse"});expect(assessCandleEvidence({coverage:true,validation:part(2),holdout:part(3),stress:part(-1)}).economics).toBe("cost_sensitive");});
 it("separates unobserved outcomes, exposed data gaps, mixed regimes and concentrated folds",()=>{
  expect(assessCandleEvidence({coverage:true,validation:part(0,0),holdout:part(0,0),stress:part(0,0)}).economics).toBe("unobserved");
  expect(assessCandleEvidence({coverage:false,validation:part(5),holdout:part(5),stress:part(5)})).toMatchObject({reliability:"coverage_limited",economics:"positive_after_stress"});
  expect(assessCandleEvidence({coverage:true,validation:part(5,3,false),holdout:part(5),stress:part(5)}).reliability).toBe("data_limited");
  expect(assessCandleEvidence({coverage:true,validation:part(5,30),holdout:part(5,20),stress:part(5,20),folds:[part(8,20),part(-3,10),part(1,5)]})).toMatchObject({reliability:"regime_sensitive",temporalSupport:{losingFolds:1}});
  expect(assessCandleEvidence({coverage:true,validation:part(5,30),holdout:part(5,20),stress:part(5,20),folds:[part(5,30),part(0,0)]}).reliability).toBe("preliminary");
 });
});
describe("causal forward decisions and accounting",()=>{
 it("shares short/both/mean-reversion rules and ignores future prices or discontinuous history",()=>{
  const b=bars(),asOf=start+hour;expect(candleRuleDirection(rule,b,hour,asOf)).toBe(-1);
  expect(candleRuleDirection({...rule,side:"long"},b,hour,asOf)).toBe(0);
  expect(candleRuleDirection({...rule,side:"both",signal:"mean_reversion"},b,hour,asOf)).toBe(1);
  expect(candleRuleDirection(rule,b.map(v=>v.at>=asOf?{...v,close:1e9}:v),hour,asOf)).toBe(-1);
  expect(candleRuleDirection(rule,b.filter(v=>v.at!==start-hour),hour,asOf)).toBe(0);
 });
 it("records a future entry only after registration and never reconstructs late observations",()=>{
  const now=start+hour+5000,d=prospectiveDecision(rule,bars(),hour,now,start,instrument.id)!;
  expect(d).toMatchObject({signalClosedAt:start+hour,decidedAt:now,entryAt:start+2*hour,direction:-1});
  expect(prospectiveDecision(rule,bars(),hour,start+hour+90001,start,instrument.id)).toBeNull();
  expect(prospectiveDecision(rule,bars(),hour,now,now,instrument.id)).toBeNull();
 });
 it("requires a recorded prior decision, retains open modeled exposure and charges actual costs",()=>{
  const data=[{instrument,bars:bars(),funding:bars().map(b=>({at:b.at,rate:.0001})),coverage:{} as any,provenance:{}}];
  const d=prospectiveDecision(rule,data[0].bars,hour,start+hour+5000,start,instrument.id)!;
  const empty=simulateCandles(data,context,request,rule,start,start+10*hour,1,{decisions:[]});expect(empty.fills).toHaveLength(0);
  expect(simulateCandles(data,context,request,rule,start,start+3*hour,1,{decisions:[{...d,decidedAt:d.entryAt}]}).fills).toHaveLength(0);
  const open=simulateCandles(data,context,request,rule,start,start+3*hour,1,{decisions:[d]});expect(open.endingPositions).toHaveLength(1);expect(Date.parse(open.fills[0].at)).toBe(d.entryAt);
  const closed=simulateCandles(data,context,request,rule,start,start+5*hour,1,{decisions:[d]});expect(closed.trades).toHaveLength(1);expect(closed.metrics.feesUsd).toBeGreaterThan(0);expect(closed.metrics.fundingUsd).toBeLessThan(0);expect(closed.metrics.netPnlUsd).toBeCloseTo(closed.trades[0].netPnlUsd,7);
 });
});
function studyDb(){
 const s={id:"study",runId:"run",engine:ENGINE_VERSION,sourceEngine:ENGINE_VERSION,rule,request,context,instrument,registeredAt:start-5000,startAt:start,endAt:start+48*hour,nextCheckAt:start+hour+5000,through:start,status:"observing",decisions:[],data:[],missedObservationIntervals:0};
 const row={id:"row",dataJson:JSON.stringify(s)};
 const db:any={deskRecord:{count:vi.fn(async()=>0),findMany:vi.fn(async()=>[{...row}]),updateMany:vi.fn(async({where,data})=>{if(row.dataJson!==where.dataJson)return {count:0};row.dataJson=data.dataJson;return {count:1};})},deskBook:{count:vi.fn(async()=>1)}};db.$transaction=async(fn:any)=>fn(db);
 return {db:db as PrismaClient,row,read:()=>JSON.parse(row.dataJson),book:{id:"test",enabled:true,version:1,isTestnet:false} as DeskBook};
}
describe("forward observer persistence and bounded data",()=>{
 it("marks a late latest confirmation interval as missed even without a skipped whole bar",async()=>{
  const f=studyDb(),s=f.read();
  s.registeredAt=start-1000;
  s.comparison={proposalKey:"candidate",proposalRevision:1,decisionPlan:{horizonHours:2},mode:"live",confirmation:{relation:"below",price:200,closedBars:1},waitUntil:start+3*hour,costAssumptions:"Explicit costs",baselineDecisions:[]};
  f.row.dataJson=JSON.stringify(s);
  vi.setSystemTime(start+hour+90001);
  await observeProspectiveTests(f.db,f.book);
  expect(f.read().decisions).toHaveLength(0);
  expect(f.read().missedObservationIntervals).toBe(1);
 });
 it("runs both entry timing arms through the same simulator, survives funding retry and completes once",async()=>{
  const f=studyDb(),s=f.read();
  s.registeredAt=start-1000;s.endAt=start+6*hour;
  s.comparison={proposalKey:"candidate",proposalRevision:1,decisionPlan:{horizonHours:2},mode:"live",confirmation:{relation:"below",price:200,closedBars:1},waitUntil:start+3*hour,costAssumptions:"Explicit fees and adverse slippage",baselineDecisions:[{instrumentId:instrument.id,direction:-1,signalClosedAt:start-hour,decidedAt:start-1000,entryAt:start}]};
  f.row.dataJson=JSON.stringify(s);
  await observeProspectiveTests(f.db,f.book);
  expect(f.read().comparison.baselineResult.fills).toHaveLength(1);
  expect(f.read().decisions).toHaveLength(1);expect(f.read().result.fills).toHaveLength(0);
  const frozen=f.read().decisions;
  vi.setSystemTime(start+2*hour+5000);io.funding.mockRejectedValueOnce(Error("funding unavailable"));
  await observeProspectiveTests(f.db,f.book);expect(f.read().lastError).toBe("funding unavailable");
  vi.setSystemTime(start+2*hour+65000);await observeProspectiveTests(f.db,f.book);
  expect(f.read().decisions).toEqual(frozen);expect(f.read().lastError).toBeUndefined();
  for(let h=3;h<=6;h++){vi.setSystemTime(start+h*hour+5000);await observeProspectiveTests(f.db,f.book);}
  expect(f.read().status).toBe("completed");
  expect(f.read().comparison.baselineResult.trades).toHaveLength(1);
  expect(f.read().result.trades).toHaveLength(1);
  expect(f.read().comparison.baselineResult.metrics.feesUsd).toBeGreaterThan(0);
  expect(f.read().result.metrics.feesUsd).toBeGreaterThan(0);
  expect(io.wake).toHaveBeenCalledTimes(1);
  expect(io.wake.mock.calls[0][5]).toMatchObject({scope:"paired_entry_timing_simulation",comparison:{comparable:true}});
  await observeProspectiveTests(f.db,f.book);expect(io.wake).toHaveBeenCalledTimes(1);
 });
 it("persists before future entry, fetches funding only on exposure and honors stopped books",async()=>{
  const f=studyDb();await observeProspectiveTests(f.db,{...f.book,enabled:false});expect(io.history).not.toHaveBeenCalled();
  await observeProspectiveTests(f.db,f.book);expect(f.read().decisions).toHaveLength(1);expect(f.read().result.fills).toHaveLength(0);expect(io.funding).not.toHaveBeenCalled();
  vi.setSystemTime(start+3*hour+5000);await observeProspectiveTests(f.db,f.book);expect(f.read().result.fills).toHaveLength(1);expect(io.funding).not.toHaveBeenCalled();
  vi.setSystemTime(start+5*hour+5000);await observeProspectiveTests(f.db,f.book);expect(io.funding).toHaveBeenCalledTimes(1);expect(io.funding.mock.calls[0].slice(1,3)).toEqual([start+3*hour,start+5*hour]);expect(f.read().result.trades).toHaveLength(1);
  const count=io.history.mock.calls.length;await observeProspectiveTests(f.db,f.book);expect(io.history).toHaveBeenCalledTimes(count);
 });
 it("does not synthesize decisions across downtime and marks missed observation intervals",async()=>{
  const f=studyDb();vi.setSystemTime(start+5*hour+120000);await observeProspectiveTests(f.db,f.book);expect(f.read().decisions).toHaveLength(0);expect(f.read().missedObservationIntervals).toBe(4);expect(io.funding).not.toHaveBeenCalled();
 });
 it("retains a causal decision through funding failure without refetching already observed bars",async()=>{
  const f=studyDb();await observeProspectiveTests(f.db,f.book);vi.setSystemTime(start+5*hour+5000);io.funding.mockRejectedValueOnce(Error("funding unavailable"));await observeProspectiveTests(f.db,f.book);
  const before=f.read().decisions,reads=io.history.mock.calls.length;expect(f.read().lastError).toContain("funding unavailable");vi.setSystemTime(start+5*hour+65000);await observeProspectiveTests(f.db,f.book);expect(f.read().decisions).toEqual(before);expect(io.history).toHaveBeenCalledTimes(reads);expect(f.read().lastError).toBeUndefined();
 });
 it("completes once by event and blocks model-version changes without fetching",async()=>{
  const f=studyDb();vi.setSystemTime(start+49*hour+5000);await observeProspectiveTests(f.db,f.book);expect(f.read().status).toBe("completed");expect(io.wake).toHaveBeenCalledTimes(1);await observeProspectiveTests(f.db,f.book);expect(io.wake).toHaveBeenCalledTimes(1);
  const g=studyDb();g.row.dataJson=JSON.stringify({...g.read(),engine:"old"});io.history.mockClear();await observeProspectiveTests(g.db,g.book);expect(g.read().status).toBe("blocked_engine_changed");expect(io.history).not.toHaveBeenCalled();
 });
});
describe("technical watches",()=>{
 const spec={intervalSeconds:3600,condition:"alignment",minTrendBps:10} as const;
 it("requires typed conditions and a known false-to-true alignment transition",()=>{
  expect(()=>validateTechnicalWatch({...spec,intervalSeconds:60})).toThrow();
  const b=bars(start-7*24*hour,7*24+24,false),now=start+hour;
  expect(technicalState(b,spec,"buy",now)).toMatchObject({observed:true,qualified:true});
  expect(technicalTransition(b,spec,"buy",start,now,false).triggered).toBe(true);
  expect(technicalTransition(b,spec,"buy",start,now,true).triggered).toBe(false);
  expect(technicalTransition(b,spec,"buy",start-30*24*hour,now).triggered).toBe(false);
  expect(technicalTransition(b,spec,"buy",now,now,false).triggered).toBe(false);
 });
 it("wakes once on a new qualifying closed bar and never observes a stopped book",async()=>{
  const book={id:"technical-test",version:1,enabled:true,isTestnet:false} as DeskBook;
  const row:any={id:"watch",key:"routine:derivatives:1:research:watch",kind:"technical",thesis:"Review alignment",threshold:null,eventKey:null,instrumentId:instrument.id,side:"buy",mode:"research",createdAt:new Date(start),deadline:new Date(start+24*hour),status:"open",outcomeJson:JSON.stringify({technical:spec,lastQualified:false})};
  const db:any={deskWatch:{findMany:vi.fn(async()=>row.status==="open"?[{...row}]:[]),updateMany:vi.fn(async({where,data})=>{if(row.status!==where.status||row.outcomeJson!==where.outcomeJson)return {count:0};Object.assign(row,data);return {count:1};})},deskBook:{count:async()=>1},deskRecord:{upsert:vi.fn()}};db.$transaction=async(fn:any)=>fn(db);
  io.history.mockResolvedValue({bars:bars(start-7*24*hour,7*24+24,false)});
  await observeTechnicalWatches(db,{...book,enabled:false});expect(io.history).not.toHaveBeenCalled();
  await observeTechnicalWatches(db,book);expect(row.status).toBe("triggered");expect(io.wake).toHaveBeenCalledTimes(1);expect(io.wake.mock.calls[0][4]).toBe("research");expect(io.wake.mock.calls[0][5].role).toBe("derivatives");
  vi.advanceTimersByTime(60001);await observeTechnicalWatches(db,book);expect(io.history).toHaveBeenCalledTimes(1);expect(io.wake).toHaveBeenCalledTimes(1);
 });
 it("rotates failed technical reads so the first two unavailable instruments cannot starve the next",async()=>{
  const book={id:"technical-fair-retry",version:1,enabled:true,isTestnet:false} as DeskBook;
  const rows=Array.from({length:4},(_,i)=>({id:`watch-${i}`,key:`routine:lead:1:research:${i}`,kind:"technical",thesis:"Observe alignment",instrumentId:`mainnet:perp:COIN${i}`,side:"buy",mode:"research",createdAt:new Date(start),deadline:new Date(start+24*hour),status:"open",outcomeJson:JSON.stringify({technical:spec,lastQualified:false})}));
  const db:any={deskWatch:{findMany:vi.fn(async()=>rows.filter(r=>r.status==="open").map(r=>({...r}))),updateMany:vi.fn(async({where,data})=>{const row=rows.find(r=>r.id===where.id&&r.status===where.status&&r.outcomeJson===where.outcomeJson);if(!row)return {count:0};Object.assign(row,data);return {count:1};})},deskBook:{count:async()=>1},deskRecord:{upsert:vi.fn()}};db.$transaction=async(fn:any)=>fn(db);
  io.history.mockRejectedValue(new Error("Candle history temporarily unavailable"));
  await observeTechnicalWatches(db,book);expect(io.history.mock.calls.map(c=>c[0])).toEqual(["COIN0","COIN1"]);
  vi.advanceTimersByTime(60001);await observeTechnicalWatches(db,book);
  expect(io.history.mock.calls.map(c=>c[0])).toEqual(["COIN0","COIN1","COIN2","COIN3"]);expect(io.wake).not.toHaveBeenCalled();
 });

});
