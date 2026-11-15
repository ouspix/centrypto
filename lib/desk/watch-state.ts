import { createHash } from "node:crypto";
import type { DeskBook, DeskShift, DeskWatch, Prisma } from "@prisma/client";
import { deskRoles, type DeskRole } from "./roles";

export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type WatchSubject = { id: string; thesis: string; eventKey?: string | null; proposalKey?: string; sourceShiftId?: string; resolvedAt?: string; resolution?: string };
export type WatchLedger = { owner: DeskRole; version: number; proposalKeys: string[]; subjects: WatchSubject[]; keepAfterClosure?: boolean };
export function watchOutcome(w: Pick<DeskWatch,"outcomeJson">): Record<string,any> { return JSON.parse(w.outcomeJson ?? "{}"); }
export function storedWatchOwner(w: Pick<DeskWatch,"key"|"outcomeJson">): DeskRole {
    const owner=watchOutcome(w).ledger?.owner ?? w.key.split(":")[1];
    return deskRoles.includes(owner) ? owner : "lead";
}
/** A condition has an identity independent of the author's prose. Same-time reviews
 * form a delivery envelope; subjects retain each separate obligation. */
export function watchCondition(w: Pick<DeskWatch,"kind"|"instrumentId"|"side"|"threshold"|"deadline"|"outcomeJson">) {
    const out=watchOutcome(w);
    return w.kind==="review" ? ["review",new Date(w.deadline).toISOString()] :
        [w.kind,w.instrumentId??null,w.side??null,w.threshold??null,
            w.kind==="technical"?out.technical??null:null,
            w.kind==="pass"?[new Date(w.deadline).toISOString(),out.revisitWhen??null]:null];
}
export function watchRevision(w: Pick<DeskWatch,"thesis"|"status"|"kind"|"instrumentId"|"side"|"threshold"|"deadline"|"outcomeJson">) {
    // Price observations do not invalidate a management receipt; condition/lifecycle changes do.
    return fingerprint([w.status,w.thesis,watchCondition(w),w.deadline,watchOutcome(w).ledger,watchOutcome(w).monitoringDisabled??false]);
}
export function watchView(w: DeskWatch) {
    const out=watchOutcome(w),ledger=out.ledger as WatchLedger|undefined;
    const observationOnly=w.kind==="pass"&&(!out.revisitWhen||!!out.monitoringDisabled||!!out.depthReopenedAt||!!out.evidenceReopenedAt);
    return {id:w.id,revision:watchRevision(w),owner:storedWatchOwner(w),mode:w.mode,kind:w.kind,status:w.status,
        followUpEligible:w.status==="open"&&!observationOnly&&!out.monitoringDisabled,
        purpose:observationOnly?"outcome_observation_only":"condition_review",
        instrumentId:w.instrumentId,side:w.side,threshold:w.threshold,deadline:w.deadline,thesis:w.thesis,
        eventKey:w.eventKey,proposalKeys:ledger?.proposalKeys??[],subjects:(ledger?.subjects??[{id:w.id,thesis:w.thesis,eventKey:w.eventKey}]).filter(s=>!s.resolvedAt),
        resolvedSubjects:ledger?.subjects.filter(s=>s.resolvedAt)??[],
        condition:out.technical??out.revisitWhen??null,monitoringDisabled:!!out.monitoringDisabled,
        triggeredAt:out.depthReopenedAt??out.evidenceReopenedAt??null,
        observational:w.kind==="pass"&&(!out.revisitWhen||!!out.monitoringDisabled||!!out.depthReopenedAt||!!out.evidenceReopenedAt),
        sourceCreatedAt:w.createdAt};
}
export async function watchAudit(tx:Prisma.TransactionClient,bookId:string,shiftId:string|null,role:string,action:string,before:DeskWatch,after:unknown,reason:string) {
    const key=`watch-audit:${before.id}:${fingerprint([action,before.outcomeJson,before.status,after,reason])}`;
    await tx.deskRecord.upsert({where:{bookId_key:{bookId,key}},update:{},create:{bookId,shiftId,key,kind:"watch_audit",role,
        dataJson:JSON.stringify({action,watchId:before.id,reason,before,after,at:new Date().toISOString()})}});
}
/** Keep archival rows and receipts, but withdraw unclaimed callbacks atomically. */
export async function withdrawWatchWakes(tx:Prisma.TransactionClient,bookId:string,id:string) {
    await tx.deskWake.updateMany({where:{bookId,shiftId:null,key:{in:[`watch:${id}`,`technical:${id}`,`depth-recovery:${id}`]}},data:{expiresAt:new Date(0)}});
}

/** Closing an idea retires its linked entry monitors, while grouped reminders
 * retain unrelated subjects and pass observations retain their original horizon. */
export async function retireProposalWatches(tx:Prisma.TransactionClient,book:DeskBook,shift:DeskShift,proposalKey:string) {
    await resolveReviewSubjects(tx,book,shift,{proposalKey,reason:"Linked proposal closed; preserve unrelated review subjects."});
    const rows=await tx.deskWatch.findMany({where:{bookId:book.id,mode:shift.mode,status:"open"}});
    for(const w of rows){
        const out=watchOutcome(w),ledger=out.ledger as WatchLedger|undefined;
        if(!ledger?.proposalKeys.includes(proposalKey)||ledger.keepAfterClosure||out.monitoringDisabled)continue;
        const keys=ledger.proposalKeys;
        const linked=await tx.deskRecord.findMany({where:{bookId:book.id,key:{in:keys.map(k=>`proposal:${book.version}:${shift.mode}:${k}`)}}});
        if(linked.length!==keys.length||linked.some(r=>JSON.parse(r.dataJson).status!=="closed"))continue;
        if(w.kind==="review"&&ledger.subjects.some(s=>!s.proposalKey||!keys.includes(s.proposalKey)))continue;
        const data={...(w.kind==="pass"?{}:{status:"cancelled"}),outcomeJson:JSON.stringify({...out,monitoringDisabled:true,
            retired:{action:"proposal_closed",proposalKey,at:new Date().toISOString(),reason:"Linked proposal closed; no retained independent reassessment instruction."}})};
        await tx.deskWatch.update({where:{id:w.id},data});
        await withdrawWatchWakes(tx,book.id,w.id);
        await watchAudit(tx,book.id,shift.id,"host","proposal_closed",w,data,"Retired obsolete monitor; historical decision and pass observation preserved.");
    }
}

/** Resolve one obligation without discarding another topic sharing its clock.
 * Already claimed callbacks retain their receipt; agents must inspect current state. */
export async function resolveReviewSubjects(tx:Prisma.TransactionClient,book:DeskBook,shift:DeskShift,match:{subjectId?:string;proposalKey?:string;exceptWatchId?:string;reason:string}) {
    const rows=await tx.deskWatch.findMany({where:{bookId:book.id,mode:shift.mode,kind:"review",status:{in:["open","triggered","elapsed"]}}});
    for(const w of rows){
        if(w.id===match.exceptWatchId)continue;
        const out=watchOutcome(w),ledger=out.ledger as WatchLedger|undefined;
        const matches=(s:WatchSubject)=>!s.resolvedAt&&(!!match.subjectId&&s.id===match.subjectId||!!match.proposalKey&&s.proposalKey===match.proposalKey);
        if(!ledger||!ledger.subjects.some(matches)||match.proposalKey&&ledger.keepAfterClosure)continue;
        ledger.subjects=ledger.subjects.map(s=>matches(s)?{...s,resolvedAt:new Date().toISOString(),resolution:match.reason}:s);
        const active=ledger.subjects.filter(s=>!s.resolvedAt),data={outcomeJson:JSON.stringify(out),...(!active.length?{status:"cancelled"}:{})};
        if(!(await tx.deskWatch.updateMany({where:{id:w.id,status:w.status,outcomeJson:w.outcomeJson},data})).count)throw new Error("Reminder changed; retry resolution.");
        if(!active.length)await withdrawWatchWakes(tx,book.id,w.id);
        else {
            const wake=await tx.deskWake.findUnique({where:{bookId_key:{bookId:book.id,key:`watch:${w.id}`}}});
            if(wake&&!wake.shiftId)await tx.deskWake.updateMany({where:{id:wake.id,shiftId:null,payload:wake.payload},data:{payload:JSON.stringify({...JSON.parse(wake.payload),subjects:active})}});
        }
        await watchAudit(tx,book.id,shift.id,"host","resolve_subject",w,data,match.reason);
    }
}
