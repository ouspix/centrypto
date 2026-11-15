import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hyperliquidInfoUrl } from "@/lib/hyperliquid-info";
import type { SwingBar } from "./swing";

export const CANDLE_INTERVALS = {"5m":300000,"15m":900000,"1h":3600000,"4h":14400000} as const;
export type CandleInterval = keyof typeof CANDLE_INTERVALS;
export type HistoricalBar = SwingBar & { availableAt: number; firstObservedAt: number; source: "hyperliquid_candle_snapshot" };
export function candleHistoryCoverage(bars: SwingBar[], from: number, through: number, step: number) {
    const start = Math.ceil(from/step)*step, end = Math.floor(through/step)*step;
    const observed = new Set(bars.filter(b=>b.at>=start&&b.at+step<=end).map(b=>b.at));
    const gaps: Array<{from:string;through:string;bars:number}> = [];
    let gapStart: number|null=null;
    for(let t=start;t<end;t+=step) {
        if(!observed.has(t)&&gapStart===null)gapStart=t;
        if(observed.has(t)&&gapStart!==null){gaps.push({from:new Date(gapStart).toISOString(),through:new Date(t).toISOString(),bars:(t-gapStart)/step});gapStart=null;}
    }
    if(gapStart!==null)gaps.push({from:new Date(gapStart).toISOString(),through:new Date(end).toISOString(),bars:(end-gapStart)/step});
    const expected=Math.max(0,(end-start)/step),missing=expected-observed.size;
    return {expected,observed:observed.size,missing,complete:missing===0&&expected>0,gaps,zeroVolumeBars:bars.filter(b=>b.at>=start&&b.at<end&&b.volume===0).length};
}
async function info(testnet: boolean, body: object, signal: AbortSignal) {
    const { deferredResearchRead } = await import("./read-queue");
    return deferredResearchRead(testnet, async () => {
    const response=await fetch(hyperliquidInfoUrl(testnet),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
    if(!response.ok)throw new Error(`Historical API ${response.status}`);
    return response.json();
    }, signal);
}
/** Cache is network/interval scoped. Retention holes are reported, never filled with future or invented prices. */
export async function historicalCandles(coin:string,interval:CandleInterval,from:number,through:number,testnet:boolean,signal:AbortSignal) {
    if(!/^[A-Za-z0-9_.-]{1,50}$/.test(coin)||!CANDLE_INTERVALS[interval])throw new Error("Invalid candle instrument/interval");
    const step=CANDLE_INTERVALS[interval],end=Math.min(Math.floor(Date.now()/step)*step,Math.floor(through/step)*step),start=Math.ceil(from/step)*step;
    if(end<=start||end-start>190*86400000)throw new Error("Choose a completed interval within 190 days");
    const dir=join(process.env.DESK_HISTORY_CACHE_DIR??".runtime/desk-candles",testnet?"testnet":"mainnet");
    const file=join(dir,`${coin}-${interval}.json`);
    let cached:HistoricalBar[]=[];
    try{cached=JSON.parse(await readFile(file,"utf8")).bars??[];}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")cached=[];}
    const initial=cached.filter(b=>b.at>=start&&b.at+step<=end);
    if(candleHistoryCoverage(initial,start,end,step).complete)return {coin,interval,bars:initial.sort((a,b)=>a.at-b.at),coverage:candleHistoryCoverage(initial,start,end,step),retrievedAt:new Date().toISOString(),source:"cache",retention:"Venue returns at most the latest 5000 candles per interval. Cached earlier bars extend coverage only when actually observed."};
    // Request only the missing tail when earlier closed bars are already cached.
    const missingFrom=Date.parse(candleHistoryCoverage(initial,start,end,step).gaps[0]?.from??new Date(start).toISOString());
    const raw=await info(testnet,{type:"candleSnapshot",req:{coin,interval,startTime:missingFrom,endTime:end}},signal);
    if(!Array.isArray(raw))throw new Error("Invalid historical candles response");
    const seen=new Map(cached.map(b=>[b.at,b]));
    for(const r of raw){
        const at=Number(r.t),open=Number(r.o),high=Number(r.h),low=Number(r.l),close=Number(r.c),volume=Number(r.v);
        if(![at,open,high,low,close,volume].every(Number.isFinite)||at%step!==0||at+step>end||Math.min(open,low,close)<=0||volume<0||high<Math.max(open,close)||low>Math.min(open,close))continue;
        seen.set(at,{at,open,high,low,close,volume,availableAt:at+step,firstObservedAt:seen.get(at)?.firstObservedAt??Date.now(),source:"hyperliquid_candle_snapshot"});
    }
    const all=[...seen.values()].filter(b=>b.at>=Date.now()-190*86400000).sort((a,b)=>a.at-b.at);
    await mkdir(dir,{recursive:true});const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp,JSON.stringify({coin,interval,bars:all}));await rename(tmp,file);
    const bars=all.filter(b=>b.at>=start&&b.at+step<=end);
    return {coin,interval,bars,coverage:candleHistoryCoverage(bars,start,end,step),retrievedAt:new Date().toISOString(),source:"hyperliquid_plus_observed_cache",retention:"Latest 5000 venue bars per interval; requests beyond retention remain explicit gaps. availableAt is bar close, firstObservedAt is our retrieval time. No historic news availability is inferred."};
}
export async function historicalFunding(coin:string,from:number,through:number,testnet:boolean,signal:AbortSignal) {
    const events:Array<{at:number;rate:number}>=[];
    let cursor=from;
    for(let page=0;page<12&&cursor<through;page++){
        const rows=await info(testnet,{type:"fundingHistory",coin,startTime:cursor,endTime:through},signal);
        if(!Array.isArray(rows))throw new Error("Invalid settled funding response");
        const valid=rows.map(r=>({at:Number(r.time),rate:Number(r.fundingRate)})).filter(r=>Number.isFinite(r.at)&&Number.isFinite(r.rate)&&r.at>=cursor&&r.at<through).sort((a,b)=>a.at-b.at);
        if(!valid.length)break;events.push(...valid);cursor=valid.at(-1)!.at+1;
    }
    return [...new Map(events.map(e=>[e.at,e])).values()];
}
