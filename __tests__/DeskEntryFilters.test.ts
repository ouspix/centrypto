// @vitest-environment node
import {describe,it,expect} from "vitest";
import {assessEntryFilters,createEntryFilterEvaluator} from "@/lib/desk/entry-filters";
import {aggregateBars,swingFeatures} from "@/lib/desk/swing";
import {candleRuleDirection,createCandleSignalEvaluator} from "@/lib/desk/rule-signal";
import {ruleDirection,validateResearchRequest} from "@/lib/desk/backtest/request";
import {describeRule,compatibleForwardEngine} from "@/lib/desk/backtest/rule-definition";
import type {Rule} from "@/lib/desk/backtest/types";
const start=Date.UTC(2026,9,1),step=300000;
const rule:Rule={name:"fixed",signal:"trend_pullback",side:"both",lookbackBars:20,thresholdBps:0,orderUsd:100,stopBps:200,targetBps:400,maxHoldBars:144,cooldownBars:144};
function data(){return Array.from({length:2400},(_,i)=>{const close=100+i*.004+Math.sin(i/11)*.7;return {at:start+i*step,open:close-.03,high:close+.1,low:close-.1,close,volume:10000};});}
const f=(direction:number,trend=100,regime=200)=>({version:"continuation-1",status:"observed" as const,direction,trendBps:trend,regimeBps:regime,asOf:start} as ReturnType<typeof swingFeatures>);
describe("explicit rule semantics",()=>{
 it("distinguishes a lookback-return fade from a prior-SMA deviation fade",()=>{
  const r={...rule,signal:"mean_reversion" as const,lookbackBars:3,thresholdBps:100};
  const prices=[100,200,200,150];
  expect(ruleDirection(r,prices)).toBe(-1); // frozen legacy contract
  expect(ruleDirection({...r,meanReference:"lookback_price"},prices)).toBe(-1);
  expect(ruleDirection({...r,meanReference:"prior_sma"},prices)).toBe(1);
  expect(describeRule({...r,meanReference:"prior_sma"},3600)).toMatchObject({legacyReference:false,exits:expect.stringContaining("No moving-average target")});
 });
 it("preserves existing forward engines only for unchanged legacy definitions",()=>{
  expect(compatibleForwardEngine("desk-research-4.2",rule,"desk-research-4.3")).toBe(true);
  expect(compatibleForwardEngine("desk-research-4.2",{...rule,entryFilter:"setup_only"},"desk-research-4.3")).toBe(false);
  expect(compatibleForwardEngine("unknown",rule,"desk-research-4.3")).toBe(false);
 });
 it("rejects false multiframe fidelity and irrelevant references",()=>{
  const req={engine:"candles",source:"venue_candles",hypothesis:"Compare explicit entry filters",start:new Date(start).toISOString(),end:new Date(start+12*86400000).toISOString(),instrumentIds:["mainnet:perp:BTC"],intervalSeconds:300,feeBpsPerSide:4.5,extraSlippageBps:5,variants:[{...rule,entryFilter:"stacked"}]};
  expect(validateResearchRequest(req,false)).toMatchObject({intervalSeconds:300});
  expect(()=>validateResearchRequest({...req,intervalSeconds:900},false)).toThrow(/300-second/);
  expect(()=>validateResearchRequest({...req,variants:[{...rule,meanReference:"prior_sma"}]},false)).toThrow(/meanReference/);
 });
});
describe("current entry sequence and controlled alternatives",()=>{
 it("requires alignment, not hourly resumption; exposes the actual missing gate",()=>{
  expect(assessEntryFilters(f(0),f(1),f(1))).toMatchObject({stacked:1,stage:"ready"});
  expect(assessEntryFilters(f(0),f(1),f(0))).toMatchObject({stacked:0,setup_only:1,entry_only:0,stage:"entry"});
  expect(assessEntryFilters(f(0),f(0),f(1))).toMatchObject({stacked:0,setup_only:0,entry_only:1,stage:"setup"});
  expect(assessEntryFilters(f(-1,-100,-200),f(-1),f(-1)).stacked).toBe(-1);
  expect(assessEntryFilters(f(0,-100,200),f(1),f(1))).toMatchObject({stacked:0,setup_only:0,entry_only:0,stage:"alignment"});
  expect(assessEntryFilters(f(0),f(1))).toMatchObject({stacked:0,stage:"entry"});
 });
 it("matches independently aggregated live frames at every tested closed boundary",()=>{
  const bars=data(),evaluate=createEntryFilterEvaluator(bars);
  for(let i=1200;i<1260;i++){
   const at=start+i*step,one=Math.floor(at/3600000)*3600000,fifteen=Math.floor(at/900000)*900000;
   const expected=assessEntryFilters(swingFeatures(aggregateBars(bars,3600000,step,one),3600000,one),swingFeatures(aggregateBars(bars,900000,step,fifteen),900000,fifteen),swingFeatures(bars,step,at));
   expect(evaluate(at)).toEqual(expected);
  }
 });
 it("honors longer permitted lookbacks instead of silently truncating hourly context",()=>{
  const bars=Array.from({length:4400},(_,i)=>{const close=100+i*.004+Math.sin(i/11)*.7;return {at:start+i*step,open:close-.03,high:close+.1,low:close-.1,close,volume:10000};});
  const at=start+4380*step,one=Math.floor(at/3600000)*3600000,fifteen=Math.floor(at/900000)*900000;
  const expected=assessEntryFilters(swingFeatures(aggregateBars(bars,3600000,step,one),3600000,one,360),swingFeatures(aggregateBars(bars,900000,step,fifteen),900000,fifteen,360),swingFeatures(bars,step,at,360));
  expect(expected.stage).not.toBe("hourly_data");
  expect(createEntryFilterEvaluator(bars,360)(at)).toEqual(expected);
 });
 it("uses no future or incomplete aggregate bars and retains side restrictions",()=>{
  const bars=data(),at=start+1500*step;
  const future=bars.map(b=>b.at>=at?{...b,close:1e9,high:1e9}:b);
  expect(createEntryFilterEvaluator(future)(at)).toEqual(createEntryFilterEvaluator(bars)(at));
  const evaluate=createCandleSignalEvaluator(bars,step);
  for(let i=1200;i<1300;i++){
   const now=start+i*step,short=evaluate({...rule,side:"short",entryFilter:"entry_only"},now);
   expect(short).toBeLessThanOrEqual(0);
   expect(evaluate({...rule,entryFilter:"stacked"},now)).toBe(candleRuleDirection({...rule,entryFilter:"stacked"},bars,step,now));
  }
  expect(createEntryFilterEvaluator(bars.filter(b=>b.at!==at-step))(at).stacked).toBe(0);
 });
 it("keeps the historic single-interval interpretation unchanged",()=>{
  const bars=data(),evaluate=createCandleSignalEvaluator(bars,step);
  for(const signal of ["trend_pullback","momentum","mean_reversion","breakout"] as const)for(let i=1200;i<1220;i++){
   const r={...rule,signal},at=start+i*step;
   expect(evaluate(r,at)).toBe(candleRuleDirection(r,bars.slice(i-1200,i),step,at));
  }
 });
});
