import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { DeskBook, DeskResearchRun, PrismaClient } from "@prisma/client";
import { listInstruments } from "../instruments";
import { parseDeskMandate } from "../mandate";
import { ROLE_VERSION } from "../roles";
import { describeRule } from "./rule-definition";
import { assessCandleEvidence } from "./evidence";
import { decodeDeskArtifact } from "../artifacts";
import { ENGINE_VERSION } from "./types";
import { validateResearchRequest } from "./request";

export async function researchSourceHashes() {
  const files = [
    "lib/desk/backtest/engine.ts",
    "lib/desk/backtest/candles.ts",
    "lib/desk/backtest/evidence.ts",
    "lib/desk/rule-signal.ts",
    "lib/desk/entry-filters.ts",
    "lib/desk/backtest/rule-definition.ts",
    "lib/desk/candle-history.ts",
    "lib/desk/read-queue.ts",
    "lib/desk/swing.ts",
    "lib/desk/risk-sizing.ts",
    "lib/desk/backtest/campaign.ts",
    "lib/desk/backtest/gaps.ts",
    "lib/desk/venue-price.ts",
    "lib/desk/backtest/data.ts",
    "lib/desk/backtest/request.ts",
    "lib/desk/backtest/types.ts",
    "lib/desk/execution-risk.ts",
    "lib/desk/roles.ts",
    "lib/desk/execution-types.ts",
    "lib/desk/instruments.ts",
    "lib/desk/mandate.ts",
    "scripts/desk_research_backtest.ts",
    "package-lock.json",
  ];
  return Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [
        f,
        createHash("sha256")
          .update(await readFile(f))
          .digest("hex"),
      ]),
    ),
  );
}

export async function researchManifest(book: DeskBook) {
  let commit: string | null = null,
    dirtyHash: string | null = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    dirtyHash = createHash("sha256")
      .update(
        execFileSync("git", ["diff", "--binary", "HEAD"], {
          maxBuffer: 32 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      )
      .digest("hex");
  } catch {
    /* Source hashes below also cover new files outside the index. */
  }
  const sourceHashes = await researchSourceHashes();
  return {
    engine: ENGINE_VERSION,
    roleVersion: ROLE_VERSION,
    commit,
    dirtyHash,
    sourceHashes,
    createdAt: new Date().toISOString(),
    bookId: book.id,
    bookVersion: book.version,
    network: book.isTestnet ? "testnet" : "mainnet",
    mandate: parseDeskMandate(book.mandateJson),
  };
}
/** Reject invalid definitions and missing draft links before reserving a costly-run slot. */
export async function preflightResearchRequest(db:PrismaClient,book:DeskBook,input:unknown){
  const request=validateResearchRequest(input,book.isTestnet);
  if(request.variants?.some(v=>v.signal==="mean_reversion"&&v.meanReference===undefined))throw new Error("Declare meanReference: prior_sma or lookback_price before submitting a new mean-reversion experiment.");
  if(request.proposalKey){
    const {researchBacklog}=await import("../research-backlog");
    if(!(await researchBacklog(db,book,96)).some(p=>p.proposalKey===request.proposalKey))throw new Error("Link a current backlog proposal key.");
  }
}
export async function enqueueResearch(
  db: PrismaClient,
  book: DeskBook,
  input: unknown,
  retry?: DeskResearchRun,
  originShiftId?: string,
) {
  const request = validateResearchRequest(input, book.isTestnet);
  if(!retry&&request.variants?.some(v=>v.signal==="mean_reversion"&&v.meanReference===undefined))throw new Error("Declare meanReference: prior_sma for a moving-average deviation fade, or lookback_price for a return reversal. Fixed stop/target/time exits do not imply an SMA exit.");
  let datasetReference:{runId:string;artifactId:string;sha256:string}|undefined,reusedInstruments:import("../instruments").DeskInstrument[]|undefined;
  if(request.reuseDatasetRunId){
    const source=await db.deskResearchRun.findFirst({where:{id:request.reuseDatasetRunId,bookId:book.id,bookVersion:book.version,status:"completed"}});
    if(!source?.datasetArtifactId)throw new Error("Completed current-book candle dataset unavailable.");
    const frozen=JSON.parse(source.requestJson),q=frozen.request;
    if(q.engine!=="candles"||Date.parse(q.start)!==Date.parse(request.start)||Date.parse(q.end)!==Date.parse(request.end)||q.intervalSeconds!==request.intervalSeconds||JSON.stringify(q.instrumentIds)!==JSON.stringify(request.instrumentIds))throw new Error("Dataset reuse must preserve dates, resolution and ordered instruments.");
    const artifact=await db.deskArtifact.findFirst({where:{id:source.datasetArtifactId,bookId:book.id}});
    if(!artifact)throw new Error("Saved candle dataset unavailable.");
    decodeDeskArtifact(artifact);
    datasetReference={runId:source.id,artifactId:artifact.id,sha256:artifact.sha256};reusedInstruments=frozen.instruments;
  }
  const all = retry ? JSON.parse(retry.requestJson).instruments : reusedInstruments??await listInstruments(book.isTestnet, request.instrumentIds.every(id=>id.includes(":perp:"))?"perp":"all");
  const instruments = request.instrumentIds.map((id) => {
    const i = (all as import("../instruments").DeskInstrument[]).find((i) => i.id === id);
    if (!i) throw new Error("Instrument unavailable on book network.");
    return i;
  });
  let proposalRevision: number | null = null;
  if(request.proposalKey) {
    const { researchBacklog } = await import("../research-backlog");
    const idea=(await researchBacklog(db,book,96)).find(p=>p.proposalKey===request.proposalKey);
    if(!idea)throw new Error("Link a current backlog proposal key.");
    proposalRevision = idea.proposalRevision;
    if(idea.attempts.some(a=>["queued","running"].includes(a.status)))throw new Error("This idea already has active research; review its completion.");
    if(idea.attempts.filter(a=>a.status === "completed" && a.proposalRevision === proposalRevision && a.engine === ENGINE_VERSION).length>=2)throw new Error("This idea has two completed experiments. Resolve its research disposition and external dependency before creating a materially revised hypothesis in the proposal board.");
  }
  const manifest = await researchManifest(book);
  if (request.variants?.some((v) => v.orderUsd > manifest.mandate.maxOrderUsd))
    throw new Error("Order size exceeds the fixed book mandate.");
  // Serialize per-book queue admission without changing the book version.
  const run = await db.$transaction(async (tx) => {
    const locked = await tx.deskBook.updateMany({
      where: { id: book.id, version: book.version },
      data: { updatedAt: new Date() },
    });
    if (!locked.count)
      throw new Error("Book changed; refresh before submitting research.");
    if(retry){
      const previous=await tx.deskResearchRun.findMany({where:{bookId:book.id,bookVersion:book.version},orderBy:{createdAt:"desc"},take:200});
      const existing=previous.find(r=>JSON.parse(r.manifestJson).retryOf===retry.id);
      if(existing)return existing;
    }
    if(request.proposalKey) {
      const attempts=await tx.deskResearchRun.findMany({where:{bookId:book.id,bookVersion:book.version},orderBy:{createdAt:"desc"},take:100});
      const linked=attempts.filter(a=>{const input=JSON.parse(a.requestJson);return input.request.proposalKey===request.proposalKey && input.context.proposalRevision===proposalRevision;});
      if(linked.some(a=>["queued","running"].includes(a.status)))throw new Error("This idea already has active research; review its completion.");
      if(linked.filter(a=>a.status==="completed" && JSON.parse(a.manifestJson).engine===ENGINE_VERSION).length>=2)throw new Error("This idea has two completed experiments; resolve its disposition first.");
    }
    const pending = await tx.deskResearchRun.count({
      where: { bookId: book.id, status: { in: ["queued", "running"] } },
    });
    if (pending >= 4)
      throw new Error("Four research jobs are already active for this book.");
    const requestJson = JSON.stringify({
      sourceHashes: manifest.sourceHashes,
      ...(datasetReference?{datasetReference}:{}),
      request,
      instruments,
      context: {
        bookId: book.id,
        bookVersion: book.version,
        proposalRevision,
        ...(originShiftId ? { originShiftId } : {}),
        isTestnet: book.isTestnet,
        mandate: manifest.mandate,
      },
    });
    return tx.deskResearchRun.create({
      data: {
        id: randomUUID(),
        bookId: book.id,
        bookVersion: book.version,
        isTestnet: book.isTestnet,
        requestJson,
        manifestJson: JSON.stringify({
          ...manifest,
          ...(datasetReference?{datasetReference}:{}),
          ...(retry?{retryOf:retry.id,originalRequestHash:JSON.parse(retry.manifestJson).requestHash}:{}),
          requestHash: createHash("sha256").update(requestJson).digest("hex"),
        }),
      },
    });
  });
  return {
    status: run.status,
    runId: run.id,
    network: manifest.network,
    bookVersion: book.version,
    note: "Research is queued outside this turn. End this task without polling or scheduling reminders. Completion wakes one read-only review; read backtest_status there. No trading action or policy change is scheduled.",
  };
}
/** Recovery repeats the saved specification and metadata, never model-retuned parameters. */
export async function retryFailedResearch(db:PrismaClient,book:DeskBook,runId:string,originShiftId?:string){
  const failed=await db.deskResearchRun.findFirst({where:{id:runId,bookId:book.id}});
  if(!failed||failed.status!=="failed"||failed.resultArtifactId)throw new Error("Retry a failed run without a completed result only.");
  if(failed.bookVersion!==book.version||failed.isTestnet!==book.isTestnet)throw new Error("The book changed; preserve the old run and define new research under the current mandate.");
  const rows=await db.deskResearchRun.findMany({where:{bookId:book.id,bookVersion:book.version},orderBy:{createdAt:"desc"},take:200});
  let existing=rows.find(r=>JSON.parse(r.manifestJson).retryOf===failed.id);
  if(existing){
    const seen=new Set([failed.id]);
    while(!seen.has(existing.id)){
      seen.add(existing.id);
      const next=rows.find(r=>JSON.parse(r.manifestJson).retryOf===existing!.id&&!seen.has(r.id));
      if(!next)break;existing=next;
    }
    return {status:existing.status,runId:existing.id,retryOf:failed.id,reused:true};
  }
  const result=await enqueueResearch(db,book,JSON.parse(failed.requestJson).request,failed,originShiftId);
  return {...result,retryOf:failed.id,reused:false};
}
export function compactResearchResult(result: any) {
  const compact = (r: any) =>
    r
      ? {
          from: r.from,
          through: r.through,
          metrics: r.metrics,
          dataQuality: r.dataQuality,
          endingPositions: r.endingPositions,
          limitations: r.limitations,
          rejectionSample: r.rejections?.slice(0, 8),
        }
      : null;
  return {
    ...result,
    ...(result.engine==="desk-candle-1"?{ruleDefinitions:result.variants?.filter((v:any)=>v.rule).map((v:any)=>describeRule(v.rule,result.intervalSeconds??null)),storedAssessment:result.assessment,assessment:assessCandleEvidence({coverage:!!result.coverage?.complete,validation:result.variants?.find((v:any)=>v.name===result.selectedVariant)?.validation,holdout:result.holdout,stress:result.stressedHoldout,folds:result.validationFolds?.find((v:any)=>v.name===result.selectedVariant)?.folds})}:{}),
    windows: result.windows?.map((w: any) => ({...w, variants: w.variants.map((v: any) => ({...v, development: compact(v.development), validation: compact(v.validation), validationObservedOnly:compact(v.validationObservedOnly)})), holdout: compact(w.holdout),holdoutObservedOnly:compact(w.holdoutObservedOnly)})),
    variants: result.variants?.map((v: any) => ({
      ...v,
      development: compact(v.development),
      validation: compact(v.validation),
      validationObservedOnly: compact(v.validationObservedOnly),
    })),
    holdout: compact(result.holdout),
    stressedHoldout: compact(result.stressedHoldout),
    holdoutObservedOnly: compact(result.holdoutObservedOnly),
    replay: compact(result.replay),
  };
}
export async function researchStatus(
  db: PrismaClient,
  bookId: string,
  id: string,
  full = false,
) {
  const run = await db.deskResearchRun.findFirst({ where: { id, bookId } });
  if (!run) throw new Error("Research run not found for this book.");
  let result: unknown = null;
  if (run.resultArtifactId) {
    const row = await db.deskArtifact.findFirst({
      where: { id: run.resultArtifactId, bookId },
    });
    if (row) {
      const decoded = decodeDeskArtifact(row);
      result = full ? decoded : compactResearchResult(decoded);
    }
  }
  return {
    runId: run.id,
    status: run.status,
    bookVersion: run.bookVersion,
    network: run.isTestnet ? "testnet" : "mainnet",
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    cancelRequested: run.cancelRequested,
    manifest: JSON.parse(run.manifestJson),
    experiment: { specification: (()=>{const {orders,...spec}=JSON.parse(run.requestJson).request;return {...spec,...(orders?{recordedOrderCount:orders.length}:{})};})(), hypothesis: JSON.parse(run.requestJson).request.hypothesis, proposalKey: JSON.parse(run.requestJson).request.proposalKey ?? null, windowCount: 1 + (JSON.parse(run.requestJson).request.additionalWindows?.length ?? 0) },
    datasetArtifactId: run.datasetArtifactId,
    resultArtifactId: run.resultArtifactId,
    result,
  };
}
export async function cancelResearch(
  db: PrismaClient,
  bookId: string,
  id: string,
) {
  const run = await db.deskResearchRun.findFirst({ where: { id, bookId } });
  if (!run) throw new Error("Research run not found for this book.");
  await db.deskResearchRun.updateMany({
    where: { id, bookId, status: "queued" },
    data: {
      status: "cancelled",
      cancelRequested: true,
      finishedAt: new Date(),
    },
  });
  await db.deskResearchRun.updateMany({
    where: { id, bookId, status: "running" },
    data: { cancelRequested: true },
  });
  return researchStatus(db, bookId, id);
}
