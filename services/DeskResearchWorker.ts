import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { queueWake, record } from "@/lib/desk/books";
import { researchProcess } from "@/lib/desk/backtest/process";
import { isResearchInfrastructureError, publishResearchHealth } from "@/lib/desk/backtest/recovery";
export class DeskResearchWorker {
  runtimeError: string | null = null;
  constructor(
    private db: PrismaClient = prisma,
    private run = researchProcess,
  ) {}
  async tick(signal: AbortSignal) {
    const expired = await this.db.deskResearchRun.findMany({
      where: { status: "running", leaseUntil: { lt: new Date() } },
      take: 20,
    });
    for (const old of expired)
      await this.db.$transaction(async (tx) => {
        const changed = await tx.deskResearchRun.updateMany({
          where: {
            id: old.id,
            status: "running",
            leaseUntil: { lt: new Date() },
          },
          data: {
            status: "failed",
            error: "Research worker lease expired; submit a new run to retry.",
            finishedAt: new Date(),
            lease: null,
            leaseUntil: null,
          },
        });
        if (changed.count) {
          const book = await tx.deskBook.findUnique({
            where: { id: old.bookId },
          });
          if (book)
            await queueWake(
              tx,
              book,
              "research:" + old.id,
              "research_failed",
              "research",
              { runId: old.id, error: "Research worker lease expired." },
              6,
            );
        }
      });
    const job = await this.db.deskResearchRun.findFirst({
      where: { status: "queued", cancelRequested: false },
      orderBy: { createdAt: "asc" },
    });
    if (!job || signal.aborted) return false;
    const lease = randomUUID(),
      claim = await this.db.deskResearchRun.updateMany({
        where: { id: job.id, status: "queued", cancelRequested: false },
        data: {
          status: "running",
          lease,
          leaseUntil: new Date(Date.now() + 180000),
          startedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
    if (!claim.count) return false;
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.db.deskResearchRun
        .findUnique({ where: { id: job.id } })
        .then(async (row) => {
          if (!row || row.lease !== lease || row.cancelRequested)
            controller.abort();
          else
            await this.db.deskResearchRun.updateMany({
              where: { id: job.id, lease, status: "running" },
              data: { leaseUntil: new Date(Date.now() + 180000) },
            });
        })
        .catch(() => controller.abort())
        .finally(() => {
          checking = false;
        });
    }, 1000);
    try {
      const result = await this.run(
        JSON.parse(job.requestJson),
        controller.signal,
      );
      await this.db.$transaction(async (tx) => {
        const done = await tx.deskResearchRun.updateMany({
          where: {
            id: job.id,
            lease,
            status: "running",
            cancelRequested: false,
          },
          data: {
            status: "completed",
            ...result,
            finishedAt: new Date(),
            lease: null,
            leaseUntil: null,
          },
        });
        if (!done.count) return;
        const book = await tx.deskBook.findUnique({
          where: { id: job.bookId },
        });
        if (book) {
          await record(
            tx,
            book.id,
            null,
            "research:" + job.id,
            "research_result",
            "research",
            { runId: job.id, ...result },
          );
          await queueWake(
            tx,
            book,
            "research:" + job.id,
            "research_complete",
            "research",
            { runId: job.id, bookVersion: job.bookVersion },
            6,
          );
        }
      });
      await this.db.$transaction(async (tx) => {
        const changed = await tx.deskResearchRun.updateMany({
          where: {
            id: job.id,
            lease,
            status: "running",
            cancelRequested: true,
          },
          data: {
            status: "cancelled",
            finishedAt: new Date(),
            lease: null,
            leaseUntil: null,
          },
        });
        if (changed.count) {
          const book = await tx.deskBook.findUnique({
            where: { id: job.bookId },
          });
          if (book)
            await queueWake(
              tx,
              book,
              "research:" + job.id,
              "research_cancelled",
              "research",
              { runId: job.id },
              6,
            );
        }
      });
    } catch (e) {
      const message=e instanceof Error?e.message:"Research failed.";
      if(isResearchInfrastructureError(message)){
        this.runtimeError=message;
        await publishResearchHealth(this.db,{status:"blocked",error:message});
      }
      const current = await this.db.deskResearchRun.findUnique({
        where: { id: job.id },
      });
      await this.db.$transaction(async (tx) => {
        const changed = await tx.deskResearchRun.updateMany({
          where: { id: job.id, lease, status: "running" },
          data: {
            status: current?.cancelRequested ? "cancelled" : "failed",
            error:
              e instanceof Error ? e.message.slice(0, 500) : "Research failed.",
            finishedAt: new Date(),
            lease: null,
            leaseUntil: null,
          },
        });
        if (changed.count) {
          const book = await tx.deskBook.findUnique({
            where: { id: job.bookId },
          });
          if (book)
            await queueWake(
              tx,
              book,
              "research:" + job.id,
              current?.cancelRequested
                ? "research_cancelled"
                : "research_failed",
              "research",
              {
                runId: job.id,
                error:
                  e instanceof Error
                    ? e.message.slice(0, 500)
                    : "Research failed.",
              },
              6,
            );
        }
      });
    } finally {
      clearInterval(timer);
      signal.removeEventListener("abort", abort);
    }
    return true;
  }
}
