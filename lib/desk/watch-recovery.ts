import type { DeskBook, PrismaClient } from "@prisma/client";
import { watchOwner } from "./routine-work";
import { fingerprint, watchCondition, watchOutcome, watchAudit, withdrawWatchWakes, type WatchLedger, type WatchSubject } from "./watch-state";

/** Idempotent operator/host repair. Preserve rows and subjects; never rewrite
 * trading permissions, entry plans, orders or pass outcome reference prices. */
export async function reconcileDeskWatches(db:PrismaClient,book:DeskBook,dryRun=true) {
    const rows=await db.deskWatch.findMany({where:{bookId:book.id,status:"open"},orderBy:[{createdAt:"asc"},{id:"asc"}]});
    const groups=new Map<string,typeof rows>();
    for(const row of rows){
        const out=watchOutcome(row);if(out.monitoringDisabled)continue;
        const owner=await watchOwner(db,row),version=row.key.startsWith("routine:")?Number(row.key.split(":")[2]):book.version;
        const key=fingerprint([version,row.mode,owner,watchCondition(row)]);
        groups.set(key,[...(groups.get(key)??[]),row]);
    }
    const changes=[];
    for(const group of groups.values()){
        if(group.length<2)continue;
        const [primary,...duplicates]=group;
        const pending=await db.deskWake.count({where:{bookId:book.id,shiftId:null,OR:[{expiresAt:null},{expiresAt:{gt:new Date()}}],key:{in:group.flatMap(w=>[`watch:${w.id}`,`technical:${w.id}`,`depth-recovery:${w.id}`])}}});
        if(pending){changes.push({primary:primary.id,skipped:"Pending callback retained; reconcile after its review."});continue;}
        const subjects=new Map<string,WatchSubject>(),links=new Set<string>();
        for(const w of group){const l=watchOutcome(w).ledger as WatchLedger|undefined;
            for(const x of l?.subjects??[{id:w.id,thesis:w.thesis,eventKey:w.eventKey}])subjects.set(x.id,x);
            for(const key of l?.proposalKeys??[])links.add(key);
        }
        const ledger:WatchLedger={owner:await watchOwner(db,primary),version:primary.key.startsWith("routine:")?Number(primary.key.split(":")[2]):book.version,subjects:[...subjects.values()],proposalKeys:[...links],keepAfterClosure:group.some(w=>watchOutcome(w).ledger?.keepAfterClosure)};
        changes.push({primary:primary.id,duplicateIds:duplicates.map(w=>w.id),kind:primary.kind,mode:primary.mode,subjects:ledger.subjects.length});
        if(dryRun)continue;
        await db.$transaction(async tx=>{
            if(!(await tx.deskBook.updateMany({where:{id:book.id,version:book.version},data:{updatedAt:new Date()}})).count)throw new Error("Book changed; repair revoked");
            const current=await tx.deskWatch.findMany({where:{bookId:book.id,id:{in:group.map(w=>w.id)},status:"open"}});
            if(current.length!==group.length||current.some(w=>w.outcomeJson!==group.find(x=>x.id===w.id)!.outcomeJson))throw new Error("Watches changed during reconciliation; retry from current state.");
            const outcomeJson=JSON.stringify({...watchOutcome(primary),ledger});
            await tx.deskWatch.update({where:{id:primary.id},data:{outcomeJson}});
            await watchAudit(tx,book.id,null,"host","merge",primary,{ledger},"Retained every subject under a stable condition; original reference preserved.");
            for(const w of duplicates){
                const data={...(w.kind==="pass"?{}:{status:"superseded"}),outcomeJson:JSON.stringify({...watchOutcome(w),monitoringDisabled:true,retired:{action:"superseded",replacementWatchId:primary.id,at:new Date().toISOString(),reason:"Duplicate condition; subjects retained on primary."}})};
                await tx.deskWatch.update({where:{id:w.id},data});
                await withdrawWatchWakes(tx,book.id,w.id);
                await watchAudit(tx,book.id,null,"host","supersede",w,data,"Duplicate monitor retired. Pass reference/outcome history retained.");
            }
        });
    }
    return {dryRun,examined:rows.length,changes};
}
