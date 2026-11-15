import { createHash } from "node:crypto";
import { historicalCandles, historicalFunding, candleHistoryCoverage, type CandleInterval } from "../candle-history";
import { SWING_VERSION, type SwingBar } from "../swing";
import { sizeSwingRisk } from "../risk-sizing";
import { DIRECTIONAL_HOST_LIMITS, LEGACY_SIZING_DEFAULTS } from "../mandate";
import type { DeskInstrument } from "../instruments";
import type { ResearchRequest, ResearchContext, Rule } from "./types";
import { describeRule } from "./rule-definition";
import { createCandleSignalEvaluator } from "../rule-signal";
import { assessCandleEvidence } from "./evidence";

export type CandleDataset = {instrument:DeskInstrument;bars:SwingBar[];funding:Array<{at:number;rate:number}>;coverage:ReturnType<typeof candleHistoryCoverage>;provenance:unknown}[];
export async function loadCandleResearch(request:ResearchRequest,testnet:boolean,instruments:DeskInstrument[],signal:AbortSignal):Promise<CandleDataset>{
    const interval=({300:"5m",900:"15m",3600:"1h"} as Record<number,CandleInterval>)[request.intervalSeconds];
    // Explicit multi-timeframe rules need 20 completed 4h bars plus alignment,
    // not an unconditional seven-day 5m download beyond native retention.
    const warmupMs=request.variants?.some(v=>v.entryFilter)?Math.max(84*3600000,...request.variants.map(v=>(v.lookbackBars+2)*3600000)):7*86400000;
    const data:CandleDataset=[];
    for(const instrument of instruments){
        signal.throwIfAborted();
        const history=await historicalCandles(instrument.coin,interval,Date.parse(request.start)-warmupMs,Date.parse(request.end),testnet,signal);
        const funding=await historicalFunding(instrument.coin,Date.parse(request.start),Date.parse(request.end),testnet,signal);
        const {bars,...provenance}=history;
        data.push({instrument,bars,funding,coverage:candleHistoryCoverage(bars,Date.parse(request.start),Date.parse(request.end),request.intervalSeconds*1000),provenance});
    }
    return data;
}
type Position={id:string;quantity:number;entry:number;stop:number;target:number;opened:number;fee:number;funding:number;mae:number;mfe:number};
export function simulateCandles(data:CandleDataset,context:ResearchContext,request:ResearchRequest,rule:Rule,from:number,through:number,costMultiplier=1,prospective?:{decisions:Array<{instrumentId:string;entryAt:number;direction:number;decidedAt:number}>},evaluators?:ReturnType<typeof createCandleSignalEvaluator>[]){
    const signalEvaluators=prospective?[]:evaluators??data.map(d=>createCandleSignalEvaluator(d.bars,request.intervalSeconds*1000));
    const step=request.intervalSeconds*1000,m=context.mandate,capital=Math.min(DIRECTIONAL_HOST_LIMITS.capitalUsd,m.capitalUsd),slip=request.extraSlippageBps/10000*costMultiplier,fee=request.feeBpsPerSide/10000*costMultiplier;
    let cash=capital,fees=0,fundingPaid=0,peak=capital,drawdown=0,rejected=0,missingExposedBars=0,missingFunding=0;
    const positions=new Map<string,Position>(),cooldown=new Map<string,number>(),lastSeen=new Map<string,number>(),marks=new Map<string,number>();
    const trades:Array<{instrumentId:string;side:string;openedAt:string;closedAt:string;entry:number;exit:number;quantity:number;netPnlUsd:number;feesUsd:number;fundingUsd:number;reason:string;maeBps:number;mfeBps:number}>=[];
    const equity:Array<{at:string;equityUsd:number}>=[],fills:Array<{at:string;instrumentId:string;side:string;price:number;quantity:number;feeUsd:number;reason:string}>=[];
    const maps=data.map(d=>new Map(d.bars.map((b,i)=>[b.at,{bar:b,index:i}]))),funds=data.map(d=>new Map(d.funding.filter(f=>f.at%3600000<=5000).map(f=>[Math.floor(f.at/3600000)*3600000,f.rate])));
    const signalCache=new Map<string,number>(),missingFundingBoundaries=new Set<number>();
    const observedDecisions=new Map(prospective?.decisions.filter(d=>d.decidedAt<d.entryAt).map(d=>[`${d.instrumentId}:${d.entryAt}`,d.direction])??[]);
    const worth=()=>cash+[...positions.values()].reduce((s,p)=>s+p.quantity*((marks.get(p.id)??p.entry)-p.entry),0);
    function close(p:Position,raw:number,at:number,reason:string){
        const price=raw*(1-Math.sign(p.quantity)*slip),exitFee=Math.abs(p.quantity)*price*fee,pnl=p.quantity*(price-p.entry);
        cash+=pnl-exitFee;fees+=exitFee;
        fills.push({at:new Date(at).toISOString(),instrumentId:p.id,side:p.quantity>0?"sell":"buy",price,quantity:Math.abs(p.quantity),feeUsd:exitFee,reason});
        trades.push({instrumentId:p.id,side:p.quantity>0?"long":"short",openedAt:new Date(p.opened).toISOString(),closedAt:new Date(at).toISOString(),entry:p.entry,exit:price,quantity:Math.abs(p.quantity),netPnlUsd:pnl-p.fee-exitFee-p.funding,feesUsd:p.fee+exitFee,fundingUsd:p.funding,reason,maeBps:p.mae,mfeBps:p.mfe});
        positions.delete(p.id);cooldown.set(p.id,at+rule.cooldownBars*step);
    }
    let day="",dayStart=capital;
    for(let at=Math.ceil(from/step)*step;at<through;at+=step){
        const rows=maps.map(map=>map.get(at));
        rows.forEach((r,j)=>{if(r)marks.set(data[j].instrument.id,r.bar.open);});
        const nextDay=new Date(at).toISOString().slice(0,10);if(day!==nextDay){day=nextDay;dayStart=worth();}
        // Funding at the boundary belongs only to exposure carried into that boundary.
        for(let j=0;j<data.length;j++){
            const d=data[j],id=d.instrument.id,p=positions.get(id),r=rows[j];
            if(p&&at%3600000===0){const rate=funds[j].get(at);if(rate===undefined){missingFunding++;missingFundingBoundaries.add(at);}else{const paid=p.quantity*(marks.get(id)??p.entry)*rate;cash-=paid;fundingPaid+=paid;p.funding+=paid;}}
            if(!r){if(p)missingExposedBars++;continue;}
            if(p&&lastSeen.has(id)&&at-lastSeen.get(id)!>step)close(p,r.bar.open,at,"first_price_after_gap");
            else if(p&&at>=p.opened+rule.maxHoldBars*step)close(p,r.bar.open,at,"time_exit");
            lastSeen.set(id,at);
        }
        for(let j=0;j<data.length;j++){
            const d=data[j],id=d.instrument.id,r=rows[j];if(!r||positions.has(id)||at<(cooldown.get(id)??0)||(!prospective&&at+rule.maxHoldBars*step>=through))continue;
            const before=d.bars.slice(Math.max(0,r.index-1200),r.index),previous=before.at(-1);
            if(!previous||previous.at+step!==at||previous.volume<=0)continue;
            const key=`${id}:${at}:${rule.signal}:${rule.lookbackBars}`;
            let direction=signalCache.get(key);
            if(direction===undefined){
                direction=prospective?(observedDecisions.get(`${id}:${at}`)??0):signalEvaluators[j](rule,at);
                signalCache.set(key,direction);
            }
            if(!direction)continue;
            if(positions.size>=(m.maxConcurrentPositions??LEGACY_SIZING_DEFAULTS.concurrentPositions)||worth()-dayStart<=-m.maxDailyLossUsd){rejected++;continue;}
            const entry=r.bar.open*(1+direction*slip),stop=entry*(1-direction*rule.stopBps/10000),target=entry*(1+direction*rule.targetBps/10000);
            const committed=[...positions.values()].reduce((n,p)=>n+Math.abs(p.quantity)*(marks.get(p.id)??p.entry),0);
            const openRisk=[...positions.values()].reduce((n,p)=>n+Math.max(0,((marks.get(p.id)??p.entry)-p.stop)*p.quantity)+Math.abs(p.quantity)*p.entry*(m.costAllowanceBps??50)/10000,0);
            const size=sizeSwingRisk({entry,stop,side:direction>0?"buy":"sell",equityUsd:worth(),committedUsd:committed,openRiskUsd:openRisk,instrumentUsd:0,depthUsd:previous.volume*previous.close*0.01,szDecimals:d.instrument.szDecimals,mandate:{...m,minDepthUsd:0,maxOrderUsd:Math.min(rule.orderUsd,m.maxOrderUsd),costAllowanceBps:Math.max(m.costAllowanceBps??50,2*(request.feeBpsPerSide+request.extraSlippageBps)*costMultiplier)}});
            // Volume is a participation assumption, never fabricated historical depth.
            const quantity=Math.floor(Math.min(size.quantity,previous.volume*0.01)*10**d.instrument.szDecimals)/10**d.instrument.szDecimals;
            if(quantity*entry<10||r.bar.volume<=0){rejected++;continue;}
            const entryFee=quantity*entry*fee;cash-=entryFee;fees+=entryFee;
            positions.set(id,{id,quantity:quantity*direction,entry,stop,target,opened:at,fee:entryFee,funding:0,mae:0,mfe:0});
            fills.push({at:new Date(at).toISOString(),instrumentId:id,side:direction>0?"buy":"sell",price:entry,quantity,feeUsd:entryFee,reason:"next_bar_entry"});
        }
        for(let j=0;j<data.length;j++){
            const id=data[j].instrument.id,r=rows[j],p=positions.get(id);if(!r)continue;
            if(p){
                const long=p.quantity>0,b=r.bar;
                p.mae=Math.min(p.mae,((long?b.low:b.high)/p.entry-1)*Math.sign(p.quantity)*10000);
                p.mfe=Math.max(p.mfe,((long?b.high:b.low)/p.entry-1)*Math.sign(p.quantity)*10000);
                const stopHit=long?b.low<=p.stop:b.high>=p.stop,targetHit=long?b.high>=p.target:b.low<=p.target;
                if(stopHit)close(p,long?Math.min(p.stop,b.open):Math.max(p.stop,b.open),at+step,"stop_first_if_ambiguous");
                else if(targetHit)close(p,p.target,at+step,"target_conservative");
            }
            marks.set(id,r.bar.close);
        }
        const value=worth();peak=Math.max(peak,value);drawdown=Math.max(drawdown,(peak-value)/peak*100);equity.push({at:new Date(at+step).toISOString(),equityUsd:value});
    }
    const unresolved=positions.size;
    const pnl=worth()-capital,mean=trades.length?trades.reduce((n,t)=>n+t.netPnlUsd,0)/trades.length:null;
    const sd=trades.length>1?Math.sqrt(trades.reduce((n,t)=>n+(t.netPnlUsd-mean!)**2,0)/(trades.length-1)):null;
    return {from:new Date(from).toISOString(),through:new Date(through).toISOString(),metrics:{initialCapitalUsd:capital,equityUsd:worth(),netPnlUsd:pnl,returnPct:pnl/capital*100,maxDrawdownPct:drawdown,feesUsd:fees,fundingUsd:fundingPaid,closedTrades:trades.length,fills:fills.length,rejectedOrders:rejected,netExpectancyUsd:mean,tradeStdDevUsd:sd,standardErrorDescriptiveUsd:sd===null?null:sd/Math.sqrt(trades.length)},
        dataQuality:{usableForSelection:missingExposedBars===0&&missingFunding===0&&unresolved===0,missingExposedBars,missingFundingWhileExposed:missingFunding,missingFundingBoundaries:[...missingFundingBoundaries],unresolvedPositions:unresolved},
        trades,fills,equity,endingPositions:[...positions.values()],limitations:["Candle simulation, not observed depth or verified fills. Next-bar entry; adverse slippage on both sides; stop before target on ambiguous bars; gap stops at worse opening price.","Funding settlement timestamps within five seconds after the hourly boundary map to that settlement hour; original timestamps remain in the dataset. Boundary entries follow settlement. Other timestamps remain unresolved. Position size capped at 1% of prior closed bar volume. No maker fills or queue assumptions. Funding uses actual settled rates and candle boundary price as oracle proxy.","Trade standard error is descriptive: overlapping market regimes and correlated trades invalidate an IID confidence claim. One capital pool across instruments; no reset within a partition."]};
}
export function runCandleResearch(data:CandleDataset,context:ResearchContext,request:ResearchRequest){
    const start=Date.parse(request.start),end=Date.parse(request.end),step=request.intervalSeconds*1000,purge=Math.max(...request.variants!.map(v=>v.maxHoldBars))*step;
    const validationStart=Math.floor((start+(end-start)*0.5)/step)*step,holdoutStart=Math.floor((start+(end-start)*0.75)/step)*step;
    const evaluators=data.map(d=>createCandleSignalEvaluator(d.bars,step));
    const simulate=(rule:Rule,from:number,through:number,cost=1)=>simulateCandles(data,context,request,rule,from,through,cost,undefined,evaluators);
    const variants=request.variants!.map(rule=>({name:rule.name,rule,development:simulate(rule,start,validationStart-purge),validation:simulate(rule,validationStart,holdoutStart-purge)}));
    // Simulator already prevents entries whose maximum hold reaches the fold end.
    // Do not subtract another full hold per fold, making short 5m studies untradable.
    const validationEnd=holdoutStart-purge,foldCount=Math.min(3,Math.max(1,Math.floor((validationEnd-validationStart)/(3*purge))));
    const validationFolds=variants.map(v=>({name:v.name,foldCount,minimumFoldSpanHours:3*purge/3600000,folds:Array.from({length:foldCount},(_,index)=>{
        const foldStart=validationStart+Math.floor((validationEnd-validationStart)*index/foldCount/step)*step;
        const foldEnd=validationStart+Math.floor((validationEnd-validationStart)*(index+1)/foldCount/step)*step;
        const result=simulate(v.rule,foldStart,foldEnd);
        return {from:result.from,through:result.through,metrics:result.metrics,dataQuality:result.dataQuality};
    })}));
    const winner=variants.filter(v=>v.validation.dataQuality.usableForSelection&&v.validation.metrics.closedTrades>0).sort((a,b)=>b.validation.metrics.netPnlUsd-a.validation.metrics.netPnlUsd)[0]??variants.find(v=>v.validation.dataQuality.usableForSelection);
    const holdout=winner?simulate(winner.rule,holdoutStart,end):null;
    const stressedHoldout=winner?simulate(winner.rule,holdoutStart,end,2):null;
    const fullCoverage=data.every(d=>d.coverage.complete);
    const benchmarks=data.map(d=>{const bars=d.bars.filter(b=>b.at>=holdoutStart&&b.at+step<=end),first=bars[0],last=bars.at(-1);return {instrumentId:d.instrument.id,buyAndHoldGrossReturnPct:first&&last?(last.close/first.open-1)*100:null,from:first?new Date(first.at).toISOString():null,through:last?new Date(last.at+step).toISOString():null,note:"Unlevered passive gross price reference; excludes costs/funding and is not the strategy equity curve."};});
    return {engine:"desk-candle-1",intervalSeconds:request.intervalSeconds,scope:"chronological_candle_swing",strategyVersion:request.variants!.every(v=>v.signal==="trend_pullback"&&v.entryFilter==="stacked"&&v.lookbackBars===20&&v.thresholdBps===0)?SWING_VERSION:null,ruleDefinitions:request.variants!.map(v=>describeRule(v,request.intervalSeconds)),ruleFamilies:[...new Set(request.variants!.map(v=>v.signal))],liveActivation:false,dataHash:createHash("sha256").update(JSON.stringify(data)).digest("hex"),proposalKey:request.proposalKey??null,
        coverage:{instruments:data.map(d=>({instrumentId:d.instrument.id,...d.coverage,provenance:d.provenance})),complete:fullCoverage},
        partitions:{development:[start,validationStart-purge],validation:[validationStart,holdoutStart-purge],holdout:[holdoutStart,end],purgeHours:purge/3600000,warmup:"Requested prehistory: seven days for single-interval rules; at least 84 hours (or longer lookback need) for multi-timeframe rules. Actual availability remains in coverage provenance. Only closed bars consumed; no entries within maxHold of partition end."},
        validationFolds,variants,selectedVariant:winner?.name??null,holdout,stressedHoldout,benchmarks,
        assessment:assessCandleEvidence({coverage:fullCoverage,validation:winner?.validation,holdout,stress:stressedHoldout,folds:validationFolds.find(f=>f.name===winner?.name)?.folds}),
        limitations:["Requested resolution is used honestly: an hourly test does not reconstruct 15m setups or 5m execution.","Validation uses up to three successive folds with a minimum three-hold span when available; the simulator stops new entries one maximum hold before each fold end. Fewer folds mean less temporal evidence. Parameters are not re-fit within folds. One frozen holdout per submitted specification; repeated revisions reuse market history and are not independent confirmation. Prospective verification remains required."]};
}
