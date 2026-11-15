import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { queueWake } from "../books";
import { researchHealthProcess } from "./process";

export const RESEARCH_HEALTH_KEY = "research-runtime-health";
export const isResearchInfrastructureError = (message: string) =>
    /Transform failed|Unexpected.*(?:\\x00|NUL)|source changed since submission|subprocess unavailable|subprocess returned no result/i.test(message);

/** Recovery is an observation and a read-only review, never a book activation. */
export async function publishResearchHealth(db: PrismaClient, value: {
    status: "ready" | "blocked"; sourceHashes?: Record<string,string>; error?: string;
}) {
    const fingerprint=value.sourceHashes?createHash("sha256").update(JSON.stringify(value.sourceHashes)).digest("hex"):null;
    const health={...value,fingerprint,verifiedAt:new Date().toISOString(),scope:"Fresh-process engine import; market availability and individual experiment coverage remain separate."};
    const books=await db.deskBook.findMany();
    for(const book of books)await db.$transaction(async tx=>{
        const prior=await tx.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key:RESEARCH_HEALTH_KEY}}});
        const previous=prior?JSON.parse(prior.dataJson):null;
        await tx.deskRecord.upsert({where:{bookId_key:{bookId:book.id,key:RESEARCH_HEALTH_KEY}},
            create:{bookId:book.id,key:RESEARCH_HEALTH_KEY,kind:"research_health",role:"host",dataJson:JSON.stringify(health)},
            update:{dataJson:JSON.stringify(health),createdAt:new Date()}});
        if(!book.enabled||value.status!=="ready"||previous?.status==="ready"&&previous.fingerprint===fingerprint)return;
        const failed=await tx.deskResearchRun.findMany({where:{bookId:book.id,bookVersion:book.version,status:"failed"},orderBy:{createdAt:"desc"},take:30});
        if(!failed.length)return;
        const lineage=await tx.deskResearchRun.findMany({where:{bookId:book.id,bookVersion:book.version},select:{id:true,status:true,manifestJson:true,requestJson:true,createdAt:true}});
        const parents=new Map(lineage.map(r=>[r.id,JSON.parse(r.manifestJson).retryOf as string|undefined]));
        const recovered=new Set<string>();
        for(const row of lineage.filter(r=>["queued","running","completed"].includes(r.status))){
            const seen=new Set<string>();let parent=parents.get(row.id);
            while(parent&&!seen.has(parent)){seen.add(parent);recovered.add(parent);parent=parents.get(parent);}
        }
        // A fresh submission may have recovered the identical frozen request
        // without a retryOf link. Only later, exact specifications supersede it.
        const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
        const specification=(json:string)=>JSON.stringify(canonical(JSON.parse(json).request));
        const completed=lineage.filter(r=>r.status==="completed").map(r=>({at:r.createdAt.getTime(),key:specification(r.requestJson)}));
        const runIds=failed.filter(r=>isResearchInfrastructureError(r.error??"")&&!recovered.has(r.id)&&!completed.some(c=>c.at>=r.createdAt.getTime()&&c.key===specification(r.requestJson))).map(r=>r.id);
        if(!runIds.length)return;
        await queueWake(tx,book,`research-runtime-ready:${book.version}:${fingerprint}`,"research_runtime_ready","research",{
            runIds,health:{status:health.status,fingerprint,verifiedAt:health.verifiedAt},
            instruction:"Engine import is now verified in a fresh subprocess. The previous compile/worker blocker is obsolete. Read research_backlog; use retry_backtest for still-relevant failed ideas to preserve their exact saved dates, parameters and costs. Existing retries are reused. Review completed results and resolve or revise the parked dependencies. No account, depth, broad screen or new candle request is needed merely to recover an existing experiment. Do not retune exposed holdouts or extend expired entries. This is read-only research; no strategy activation or order is authorized by this notice."
        },6);
    });
    return health;
}
export async function verifyResearchRuntime(db:PrismaClient,signal:AbortSignal){
    try{return await publishResearchHealth(db,{status:"ready",sourceHashes:await researchHealthProcess(signal)});}
    catch(error){
        if(signal.aborted)throw error;
        return publishResearchHealth(db,{status:"blocked",error:error instanceof Error?error.message:"Runtime probe failed"});
    }
}
