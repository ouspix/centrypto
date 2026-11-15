import { createHash } from "node:crypto";
import { queueWake } from "./books";
import { consumeResearchReviews } from "./backtest/delivery";
import { ENGINE_VERSION } from "./backtest/types";
import type { DeskBook, PrismaClient } from "@prisma/client";
import type { TradeProposal } from "./proposals";
import { journalTransaction } from "./journal";
import type { DeskTool } from "./runtime";

export async function researchBacklog(db: PrismaClient, book: DeskBook, limit=8, includeClosed=false) {
  const [rows, runs, decisions] = await Promise.all([
    db.deskRecord.findMany({where:{bookId:book.id,kind:"trade_proposal",key:{startsWith:`proposal:${book.version}:`}},orderBy:{createdAt:"desc"},take:96}),
    db.deskResearchRun.findMany({where:{bookId:book.id,bookVersion:book.version},orderBy:{createdAt:"desc"},take:100}),
    db.deskRecord.findMany({where:{bookId:book.id,kind:"research_disposition",key:{startsWith:`research-disposition:${book.version}:`}},orderBy:{createdAt:"desc"},take:96})
  ]);
  const seen = new Set<string>();
  // A research-mode copy cannot hide or supersede its live proposal. The live
  // lead owns that board; dispositions are bound to its canonical revision.
  const canonical=[...rows.filter(r=>r.key.includes(":live:")),...rows.filter(r=>!r.key.includes(":live:"))];
  return canonical.flatMap(row=>{
    const p=JSON.parse(row.dataJson) as TradeProposal;
    if(seen.has(p.key)) return [];
    seen.add(p.key);
    if(p.status === "closed"&&!includeClosed && !(p.researchPlan??[]).some(t=>t.status==="ready" && ["backtest_strategy","start_prospective_test"].includes(t.nextTool))) return [];
    // Some early experiments predate proposal creation. Explicit, same-book
    // proposal evidence and immutable retry lineage link them without rewriting
    // their frozen request or guessing from an instrument ticker.
    const cited = new Set([...(p.setup?.backtestRunIds??[]),...(p.researchPlan??[]).flatMap(task=>task.evidenceIds??[])]);
    const attempts=runs.filter(run=>JSON.parse(run.requestJson).request.proposalKey === p.key || cited.has(run.id) || cited.has(JSON.parse(run.manifestJson).retryOf));
    const disposition=decisions.map(d=>JSON.parse(d.dataJson)).find(d=>d.proposalKey === p.key);
    const active=attempts.some(a=>["queued","running"].includes(a.status));
    const newResult=attempts.some(a=>a.status==="completed" && a.finishedAt && (!disposition||+a.finishedAt>Date.parse(disposition.reviewedAt)));
    const freshDisposition=!newResult && disposition && disposition.proposalRevision === p.revision && disposition.engine === ENGINE_VERSION;
    const due = !active && (!freshDisposition || disposition.status === "waiting_external" && Date.parse(disposition.nextReviewAt)<=Date.now());
    return [{proposalKey:p.key,proposalRevision:p.revision,mode:row.key.includes(":live:")?"live":"research",
      thesis:p.thesis,legs:p.legs,missingEvidence:p.missingEvidence,researchPlan:p.researchPlan,
      updatedAt:p.updatedAt,expired:Date.parse(p.validUntil)<=Date.now(),due,disposition:disposition??null,
      attempts:attempts.map(a=>({runId:a.id,originShiftId:JSON.parse(a.requestJson).context.originShiftId??null,status:a.status,createdAt:a.createdAt,error:a.error,proposalRevision:JSON.parse(a.requestJson).context.proposalRevision ?? null,engine:JSON.parse(a.manifestJson).engine})),
      action:active?"Review completion; do not duplicate this run.":attempts.filter(a=>a.status==="completed" && JSON.parse(a.requestJson).context.proposalRevision===p.revision && JSON.parse(a.manifestJson).engine===ENGINE_VERSION).length>=2
        ? "Two completed attempts: read their results and resolve the idea or specify a real external dependency. Do not submit unchanged research again."
        : "Test this mechanism across multiple dates or resolve its exact historical-data dependency."}];
  }).sort((a,b)=>Number(b.due)-Number(a.due)||Date.parse(a.updatedAt)-Date.parse(b.updatedAt)).slice(0,limit);
}
export function researchBacklogTools(db: PrismaClient, book: DeskBook): DeskTool[] {
  return [
    {name:"research_backlog",access:"read",description:"Read this book's live AND research ideas, oldest due first, linked replay attempts and dispositions. A read-only research shift can investigate a live idea without changing its trade proposal or placing orders.",inputSchema:{type:"object",additionalProperties:false,properties:{}},run:()=>researchBacklog(db,book)},
    {name:"resolve_research_idea",access:"journal",description:"Lead records a durable research disposition. runIds may cite any linked failed, pending or completed attempt; evidence_ready and rejected require at least one completed result. evidence_ready requires a completed candle experiment or depth campaign. waiting_external needs a coverage/status observation and exact external dependency with nextReviewAt (30 minutes to seven days). Queued runs already wake on completion: do not add extra polling reminders. This never promotes a trade or alters execution.",
      inputSchema:{type:"object",additionalProperties:false,required:["proposalKey","status","reason","runIds","nextReviewAt"],properties:{proposalKey:{type:"string",maxLength:80},status:{type:"string",enum:["evidence_ready","rejected","waiting_external"]},reason:{type:"string",minLength:30,maxLength:1600},runIds:{type:"array",maxItems:8,items:{type:"string"}},nextReviewAt:{type:["string","null"]}}},
      run:async(a,c)=>{
        if(c.role!=="lead")throw new Error("Only the lead resolves research ideas.");
        const idea=(await researchBacklog(db,book,96,true)).find(p=>p.proposalKey===a.proposalKey);
        if(!idea)throw new Error("Idea not found in this book's backlog.");
        if(!["evidence_ready","rejected","waiting_external"].includes(String(a.status)) || typeof a.reason!=="string" || a.reason.length<30 || a.reason.length>1600 || !Array.isArray(a.runIds) || a.runIds.length>8)throw new Error("Invalid research disposition.");
        const runIds = a.runIds as string[];
        const linked=idea.attempts.filter(r=>runIds.includes(r.runId));
        if(linked.length!==runIds.length)throw new Error("Cite each linked run only once; run IDs must belong to this idea.");
        const completed=linked.filter(r=>r.status==="completed");
        if(a.status!=="waiting_external"&&!completed.length)throw new Error("Inspect at least one completed linked result before rejecting or marking evidence ready. Failed/pending attempts alone cannot establish performance.");
        if(a.status==="evidence_ready") {
          const campaign=await db.deskResearchRun.findFirst({where:{bookId:book.id,id:{in:completed.map(r=>r.runId)}}});
          if(!campaign || !(JSON.parse(campaign.requestJson).request.additionalWindows || JSON.parse(campaign.requestJson).request.engine === "candles"))throw new Error("A single short window is preliminary; submit a campaign.");
        }
        if(a.status==="waiting_external"){
          const observations=await db.deskRecord.findMany({where:{bookId:book.id,shiftId:c.shiftId,kind:"tool_result"},orderBy:{createdAt:"desc"},take:80});
          if(!observations.some(r=>/backtest_catalog|swing_context|backtest_status/.test(r.dataJson)))throw new Error("Check actual candle/depth coverage or completed results in this shift before parking an external data dependency");
        }
        const next=typeof a.nextReviewAt==="string"?Date.parse(a.nextReviewAt):NaN;
        if(a.status==="waiting_external"&&(!Number.isFinite(next)||next<Date.now()+30*60000||next>Date.now()+7*86400000))throw new Error("Specify the external dependency and a review 30 minutes to seven days ahead.");
        const shift=await db.deskShift.findFirst({where:{id:c.shiftId,bookId:book.id}});
        if(!shift)throw new Error("Shift unavailable.");
        const value={...a,status:String(a.status),runIds,engine:ENGINE_VERSION,proposalRevision:idea.proposalRevision,nextReviewAt:a.status==="waiting_external"?a.nextReviewAt:null,reviewedAt:new Date().toISOString()};
        return journalTransaction(db,book,shift,c.signal,async tx=>{
          const key=`research-disposition:${book.version}:${idea.proposalKey}`;
          const prior=await tx.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key}}});
          const previous=prior?JSON.parse(prior.dataJson):null;
          await tx.deskRecord.upsert({where:{bookId_key:{bookId:book.id,key}},create:{bookId:book.id,shiftId:shift.id,key,kind:"research_disposition",role:"lead",dataJson:JSON.stringify(value)},update:{shiftId:shift.id,dataJson:JSON.stringify(value),createdAt:new Date()}});
          const changed = !previous || previous.status!==value.status || previous.proposalRevision!==value.proposalRevision || previous.engine!==value.engine || JSON.stringify(previous.runIds)!==JSON.stringify(value.runIds);
          await consumeResearchReviews(tx,book,shift,completed.map(r=>r.runId));
          const pending=idea.attempts.some(r=>["queued","running"].includes(r.status));
          if(shift.mode==="research" && changed && !(value.status==="waiting_external"&&pending) && (await tx.deskBook.findUnique({where:{id:book.id},select:{enabled:true}}))?.enabled) {
            const evidence = createHash("sha256").update(JSON.stringify(value.runIds)).digest("hex").slice(0,12);
            await queueWake(tx,book,`research-disposition-review:${book.version}:${idea.proposalKey}:${idea.proposalRevision}:${ENGINE_VERSION}:${a.status}:${evidence}`,"research_disposition","live",{proposalKey:idea.proposalKey,disposition:value,instruction:"Incorporate the completed research disposition into the live proposal board. Close a rejected candidate or update its exact dependency; retain evidence and dissent. This review does not activate a strategy or require a trade."},6);
          }
          return {...value,researchProgress:changed&&completed.length>0};
        });
      }}
  ];
}
