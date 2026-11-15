import { watchView } from "./watch-state";
import { watchOwner } from "./routine-work";
import type { DeskBook, PrismaClient } from "@prisma/client";
import { historicalCandles } from "./candle-history";
import { swingFeatures, type SwingBar } from "./swing";
import { queueWake } from "./books";

export type TechnicalWatch = {intervalSeconds:300|900|3600;condition:"alignment"|"resumption";minTrendBps:number};
export const technicalWatchSchema={type:"object",additionalProperties:false,required:["intervalSeconds","condition","minTrendBps"],properties:{
    intervalSeconds:{type:"integer",enum:[300,900,3600]},condition:{type:"string",enum:["alignment","resumption"]},minTrendBps:{type:"number",minimum:0,maximum:5000}}};
export function validateTechnicalWatch(value:unknown):TechnicalWatch {
    const v=value as TechnicalWatch;
    if(!v||![300,900,3600].includes(v.intervalSeconds)||!["alignment","resumption"].includes(v.condition)||!Number.isFinite(v.minTrendBps)||v.minTrendBps<0||v.minTrendBps>5000)
        throw new Error("Technical watch needs a 300/900/3600-second interval, alignment/resumption condition and minTrendBps between 0 and 5000.");
    return {intervalSeconds:v.intervalSeconds,condition:v.condition,minTrendBps:v.minTrendBps};
}
export function technicalState(bars:SwingBar[],spec:TechnicalWatch,side:string,asOf:number) {
    const f=swingFeatures(bars,spec.intervalSeconds*1000,asOf),direction=side==="buy"?1:-1;
    const step=spec.intervalSeconds*1000,tail=bars.filter(b=>b.at+step<=asOf).sort((a,b)=>a.at-b.at).slice(-80*3600000/step);
    const contiguous=tail.length===80*3600000/step&&tail.at(-1)!.at+step===asOf&&tail.every((b,i)=>!i||b.at-tail[i-1].at===step);
    const observed=contiguous&&f.status==="observed"&&f.trendBps!=null&&f.regimeBps!=null;
    const aligned=observed&&Math.sign(f.trendBps!)===direction&&Math.sign(f.regimeBps!)===direction&&Math.abs(f.trendBps!)>=spec.minTrendBps;
    return {observed,qualified:!!aligned&&(spec.condition==="alignment"||f.direction===direction),features:f};
}
export function technicalTransition(bars:SwingBar[],spec:TechnicalWatch,side:string,createdAt:number,asOf:number,lastQualified?:boolean) {
    const step=spec.intervalSeconds*1000,current=technicalState(bars,spec,side,asOf);
    if(!current.observed||asOf<=createdAt)return {...current,triggered:false};
    const baseline=technicalState(bars,spec,side,Math.floor(createdAt/step)*step);
    const known=lastQualified!==undefined||baseline.observed;
    return {...current,triggered:current.qualified&&(spec.condition==="resumption"||(known&&!(lastQualified??baseline.qualified)))};
}

const scanAt=new Map<string,number>();
/** Two due instruments per minute, sequentially; once per newly closed bar.
 * A watch creates one review, never an order or a recurring model timer. */
export async function observeTechnicalWatches(db:PrismaClient,book:DeskBook,now=Date.now()) {
    if(!book.enabled||now-(scanAt.get(book.id)??0)<60_000)return;
    scanAt.set(book.id,now);
    const watches=await db.deskWatch.findMany({where:{bookId:book.id,kind:"technical",status:"open",deadline:{gt:new Date(now)},key:{contains:`:${book.version}:`}},orderBy:{createdAt:"asc"}});
    const due=watches.map(w=>({w,o:JSON.parse(w.outcomeJson??"{}")})).filter(({o})=>o.technical&&
        (o.lastCheckedBar??0)<Math.floor(now/(o.technical.intervalSeconds*1000))*o.technical.intervalSeconds*1000)
        .sort((a,b)=>(a.o.lastAttemptAt??0)-(b.o.lastAttemptAt??0)).slice(0,2);
    for(const {w,o} of due){
        const spec=validateTechnicalWatch(o.technical),step=spec.intervalSeconds*1000,asOf=Math.floor(now/step)*step;
        const coin=w.instrumentId?.split(":perp:")[1];if(!coin||!["buy","sell"].includes(w.side??""))continue;
        try {
            if(!(await db.deskWatch.updateMany({where:{id:w.id,status:"open",outcomeJson:w.outcomeJson},data:{outcomeJson:JSON.stringify({...o,lastAttemptAt:now})}})).count)continue;
            w.outcomeJson=JSON.stringify({...o,lastAttemptAt:now});o.lastAttemptAt=now;
            const history=await historicalCandles(coin,spec.intervalSeconds===300?"5m":spec.intervalSeconds===900?"15m":"1h",asOf-5*86400000,asOf,book.isTestnet,AbortSignal.timeout(15000));
            const state=technicalTransition(history.bars,spec,w.side!,+w.createdAt,asOf,o.lastQualified);
            const checked={...o,lastCheckedBar:state.observed?asOf:o.lastCheckedBar,lastQualified:state.observed?state.qualified:o.lastQualified,lastObservedAt:new Date(now).toISOString(),features:state.features};
            await db.$transaction(async tx=>{
                if(!await tx.deskBook.count({where:{id:book.id,enabled:true,version:book.version}}))return;
                const won=await tx.deskWatch.updateMany({where:{id:w.id,status:"open",outcomeJson:w.outcomeJson},data:{status:state.triggered?"triggered":"open",outcomeJson:JSON.stringify(checked)}});
                if(won.count&&state.triggered)await queueWake(tx,book,"technical:"+w.id,"watch",w.mode as "live"|"research",{role:await watchOwner(tx,w),watchId:w.id,subjects:watchView(w).subjects,proposalKeys:watchView(w).proposalKeys,condition:"technical_setup",instrumentId:w.instrumentId,side:w.side,technical:spec,features:state.features,barClosedAt:new Date(asOf).toISOString(),thesis:w.thesis,
                    instruction:"The registered closed-bar condition changed. Reassess the entry using current evidence; this is not order authorization."},6,new Date(now),new Date(Math.min(+w.deadline,now+step)));
            });
        } catch(error) {
            await db.deskRecord.upsert({where:{bookId_key:{bookId:book.id,key:"technical-watch-error:"+w.id}},create:{bookId:book.id,key:"technical-watch-error:"+w.id,kind:"technical_watch_error",role:"host",dataJson:JSON.stringify({watchId:w.id,error:error instanceof Error?error.message:"Observation unavailable",at:new Date(now)})},update:{dataJson:JSON.stringify({watchId:w.id,error:error instanceof Error?error.message:"Observation unavailable",at:new Date(now)})}});
        }
    }
}
