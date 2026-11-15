import type { DeskBook, DeskShift, Prisma, PrismaClient } from "@prisma/client";
import { researchStatus } from "./jobs";

export const observationKey = (version: number, shiftId: string, runId: string) =>
  `research-observation:${version}:${shiftId}:${runId}`;

/** One immutable observation per shift, shared across roles and crash recovery.
 * Newly submitted work belongs to its completion review, never a polling loop. */
export async function agentResearchStatus(db: PrismaClient, book: DeskBook, shiftId: string, runId: string) {
  const key = observationKey(book.version, shiftId, runId);
  const cached = await db.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key}}});
  if (cached) return {...JSON.parse(cached.dataJson), reused:true};
  const run = await db.deskResearchRun.findFirst({where:{id:runId,bookId:book.id}});
  if (!run) throw new Error("Research run not found for this book.");
  const originating = JSON.parse(run.requestJson).context?.originShiftId === shiftId;
  const pending = ["queued", "running"].includes(run.status);
  const value = originating || pending
    ? {runId, status:"awaiting_completion_review", observedStatus:run.status,
        note:"Completion schedules one read-only review. End this research task; do not poll, add a timer, or infer a result. The next shift can read the result."}
    : await researchStatus(db, book.id, runId);
  const saved = await db.deskRecord.upsert({where:{bookId_key:{bookId:book.id,key}},
    create:{bookId:book.id,shiftId,key,kind:"research_observation",role:"research",dataJson:JSON.stringify(value)},update:{}});
  return JSON.parse(saved.dataJson);
}

/** A cited completed result has been assessed by the lead. Consume only that
 * result's pending notification, atomically with the authoritative decision.
 * Worker completion and notification creation are already one transaction. */
export async function consumeResearchReviews(tx: Prisma.TransactionClient, book: DeskBook,
  shift: Pick<DeskShift,"id">, runIds: string[]) {
  if (!runIds.length) return;
  const runs = await tx.deskResearchRun.findMany({where:{bookId:book.id,bookVersion:book.version,
    id:{in:[...new Set(runIds)]},status:"completed",resultArtifactId:{not:null}}});
  for (const run of runs) {
    const observed = await tx.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,
      key:observationKey(book.version,shift.id,run.id)}}});
    const value = observed && JSON.parse(observed.dataJson);
    if (value?.status !== "completed" || value.resultArtifactId !== run.resultArtifactId || !value.result) continue;
    const key = `research-reviewed:${book.version}:${run.id}:${run.resultArtifactId}`;
    await tx.deskRecord.upsert({where:{bookId_key:{bookId:book.id,key}},
      create:{bookId:book.id,shiftId:shift.id,key,kind:"research_reviewed",role:"lead",
        dataJson:JSON.stringify({runId:run.id,resultArtifactId:run.resultArtifactId})},update:{}});
    await tx.deskWake.updateMany({where:{bookId:book.id,version:book.version,kind:"research_complete",
      key:"research:"+run.id,shiftId:null},data:{shiftId:shift.id}});
  }
}
