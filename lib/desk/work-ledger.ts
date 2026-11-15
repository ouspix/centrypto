import { requestWatch } from "./routine-work";
import type { DeskBook, DeskShift, PrismaClient } from "@prisma/client";
import type { DeskTool } from "./runtime";
import { deskRoles, type DeskRole } from "./roles";
import type { TradeProposal } from "./proposals";
import { journalTransaction } from "./journal";
import { fingerprint, watchOutcome, watchView, watchRevision, watchAudit, withdrawWatchWakes, resolveReviewSubjects, watchCondition } from "./watch-state";

type Store=Pick<PrismaClient,"deskRecord"|"deskWatch"|"deskResearchRun"|"deskWake"|"deskShift">;
type State="attention"|"waiting"|"observing"|"closed";
export type DeskWorkItem={id:string;kind:string;mode:string;owner:string;state:State;title:string;updatedAt:string;fingerprint:string;
    nextAction:string;issues:string[];proposalKey?:string;instrumentIds?:string[];watchIds?:string[];details:unknown;
    lastReviewedAt?:string;reviewAt?:string|null;reviewDecision?:string};
const json=(s:string|null)=>JSON.parse(s??"{}");
const terminal=(s:string)=>["completed","closed","cancelled","superseded","elapsed","triggered","rejected"].includes(s);

/** The ledger is a lossless projection of durable source records, plus explicit
 * review receipts. It never copies an execution state into a second authority. */
export async function deskWorkSnapshot(db:Store,book:DeskBook,now=Date.now()) {
    const [records,watches,runs,wakes,shifts]=await Promise.all([
        db.deskRecord.findMany({where:{bookId:book.id,kind:{in:["trade_proposal","desk_task","work_review","research_reviewed","research_disposition","prospective_study","entry_comparison"]}},orderBy:{id:"asc"}}),
        db.deskWatch.findMany({where:{bookId:book.id},orderBy:{id:"asc"}}),
        db.deskResearchRun.findMany({where:{bookId:book.id},orderBy:{createdAt:"asc"}}),
        db.deskWake.findMany({where:{bookId:book.id,kind:{in:["watch","follow_up","research_complete","research_disposition","prospective_complete"]}},select:{id:true,key:true,shiftId:true,expiresAt:true,payload:true,mode:true}}),
        db.deskShift.findMany({where:{bookId:book.id},select:{id:true,status:true,version:true}}),
    ]);
    const items:DeskWorkItem[]=[],views=watches.map(watchView),watchById=new Map(views.map(w=>[w.id,w]));
    const reviews=new Map(records.filter(r=>r.kind==="work_review").map(r=>{const x=json(r.dataJson);return [x.itemId,x];}));
    const reviewedRuns=new Set(records.filter(r=>r.kind==="research_reviewed").map(r=>json(r.dataJson).runId));
    for(const row of records.filter(r=>r.kind==="research_disposition")){const d=json(row.dataJson);if(["rejected","evidence_ready"].includes(d.status))for(const id of d.runIds??[])reviewedRuns.add(id);}
    const shiftState=new Map(shifts.map(s=>[s.id,s.status])),shiftVersions=new Map(shifts.map(s=>[s.id,s.version]));
    const proposalRows=records.filter(r=>r.kind==="trade_proposal"),proposals=proposalRows.map(r=>({row:r,p:json(r.dataJson) as TradeProposal}));
    const add=(item:Omit<DeskWorkItem,"fingerprint">,source:unknown)=>{
        const hash=fingerprint(source),review=reviews.get(item.id);
        const out:DeskWorkItem={...item,fingerprint:hash};
        if(review){out.lastReviewedAt=review.reviewedAt;out.reviewDecision=review.decision;}
        if(review?.sourceFingerprint===hash && review.action==="retire"){out.state="closed";out.nextAction="Explicitly retired with retained evidence; source remains inspectable.";}
        if(review?.sourceFingerprint===hash && item.state!=="closed" && review.action!=="retire"){
            const monitored=(review.watchIds??[]).some((id:string)=>{const w=watchById.get(id);return w?.status==="open"&&!w.observational&&+new Date(w.deadline)>now;});
            const later=review.reviewAt&&Date.parse(review.reviewAt)>now;
            out.reviewAt=review.reviewAt;
            // Hard lifecycle failures remain visible even after an acknowledgment.
            if(item.state==="attention"&&!item.issues.some(x=>["expired_entry","old_book_version","failed_research","missed_callback","linked_proposal_closed"].includes(x))&&(monitored||later))out.state="waiting";
        }
        items.push(out);
    };
    for(const {row,p} of proposals){
        const [,version,mode]=row.key.split(":"),tasks=p.researchPlan??[];
        const linked=views.filter(w=>w.mode===mode&&w.proposalKeys.includes(p.key)&&w.status==="open"&&!w.observational);
        const attempts=runs.filter(r=>json(r.requestJson).request?.proposalKey===p.key&&r.bookVersion===Number(version));
        const pending=attempts.some(r=>["queued","running"].includes(r.status));
        const unresolved=tasks.filter(t=>!["resolved","abandoned"].includes(t.status));
        const researchAfterClosure=p.status==="closed"&&unresolved.some(t=>t.status==="ready"&&["backtest_strategy","start_prospective_test"].includes(t.nextTool));
        const closed=p.status==="closed"&&!researchAfterClosure;
        const issues:string[]=[];
        if(!closed&&Number(version)!==book.version)issues.push("old_book_version");
        if(!closed&&!researchAfterClosure&&Date.parse(p.validUntil)<=now)issues.push("expired_entry");
        if(!closed&&!pending&&unresolved.some(t=>["ready","review"].includes(t.status)))issues.push("ready_research");
        if(!closed&&!pending&&!linked.length&&(!unresolved.length||unresolved.some(t=>t.status==="waiting_external")))issues.push("unmonitored_dependency");
        const state:State=closed?"closed":issues.length?"attention":"waiting";
        add({id:row.key,kind:"proposal",mode,owner:"lead",state,title:p.thesis,updatedAt:p.updatedAt??row.createdAt.toISOString(),
            nextAction:closed?"Archived decision; use a new assessment for a distinct opportunity.":issues.includes("expired_entry")?"Close the expired entry or document a genuinely new assessment; preserve unfinished research.":pending?"Await the existing research completion; do not poll.":"Advance ready questions or bind each external dependency to an existing watch/task; explicitly close exhausted ideas.",
            issues,proposalKey:p.key,instrumentIds:p.legs.map(l=>l.instrumentId),watchIds:linked.map(w=>w.id),details:{proposal:p,attempts:attempts.map(r=>({id:r.id,status:r.status})),linkedWatches:linked}},[p,attempts.map(r=>[r.id,r.status]),linked.map(w=>[w.id,w.revision])]);
    }
    for(const run of runs){
        const saved=json(run.requestJson),request=saved.request??{},mode=saved.context?.mode??"research";
        const retried=runs.some(r=>json(r.manifestJson).retryOf===run.id);
        const reviewed=reviewedRuns.has(run.id),pending=["queued","running"].includes(run.status);
        const old=run.bookVersion!==book.version;
        const closed=reviewed||retried||run.status==="cancelled"||old&&terminal(run.status);
        add({id:`run:${run.id}`,kind:"research",mode,owner:"lead",state:closed?"closed":pending?"waiting":"attention",
            title:request.hypothesis??run.id,updatedAt:(run.finishedAt??run.createdAt).toISOString(),proposalKey:request.proposalKey,instrumentIds:request.instrumentIds,
            nextAction:pending?"Completion owns the review; do not poll or duplicate the run.":reviewed?"Result incorporated; preserve evidence.":"Review the result or exact failure and resolve its linked idea; a failure is not negative economics.",
            issues:run.status==="failed"&&!retried?["failed_research"]:[],details:{runId:run.id,status:run.status,reviewed,retried,error:run.error,resultArtifactId:run.resultArtifactId}},[run.status,run.resultArtifactId,run.error,reviewed,retried]);
    }
    for(let i=0;i<watches.length;i++){
        const w=watches[i],view=views[i],out=watchOutcome(w);
        const wake=wakes.find(x=>[`watch:${w.id}`,`technical:${w.id}`,`depth-recovery:${w.id}`].includes(x.key));
        const reviewed=!!wake?.shiftId&&shiftState.get(wake.shiftId)==="completed";
        const callbackLost=!!wake&&!reviewed&&(!wake.shiftId&&!!wake.expiresAt&&+wake.expiresAt<=now||!!wake.shiftId&&["expired","superseded","failed"].includes(shiftState.get(wake.shiftId)??""));
        const version=out.ledger?.version??(w.key.startsWith("routine:")?Number(w.key.split(":")[2]):shiftVersions.get(w.key.split(":")[0]));
        const obsolete=Number.isFinite(version)&&version!==book.version&&w.status!=="open";
        const retired=obsolete||!!out.retired||["cancelled","superseded"].includes(w.status);
        const missedReview=!retired&&w.kind==="review"&&+w.deadline<=now&&!reviewed&&!wake;
        const linkedClosed=!out.ledger?.keepAfterClosure&&view.proposalKeys.length>0&&view.proposalKeys.every(key=>proposals.some(p=>p.p.key===key&&p.row.key.includes(`:${w.mode}:`)&&p.p.status==="closed"));
        const issues=[...(!retired&&(callbackLost||missedReview)?["missed_callback"]:[]),...(linkedClosed&&w.status==="open"&&!view.observational?["linked_proposal_closed"]:[])];
        const state:State=obsolete?"closed":issues.length?"attention":w.status!=="open"?"closed":view.observational?"observing":"waiting";
        add({id:`watch:${w.id}`,kind:"watch",mode:w.mode,owner:view.owner,state,title:w.thesis,updatedAt:w.createdAt.toISOString(),issues,
            nextAction:obsolete?"Historical reminder belongs to a superseded book version; retained for inspection, never current entry authority.":issues.length?"Resolve this missed/obsolete obligation explicitly; inspect every retained subject. Never revive expired entry permission.":view.observational?"Host records the pass outcome; no model review needed.":"Host monitors this condition; update or cancel by ID if the thesis changes.",
            watchIds:[w.id],instrumentIds:w.instrumentId?[w.instrumentId]:[],details:{...view,bookVersion:version,obsolete}},[version,view.revision,reviewed,callbackLost,missedReview,linkedClosed]);
    }
    for(const row of records.filter(r=>["desk_task","prospective_study","entry_comparison"].includes(r.kind))){
        const t=json(row.dataJson),study=row.kind!=="desk_task",mode=study?"research":t.mode;
        const completion=study?wakes.find(w=>w.key===`prospective-complete:${t.id}`):null;
        const studied=!!completion?.shiftId&&shiftState.get(completion.shiftId)==="completed";
        const closed=study?t.status==="completed"&&studied:terminal(t.status),pending=study&&["observing","queued"].includes(t.status);
        const healthyMonitor=study||((t.watchIds??[]).some((id:string)=>{const w=watchById.get(id);return w?.status==="open"&&!w.observational;}));
        const waiting=!closed&&(pending||t.status==="waiting"&&(healthyMonitor||Date.parse(t.reviewAt)>now));
        add({id:row.key,kind:study?"study":"task",mode:mode??"research",owner:t.owner??"lead",state:closed?"closed":t.lastError?"attention":waiting?"waiting":"attention",
            title:t.title??t.hypothesis??t.request?.hypothesis??t.id??row.key,updatedAt:t.updatedAt??row.createdAt.toISOString(),issues:t.lastError?["observation_error"]:[],
            nextAction:study?pending?"Host observes or admits FIFO; completion owns the review. Do not poll.":"Review the frozen study result and resolve its idea.":t.nextAction,
            instrumentIds:t.instrument?[t.instrument.id]:t.instrumentIds,proposalKey:t.comparison?.proposalKey??t.proposalKey,watchIds:t.watchIds??[],details:t},study?[t.status,t.lastError,t.result,t.comparison?.baselineResult,studied]:t);
    }
    // Oldest unreviewed actionable items rotate forward; acknowledgments never delete work.
    const rank={attention:0,waiting:1,observing:2,closed:3};
    const stale=(i:DeskWorkItem)=>i.issues.includes("old_book_version")||i.kind==="watch"&&Date.parse(i.updatedAt)<now-7*86400000?1:0;
    items.sort((a,b)=>rank[a.state]-rank[b.state]||stale(a)-stale(b)||Date.parse(a.lastReviewedAt??a.updatedAt)-Date.parse(b.lastReviewedAt??b.updatedAt)||a.id.localeCompare(b.id));
    return {at:new Date(now).toISOString(),items,watches:views,counts:items.reduce((n,i)=>(n[i.state]=(n[i.state]??0)+1,n),{} as Record<string,number>)};
}
export function workPage(snapshot:Awaited<ReturnType<typeof deskWorkSnapshot>>,args:Record<string,unknown>={}) {
    const limit=Math.min(50,Math.max(1,Number(args.limit)||20));
    const rows=snapshot.items.filter(i=>(!args.mode||args.mode==="all"||i.mode===args.mode)&&(!args.owner||i.owner===args.owner)&&
        (!args.state?Array.isArray(args.ids)||i.state!=="closed"&&i.state!=="observing":args.state==="all"||i.state===args.state)&&
        (!args.kind||i.kind===args.kind)&&(!args.instrumentId||i.instrumentIds?.includes(String(args.instrumentId)))&&
        (!Array.isArray(args.ids)||args.ids.includes(i.id)));
    const revision=fingerprint(rows.map(i=>[i.id,i.fingerprint,i.lastReviewedAt,i.state]));
    let offset=0;
    if(args.cursor){const cursor=JSON.parse(Buffer.from(String(args.cursor),"base64url").toString());if(cursor.revision!==revision)throw new Error("Work ledger changed; restart pagination. No rows were skipped.");offset=cursor.offset;if(!Number.isInteger(offset)||offset<0)throw new Error("Invalid work cursor");}
    const selected=rows.slice(offset,offset+limit);
    const page=args.details===true||Array.isArray(args.ids)?selected:selected.map(({details,...i})=>({...i,...(i.kind==="watch"?{watchRevision:(details as any).revision,threshold:(details as any).threshold,deadline:(details as any).deadline,condition:(details as any).condition}:{} )}));
    return {at:snapshot.at,total:rows.length,pageSize:limit,requestedLimit:args.limit??20,counts:rows.reduce((n,i)=>(n[i.state]=(n[i.state]??0)+1,n),{} as Record<string,number>),bookCounts:snapshot.counts,items:page,nextCursor:offset+limit<rows.length?Buffer.from(JSON.stringify({revision,offset:offset+limit})).toString("base64url"):null,
        note:"All obligations remain in canonical storage. Use filters/pagination to see the rest; waiting and observations do not require repeated data fetching."};
}
export async function workBrief(db:Store,book:DeskBook,mode:string) {
    const all=await deskWorkSnapshot(db,book),page=workPage(all,{mode,state:"attention",limit:12});
    const attention=all.items.filter(i=>i.mode===mode&&i.state==="attention");
    return {...page,attentionByKind:attention.reduce((n,i)=>(n[i.kind]=(n[i.kind]??0)+1,n),{} as Record<string,number>),items:(page.items as DeskWorkItem[]).map(({details,...i})=>i),otherModeCounts:all.items.filter(i=>i.mode!==mode).reduce((n,i)=>(n[i.state]=(n[i.state]??0)+1,n),{} as Record<string,number>),
        instructions:"This is the current mode's attention queue, already read for this review. Use these IDs, fingerprints and next actions; do not reread it just to confirm counts or an empty queue. Waiting jobs and healthy monitors remain in canonical storage and bookCounts; they need no polling. Read exact IDs only when missing details/revisions are needed for an action, or paginate to advance a bounded backlog batch. Lead owns general housekeeping; specialists handle assigned or directly relevant work. Preserve concrete commitments with existing task/proposal tools."};
}
const str={type:"string"},arr={type:"array",maxItems:30,items:str};
export function workLedgerTools(db:PrismaClient,book:DeskBook,shift:DeskShift):DeskTool[] {
    return [
        {name:"read_desk_work",access:"read",description:"Read the complete persistent work ledger: every saved proposal including expired unresolved drafts, tasks, research jobs, studies and watches with IDs/owners/thresholds/links. Local database only, no market or account fetch. Pages contain at most 50 rows; larger requested limits are capped explicitly with pageSize and nextCursor. Follow nextCursor to retrieve the rest. state=all includes archived and observational records. A waiting job/watch needs no polling.",inputSchema:{type:"object",additionalProperties:false,properties:{mode:{enum:["live","research","all"]},state:{enum:["attention","waiting","observing","closed","all"]},owner:{enum:deskRoles},kind:{enum:["proposal","research","watch","study","task"]},instrumentId:str,ids:arr,cursor:str,details:{type:"boolean"},limit:{type:"integer",minimum:1,description:"Requested page size; capped at 50. Follow nextCursor for remaining rows."}}},run:async a=>workPage(await deskWorkSnapshot(db,book),a)},
        {name:"review_desk_work",access:"journal",description:"Review unresolved work only, using its current fingerprint. Source updates/closures already audit themselves: do not append a redundant review after update_trade_proposal or manage_watch. Structured recorded=false responses make no changes; follow their nextAction. action=retire archives a finished research attempt with explanation while preserving the underlying result and proposal obligations. Obsolete book-version drafts without pending research can also be retired with their history preserved. This never closes the underlying proposal/job/watch. Unresolved work needs a concrete next action and either an existing actionable watch or a review deadline (within 7 days). New source evidence makes it due again. Only the owner or lead can review; research cannot modify live work.",inputSchema:{type:"object",additionalProperties:false,required:["itemId","fingerprint","decision","nextAction","evidenceIds","watchIds","reviewAt"],properties:{itemId:str,fingerprint:str,action:{enum:["record","retire"],description:"Retire a finished research attempt or obsolete-version draft without pending research. Preserve evidence; current proposals use update_trade_proposal."},decision:{type:"string",minLength:20,maxLength:1800},nextAction:{type:"string",minLength:10,maxLength:1200},evidenceIds:arr,watchIds:arr,reviewAt:{type:["string","null"]}}},run:async(a,c)=>journalTransaction(db,book,shift,c.signal,async tx=>{
            if(!(await tx.deskBook.updateMany({where:{id:book.id,version:book.version},data:{updatedAt:new Date()}})).count)throw new Error("Book changed; work write revoked.");
            const snapshot=await deskWorkSnapshot(tx,book),item=snapshot.items.find(i=>i.id===a.itemId);
            if(!item)throw new Error("Work not found.");
            if(c.role!=="lead"&&c.role!==item.owner||shift.mode!==item.mode)throw new Error("Work outside this role/mode authority.");
            // Lifecycle operations already commit their own audit. A stale acknowledgment
            // must neither reopen a finished source nor overwrite a newer assessment.
            if(item.state==="closed")return {status:"already_resolved",itemId:item.id,fingerprint:item.fingerprint,recorded:false,nextAction:"Source lifecycle already audited; no additional review receipt needed."};
            if(item.fingerprint!==a.fingerprint)return {status:"source_changed",recorded:false,current:item,nextAction:"Assess this current source before submitting a new review; do not reuse the old fingerprint."};
            if(a.action==="retire"){
                const oldProposal=item.kind==="proposal"&&item.issues.includes("old_book_version");
                if(!oldProposal&&(item.kind!=="research"||["queued","running"].includes((item.details as any).status)))throw new Error("Resolve the source instead; retire only finished research or obsolete book-version drafts.");
                if(oldProposal){
                    const detail=item.details as any;
                    if(detail.attempts.some((r:any)=>["queued","running"].includes(r.status)))throw new Error("Old draft still owns pending research; preserve its obligation.");
                    const row=await tx.deskRecord.findUniqueOrThrow({where:{bookId_key:{bookId:book.id,key:item.id}}});
                    const p=json(row.dataJson),updated={...p,status:"closed",revision:p.revision+1,updatedAt:new Date().toISOString(),updatedBy:c.role,researchPlan:(p.researchPlan??[]).map((t:any)=>["resolved","abandoned"].includes(t.status)?t:{...t,status:"abandoned",result:String(a.decision)})};
                    await tx.deskRecord.update({where:{id:row.id},data:{dataJson:JSON.stringify(updated)}});
                    await tx.deskRecord.create({data:{bookId:book.id,shiftId:shift.id,key:`${item.id}:revision:${updated.revision}`,kind:"proposal_revision",role:c.role,dataJson:JSON.stringify(updated)}});
                }
            }
            const watchIds=Array.isArray(a.watchIds)?a.watchIds.map(String):[];
            if(watchIds.some(id=>!snapshot.watches.some(w=>w.id===id&&w.mode===item.mode&&w.status==="open"&&!w.observational)))return {status:"invalid_follow_up",recorded:false,current:item,watches:snapshot.watches.filter(w=>watchIds.includes(w.id)),nextAction:"Observation-only passes cannot wake this task. Choose a genuine price/technical/review condition, or leave work in attention. Do not claim a monitor was registered."};
            const next=typeof a.reviewAt==="string"?Date.parse(a.reviewAt):NaN;
            if(a.reviewAt!==null&&(!Number.isFinite(next)||next<=Date.now()||next>Date.now()+7*86400000))throw new Error("Review deadline must be in the next seven days.");
            if(a.action!=="retire"&&item.state==="attention"&&!watchIds.length&&!Number.isFinite(next))return {status:"source_action_required",recorded:false,current:item,nextAction:item.kind==="proposal"?"Use update_trade_proposal with status=closed to close this source (lead only), preserving useful unfinished research. Its revision is the audit; do not submit another review receipt.":"Resolve the source, or supply a genuine follow-up condition. This receipt does not close work."};
            let reminder:null|Awaited<ReturnType<typeof requestWatch>>=null;
            if(a.action!=="retire"&&Number.isFinite(next)){
                reminder=await requestWatch(tx,book,shift,item.owner as DeskRole,{kind:"review",thesis:String(a.nextAction),deadline:new Date(next),subjectKey:item.id});
                if(!reminder.watchId)throw new Error("This routine callback cannot schedule itself again. Bind a fresh external condition or leave the item ready for the regular desk review.");
            }
            await resolveReviewSubjects(tx,book,shift,{subjectId:item.id,exceptWatchId:reminder?.watchId??undefined,reason:String(a.decision)});
            const value={reminder,itemId:item.id,sourceFingerprint:item.fingerprint,action:a.action??"record",decision:a.decision,nextAction:a.nextAction,evidenceIds:a.evidenceIds,watchIds,reviewAt:a.reviewAt,reviewedAt:new Date().toISOString()};
            const key=`work-review:${fingerprint(item.id)}`;
            await tx.deskRecord.upsert({where:{bookId_key:{bookId:book.id,key}},create:{bookId:book.id,shiftId:shift.id,key,kind:"work_review",role:c.role,dataJson:JSON.stringify(value)},update:{shiftId:shift.id,role:c.role,dataJson:JSON.stringify(value),createdAt:new Date()}});
            await tx.deskRecord.create({data:{bookId:book.id,shiftId:shift.id,key:`work-review-audit:${shift.id}:${c.callId}`,kind:"work_review_audit",role:c.role,dataJson:JSON.stringify(value)}});
            return value;
        })},
        {name:"save_desk_task",access:"journal",description:"Persist an obligation outside a trade proposal: stable key, owner, next action and completion evidence. Update expectedRevision; waiting requires an actionable watch or future review date. Research cannot alter live tasks. Only lead assigns another owner or closes another owner's work. This creates no orders.",inputSchema:{type:"object",additionalProperties:false,required:["key","expectedRevision","owner","status","title","nextAction","reason","evidenceIds","watchIds","reviewAt"],properties:{key:{type:"string",pattern:"^[a-z0-9][a-z0-9_-]{0,79}$"},expectedRevision:{type:"integer",minimum:0},owner:{enum:deskRoles},status:{enum:["open","waiting","completed","cancelled"]},title:{type:"string",minLength:10,maxLength:1200},nextAction:{type:"string",minLength:10,maxLength:1200},reason:{type:"string",minLength:20,maxLength:1800},evidenceIds:arr,watchIds:arr,reviewAt:{type:["string","null"]},proposalKey:str,instrumentIds:arr}},run:async(a,c)=>journalTransaction(db,book,shift,c.signal,async tx=>{
            if(!(await tx.deskBook.updateMany({where:{id:book.id,version:book.version},data:{updatedAt:new Date()}})).count)throw new Error("Book changed; work write revoked.");
            const key=`desk-task:${shift.mode}:${a.key}`,prior=await tx.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key}}}),old=prior?json(prior.dataJson):null;
            if((old?.revision??0)!==a.expectedRevision)throw new Error("Task revision changed; read_desk_work first.");
            if(c.role!=="lead"&&(a.owner!==c.role||old&&old.owner!==c.role))throw new Error("Only lead can reassign another role's task.");
            const watchIds=Array.isArray(a.watchIds)?a.watchIds.map(String):[];
            const watches=watchIds.length?await tx.deskWatch.findMany({where:{bookId:book.id,mode:shift.mode,id:{in:watchIds},status:"open"}}):[];
            if(watchIds.length!==watches.length||watches.some(w=>watchView(w).observational))throw new Error("Task watches must be open actionable monitors in this mode.");
            const next=typeof a.reviewAt==="string"?Date.parse(a.reviewAt):NaN;
            if(a.reviewAt!==null&&(!Number.isFinite(next)||next<=Date.now()||next>Date.now()+7*86400000))throw new Error("Review date must be within seven days.");
            if(a.status==="waiting"&&!watches.length&&!Number.isFinite(next))throw new Error("Waiting task requires a watch or review date.");
            let reminder:null|Awaited<ReturnType<typeof requestWatch>>=null;
            if(!terminal(String(a.status))&&Number.isFinite(next)){
                reminder=await requestWatch(tx,book,shift,a.owner as DeskRole,{kind:"review",thesis:String(a.nextAction),deadline:new Date(next),subjectKey:key});
                if(!reminder.watchId)throw new Error("Do not rearm a routine task without a fresh external condition. Leave it open for the regular desk review.");
            }
            await resolveReviewSubjects(tx,book,shift,{subjectId:key,exceptWatchId:reminder?.watchId??undefined,reason:String(a.reason)});
            const value={...a,reminder,mode:shift.mode,revision:Number(a.expectedRevision)+1,updatedAt:new Date().toISOString(),updatedBy:c.role};
            await tx.deskRecord.upsert({where:{bookId_key:{bookId:book.id,key}},create:{bookId:book.id,shiftId:shift.id,key,kind:"desk_task",role:c.role,dataJson:JSON.stringify(value)},update:{dataJson:JSON.stringify(value),shiftId:shift.id,createdAt:new Date()}});
            await tx.deskRecord.create({data:{bookId:book.id,shiftId:shift.id,key:`${key}:revision:${value.revision}`,kind:"desk_task_revision",role:c.role,dataJson:JSON.stringify(value)}});
            return {itemId:key,...value};
        })},
        {name:"manage_watch",access:"journal",description:"Update, cancel or supersede a watch using its stable ID and revision from read_desk_work. Never touches orders or stops. Owners manage their own; lead may manage this mode. Retain evidence and explain why. For a passed idea, cancellation disables reopening but preserves price-outcome observation. Supersede requires an open replacement ID. Deadlines do not renew entry permission.",inputSchema:{type:"object",additionalProperties:false,required:["watchId","revision","action","reason"],properties:{watchId:str,revision:str,action:{enum:["update","cancel","supersede"]},reason:{type:"string",minLength:20,maxLength:1200},thesis:{type:"string",minLength:1,maxLength:1000},deadline:str,threshold:{type:"number",exclusiveMinimum:0},proposalKey:str,keepAfterClosure:{type:"boolean"},replacementWatchId:str}},run:async(a,c)=>journalTransaction(db,book,shift,c.signal,async tx=>{
            if(!(await tx.deskBook.updateMany({where:{id:book.id,version:book.version},data:{updatedAt:new Date()}})).count)throw new Error("Book changed; work write revoked.");
            const w=await tx.deskWatch.findFirst({where:{id:String(a.watchId),bookId:book.id,mode:shift.mode}});
            if(!w)throw new Error("Watch missing or changed; read_desk_work first.");
            const view=watchView(w);
            if(c.role!=="lead"&&view.owner!==c.role)throw new Error("Only owner or lead can manage this watch.");
            // Closing a proposal can already retire its watches. A repeated
            // cancellation needs no mutation, fresh revision or model retry.
            if(a.action==="cancel"&&(w.status==="cancelled"||(w.kind==="pass"&&watchOutcome(w).monitoringDisabled)))
                return {...view,recorded:false,alreadyRetired:true,instruction:"Cancellation is already satisfied. Reuse this receipt; no additional review or cancellation is needed."};
            if(watchRevision(w)!==a.revision)throw new Error("Watch missing or changed; read_desk_work first.");
            if(!["open","triggered","elapsed"].includes(w.status))throw new Error("Watch is already retired.");
            if(a.action==="supersede"&&(!a.replacementWatchId||a.replacementWatchId===w.id||!await tx.deskWatch.findFirst({where:{id:String(a.replacementWatchId),bookId:book.id,mode:shift.mode,status:"open"}})))throw new Error("Choose an open replacement watch on this mode.");
            const out=watchOutcome(w),data:any={};
            if(a.action==="update"){
                if(w.status!=="open")throw new Error("A finished watch cannot be rearmed by amendment; perform a fresh assessment.");
                if(a.thesis!==undefined)data.thesis=String(a.thesis);
                if(a.threshold!==undefined){if(!["above","below"].includes(w.kind))throw new Error("Only price watches have thresholds.");data.threshold=Number(a.threshold);}
                if(a.deadline!==undefined){const due=new Date(String(a.deadline));if(!Number.isFinite(+due)||+due<=Date.now()||+due>Date.now()+90*86400000)throw new Error("Invalid future watch deadline.");data.deadline=due;}
                if(a.proposalKey!==undefined){
                    const linked=await tx.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key:`proposal:${book.version}:${shift.mode}:${a.proposalKey}`}}});
                    if(!linked)throw new Error("Unknown proposal in this mode.");
                    const p=json(linked.dataJson);
                    if(w.instrumentId&&!p.legs.some((l:any)=>l.instrumentId===w.instrumentId))throw new Error("Watch instrument must belong to its linked proposal.");
                    if(p.status==="closed"&&!(a.keepAfterClosure??out.ledger?.keepAfterClosure))throw new Error("Closed idea needs an explicitly retained fresh-assessment monitor.");
                    out.ledger={...out.ledger,owner:view.owner,version:book.version,subjects:view.subjects,proposalKeys:[...new Set([...view.proposalKeys,String(a.proposalKey)])]};}
                if(a.keepAfterClosure!==undefined){if(!out.ledger)out.ledger={owner:view.owner,version:book.version,subjects:view.subjects,proposalKeys:view.proposalKeys};out.ledger.keepAfterClosure=!!a.keepAfterClosure;}
            }else{
                if(a.action==="supersede"){
                    const replacement=await tx.deskWatch.findUniqueOrThrow({where:{id:String(a.replacementWatchId)}}),ro=watchOutcome(replacement),rv=watchView(replacement);
                    if(c.role!=="lead"&&rv.owner!==c.role)throw new Error("Only lead can transfer obligations to another owner.");
                    const subjects=new Map([...rv.subjects,...view.subjects].map(s=>[s.id,s]));
                    ro.ledger={...ro.ledger,owner:rv.owner,version:book.version,subjects:[...subjects.values()],proposalKeys:[...new Set([...rv.proposalKeys,...view.proposalKeys])],keepAfterClosure:!!(ro.ledger?.keepAfterClosure||out.ledger?.keepAfterClosure)};
                    const replacementData={outcomeJson:JSON.stringify(ro)};
                    if(!(await tx.deskWatch.updateMany({where:{id:replacement.id,status:"open",outcomeJson:replacement.outcomeJson},data:replacementData})).count)throw new Error("Replacement changed; reread watches.");
                    await watchAudit(tx,book.id,shift.id,c.role,"receive_subjects",replacement,replacementData,String(a.reason));
                }
                if(w.kind==="pass"&&w.status==="open")out.monitoringDisabled=true;else data.status=a.action==="cancel"?"cancelled":"superseded";
                out.retired={action:a.action,reason:a.reason,at:new Date().toISOString(),replacementWatchId:a.replacementWatchId??null};
                await withdrawWatchWakes(tx,book.id,w.id);
            }
            data.outcomeJson=JSON.stringify(out);
            if(a.action==="update"){
                const candidates=await tx.deskWatch.findMany({where:{bookId:book.id,mode:shift.mode,status:"open",kind:w.kind,id:{not:w.id}}});
                const collision=candidates.find(other=>watchView(other).owner===view.owner&&!watchOutcome(other).monitoringDisabled&&fingerprint(watchCondition(other))===fingerprint(watchCondition({...w,...data})));
                if(collision)throw new Error(`Condition already monitored by ${collision.id}; retain its subjects and supersede explicitly instead.`);
            }
            if(!(await tx.deskWatch.updateMany({where:{id:w.id,status:w.status,outcomeJson:w.outcomeJson},data})).count)throw new Error("Watch changed while managing it; reread.");
            await watchAudit(tx,book.id,shift.id,c.role,String(a.action),w,data,String(a.reason));
            return watchView({...w,...data});
        })},
    ];
}
