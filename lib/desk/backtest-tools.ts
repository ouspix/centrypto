import { prospectiveTools } from "./prospective";
import { agentResearchStatus } from "./backtest/delivery";
import { researchBacklogTools } from "./research-backlog";
import type { DeskBook } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { DeskInstrument } from "./instruments";
import type { DeskTool } from "./runtime";
import { decodeDeskArtifact } from "./artifacts";
import { researchCatalog } from "./backtest/data";
import { enqueueResearch, cancelResearch, retryFailedResearch } from "./backtest/jobs";
import { RESEARCH_HEALTH_KEY } from "./backtest/recovery";
import { researchRequestSchema } from "./backtest/request";
export { archiveRecovery } from "./backtest/data";

export function deskBacktestTools(book:DeskBook,_instrument:(id:unknown)=>Promise<DeskInstrument>):DeskTool[] {
    const observations = new Map<string,Promise<unknown>>();
    const status = (shiftId:string,id:string) => {
        const key=shiftId+":"+id;
        let pending=observations.get(key);
        if(!pending){
            pending=agentResearchStatus(prisma,book,shiftId,id).catch(error=>{observations.delete(key);throw error;});
            observations.set(key,pending);
        }
        return pending;
    };
    const runId={type:"object",additionalProperties:false,required:["runId"],properties:{runId:{type:"string",maxLength:100}}};
    return [
        ...researchBacklogTools(prisma,book),
        ...prospectiveTools(prisma,book),
        {name:"entry_filter_comparison",access:"read",description:"Read the latest predeclared matched-data comparison of stacked, 15m-only and 5m-only entry filters. Includes exact rules, costs, periods, coverage and promotion limitations. No new data requests or activation.",inputSchema:{type:"object",additionalProperties:false,properties:{}},run:async()=>{const row=await prisma.deskRecord.findFirst({where:{bookId:book.id,kind:"entry_filter_comparison",key:{startsWith:`entry-filter-comparison:${book.version}:`}},orderBy:{createdAt:"desc"}});return row?JSON.parse(row.dataJson):{status:"unavailable",note:"No comparison recorded for this book version."};}},
        {name:"research_landscape",access:"read",description:"Read the last 60 frozen experiments: tested families, sides, assets and parameters, including failed attempts. Identify an untested mechanism/direction before submitting research. No market/account reads or new experiments.",inputSchema:{type:"object",additionalProperties:false,properties:{}},run:async()=>{
            const runs=await prisma.deskResearchRun.findMany({where:{bookId:book.id,bookVersion:book.version},orderBy:{createdAt:"desc"},take:60});
            return {experiments:runs.map(r=>{const q=JSON.parse(r.requestJson).request;return {runId:r.id,status:r.status,createdAt:r.createdAt,proposalKey:q.proposalKey,instrumentIds:q.instrumentIds,start:q.start,end:q.end,intervalSeconds:q.intervalSeconds,variants:q.variants,retryOf:JSON.parse(r.manifestJson).retryOf??null};}),note:"Retries and overlapping windows are not independent confirmation. Broaden a mechanism for a stated reason; do not pick parameters from an already observed holdout."};}},
        {name:"backtest_catalog",access:"read",description:"Inspect both multi-day candle research and historical L2/top-of-book coverage and supported explicit desk rules on this book's network. Research shares desk risk checks; paper mode means active testnet trading.",
            inputSchema:{type:"object",additionalProperties:false,properties:{}},run:async()=>{const health=await prisma.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key:RESEARCH_HEALTH_KEY}}});return {...await researchCatalog(book.isTestnet),runtime:health?JSON.parse(health.dataJson):{status:"unverified"}};}},
        {name:"retry_backtest",access:"read",description:"Recover a failed experiment without changing its saved dates, rules, costs or instrument metadata. Returns the existing retry if already queued/running/completed. Original failed evidence remains immutable. Use after a verified runtime repair; no market discovery or account lookup is needed.",inputSchema:runId,run:(a,c)=>retryFailedResearch(prisma,book,String(a.runId),c.shiftId)},
        {name:"backtest_strategy",access:"read",description:"Queue a historical desk experiment. Research trend_pullback, breakout, momentum or mean_reversion with a stated market mechanism, long/short/both as appropriate. Current entry absence does not prohibit research. mean_reversion REQUIRES meanReference=prior_sma (deviation from preceding closes arithmetic mean) or lookback_price (return reversal); stops/targets remain fixed, never an implicit mean exit. To test the optional continuation-1 multi-timeframe reference sequence use trend_pullback with entryFilter=stacked at intervalSeconds=300. setup_only/entry_only drop one gate for research; omission is a single-interval proxy. Use reuseDatasetRunId to compare corrected rules against an existing frozen candle dataset without refetching history/funding; preserve dates, interval and instruments. Read ruleDefinitions in results. Save the proposal before submitting its proposalKey. For directional swing ideas use engine=candles, source=venue_candles, intervalSeconds=3600 and 30-180 days (90 preferred), or 900 for finer recent history; trend_pullback shares continuation reference closed-bar features. Use variants only, no additionalWindows for candles. Data/funding retrieved automatically for any native perp. Actual historical resolution, coverage, purge, frozen holdout and stress results are explicit. For engine=depth: explicit recorded DeskOrders (an empty list means no trades) OR up to six named momentum/mean-reversion/breakout rules with your chosen parameters. State hypothesis and cost assumptions. For substantive evidence use additionalWindows: 3-8 distinct dates with fixed rules and costs, selected before viewing performance. Link proposalKey when testing a backlog idea. A single window is only a smoke test. The host fixes the book mandate. Rules use chronological development/validation/holdout partitions; unresolved exposed intervals prevent selection, while short gaps with independent price coverage are modeled conservatively and labeled. Compare dataQuality and the observed-only reference. Returns a run ID immediately; end the task without polling. Completion schedules one review, which can use backtest_status. No policy deployment or live order.",
            inputSchema:researchRequestSchema,run:(a,c)=>enqueueResearch(prisma,book,a,undefined,c.shiftId)},
        {name:"backtest_status",access:"read",description:"Read a prior run once in its completion review. Observations are shared across roles for this shift. New submissions and pending runs defer to their completion event: no polling. Results include validation, holdout, stress and limitations; they never approve trading.",
            inputSchema:runId,run:(a,c)=>status(c.shiftId,String(a.runId))},
        {name:"backtest_cancel",access:"read",description:"Cancel this book's queued or running historical research job; no effect on venue trading.",
            inputSchema:runId,run:(a)=>cancelResearch(prisma,book.id,String(a.runId))},
        {name:"read_research_evidence",access:"read",description:"Read an owner-scoped evidence artifact in bounded JSON text chunks, including complete tool observations or a research dataset/result. Offset counts characters. Hash identifies the complete uncompressed JSON.",
            inputSchema:{type:"object",additionalProperties:false,required:["artifactId","offset"],properties:{
                artifactId:{type:"string",maxLength:100},offset:{type:"integer",minimum:0}}},
            run:async a=>{
                if(!Number.isSafeInteger(a.offset)||Number(a.offset)<0)throw new Error("Invalid evidence offset.");
                const row=await prisma.deskArtifact.findFirst({where:{id:String(a.artifactId),bookId:book.id}});
                if(!row)throw new Error("Evidence not found for this book.");
                const json=JSON.stringify(decodeDeskArtifact(row)),offset=Number(a.offset);
                return {artifactId:row.id,sha256:row.sha256,offset,totalCharacters:json.length,
                    text:json.slice(offset,offset+12000),nextOffset:offset+12000<json.length?offset+12000:null};
            }},
    ];
}

