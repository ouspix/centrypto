import fs from "fs/promises";
import os from "os";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
const refs = vi.hoisted(() => ({ db: null as any, run: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get(_target, property) { const value = refs.db[property]; return typeof value === "function" ? value.bind(refs.db) : value; } }) }));
vi.mock("@/lib/llm/codex-runner", async original => ({ ...await original<typeof import("@/lib/llm/codex-runner")>(), runCodex: refs.run }));
import { CodexQueueService } from "@/services/CodexQueueService";
import { CodexError } from "@/lib/llm/codex-runner";
let directory: string;
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "centrypto-queue-test-"));
    refs.db = new PrismaClient({ datasources: { db: { url: `file:${path.join(directory, "queue.db")}` } } });
    const schema = await fs.readFile(path.join(process.cwd(), "prisma/migrations/20261031000000_local_intelligence/migration.sql"), "utf8");
    for (const statement of schema.split(";").filter(statement => statement.trim())) await refs.db.$executeRawUnsafe(statement);
    await refs.db.codexRuntime.create({ data: { id: "local", heartbeatAt: new Date(), modelsJson: JSON.stringify({ "gpt-6-luna": { available: true }, "gpt-6.1-sol": { available: true } }) } });
    refs.run.mockReset(); refs.run.mockResolvedValue({ text: '{"ok":true}', usage: {} });
});
afterEach(async () => { await refs.db.$disconnect(); await fs.rm(directory, { recursive: true, force: true }); });
const job = (purpose: "news" | "trader", priority: number) => refs.db.codexJob.create({ data: { ownerAddress: "0xowner", purpose, priority, model: purpose === "news" ? "gpt-6-luna" : "gpt-6.1-sol", payloadJson: JSON.stringify({ input: "evidence", instructions: "data only" }), schemaJson: "{}" } });
describe("durable single-slot Codex queue", () => {
    it("prioritizes waiting trader work over news", async () => {
        const news = await job("news", 0); const trader = await job("trader", 100);
        await new CodexQueueService().runOne();
        expect((await refs.db.codexJob.findUnique({ where: { id: trader.id } })).status).toBe("completed");
        expect((await refs.db.codexJob.findUnique({ where: { id: news.id } })).status).toBe("pending");
        expect(refs.run.mock.calls[0][0].model).toBe("gpt-6.1-sol");
    });
    it("allows only one process to execute a CLI job", async () => {
        let release: (result: object) => void = () => {};
        refs.run.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        await job("news", 0);
        const first = new CodexQueueService().runOne();
        await waitFor(() => expect(refs.run).toHaveBeenCalledTimes(1));
        expect(await new CodexQueueService().runOne()).toBe(false);
        release({ text: '{"ok":true}', usage: {} }); await first;
        expect(refs.run).toHaveBeenCalledTimes(1);
    });
    it("recovers an expired worker lease without repeating an ambiguous running inference", async () => {
        const stale = await job("news", 0);
        await refs.db.codexJob.update({ where: { id: stale.id }, data: { status: "running", startedAt: new Date(Date.now() - 120000) } });
        await refs.db.codexRuntime.update({ where: { id: "local" }, data: { leaseOwner: "dead-worker", leaseUntil: new Date(Date.now() - 1000) } });
        await new CodexQueueService().runOne();
        expect((await refs.db.codexJob.findUnique({ where: { id: stale.id } })).errorCode).toBe("timeout");
        expect(refs.run).not.toHaveBeenCalled();
    });
    it("backs off quota failures while retaining waiting jobs", async () => {
        const first = await job("news", 0);
        refs.run.mockRejectedValueOnce(new CodexError("quota"));
        const queue = new CodexQueueService();
        await queue.runOne();
        expect((await refs.db.codexJob.findUnique({ where: { id: first.id } })).errorCode).toBe("quota");
        expect((await queue.availability()).backoffUntil!.getTime()).toBeGreaterThan(Date.now());
        await job("trader", 100);
        expect(await queue.runOne()).toBe(false);
        expect(refs.run).toHaveBeenCalledTimes(1);
    });
    it("marks an inaccessible requested model unavailable without substitution", async () => {
        await job("trader", 100);
        refs.run.mockRejectedValueOnce(new CodexError("model_unavailable"));
        const queue = new CodexQueueService();
        await queue.runOne();
        expect((await queue.availability()).models["gpt-6.1-sol"]).toEqual({ available: false, error: "model_unavailable" });
        expect(refs.run).toHaveBeenCalledTimes(1);
    });
    it("aborts active inference when a persisted cancellation is requested", async () => {
        refs.run.mockImplementation((_input, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new CodexError("cancelled")))));
        const pending = await job("trader", 100);
        const queue = new CodexQueueService();
        const running = queue.runOne();
        await waitFor(() => expect(refs.run).toHaveBeenCalledOnce());
        await queue.cancel(pending.id);
        await running;
        const cancelled = await refs.db.codexJob.findUnique({ where: { id: pending.id } });
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.payloadJson).toBe("{}");
    });
});
