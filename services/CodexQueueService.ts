import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { CODEX_MODELS, CodexError, CodexInput, inspectCodex, runCodex } from "@/lib/llm/codex-runner";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class CodexQueueService {
    readonly workerId = crypto.randomUUID();

    async enqueue(ownerAddress: string, purpose: "news" | "trader", input: CodexInput, metadata: object = {}, preparing = false) {
        return prisma.codexJob.create({ data: { ownerAddress: ownerAddress.toLowerCase(), purpose, model: input.model, payloadJson: JSON.stringify({ instructions: input.instructions, input: input.input }), schemaJson: JSON.stringify(input.schema), metadataJson: JSON.stringify(metadata), priority: purpose === "trader" ? 100 : 0, status: preparing ? "preparing" : "pending" } });
    }

    async availability() {
        const runtime = await prisma.codexRuntime.findUnique({ where: { id: "local" } });
        const fresh = !!runtime?.heartbeatAt && runtime.heartbeatAt.getTime() > Date.now() - 30_000;
        const models: Record<string, { available: boolean; error?: string }> = JSON.parse(runtime?.modelsJson ?? "{}");
        return { available: fresh, cliVersion: runtime?.cliVersion ?? null, models, backoffUntil: runtime?.backoffUntil ?? null };
    }

    async submit(ownerAddress: string, purpose: "news" | "trader", input: CodexInput, signal?: AbortSignal): Promise<{ text: string; jobId: string }> {
        const health = await this.availability();
        if (!health.available || !health.models[input.model]?.available) throw new CodexError("unavailable");
        if (health.backoffUntil && health.backoffUntil > new Date()) throw new CodexError("quota");
        const job = await this.enqueue(ownerAddress, purpose, input);
        const started = Date.now();
        while (Date.now() - started < 210_000) {
            if (signal?.aborted) { await this.cancel(job.id); throw new CodexError("cancelled"); }
            const current = await prisma.codexJob.findUniqueOrThrow({ where: { id: job.id } });
            if (current.status === "completed" && current.resultJson) return { text: current.resultJson, jobId: current.id };
            if (["failed", "cancelled"].includes(current.status)) throw new CodexError((current.errorCode as CodexError["code"]) || "failed");
            await pause(300);
        }
        await this.cancel(job.id);
        throw new CodexError("timeout");
    }

    async cancel(id: string) {
        await prisma.codexJob.updateMany({ where: { id, status: "pending" }, data: { status: "cancelled", errorCode: "cancelled", finishedAt: new Date() } });
        await prisma.codexJob.updateMany({ where: { id, status: "running" }, data: { cancelRequested: true } });
    }

    async checkModels(probe = true) {
        await prisma.codexRuntime.upsert({ where: { id: "local" }, create: { id: "local" }, update: {} });
        const claimed = await prisma.codexRuntime.updateMany({ where: { id: "local", OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseOwner: this.workerId, leaseUntil: new Date(Date.now() + 190000) } });
        if (!claimed.count) { const health = await this.availability(); return { cliVersion: health.cliVersion, models: health.models }; }
        try {
        let cliVersion = "unavailable";
        const models: Record<string, { available: boolean; error?: string }> = {};
        try {
            const status = await inspectCodex();
            cliVersion = status.version;
            for (const model of CODEX_MODELS) {
                try {
                    if (!status.authenticated) throw new CodexError("authentication");
                    if (probe) await runCodex({ model, instructions: "Return the JSON object {ok:true}; no tools.", input: "Check structured output compatibility only.", schema: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false } });
                    models[model] = { available: true };
                } catch (error) { models[model] = { available: false, error: error instanceof CodexError ? error.code : "unavailable" }; }
            }
        } catch { for (const model of CODEX_MODELS) models[model] = { available: false, error: "unavailable" }; }
        await prisma.codexRuntime.upsert({ where: { id: "local" }, create: { id: "local", cliVersion, modelsJson: JSON.stringify(models) }, update: { cliVersion, modelsJson: JSON.stringify(models) } });
        return { cliVersion, models };
        } finally { await prisma.codexRuntime.updateMany({ where: { id: "local", leaseOwner: this.workerId }, data: { leaseOwner: null, leaseUntil: null } }); }
    }

    async heartbeat() {
        await prisma.codexRuntime.upsert({ where: { id: "local" }, create: { id: "local", heartbeatAt: new Date() }, update: { heartbeatAt: new Date() } });
    }

    async runOne(signal?: AbortSignal): Promise<boolean> {
        if (signal?.aborted) return false;
        await this.heartbeat();
        const now = new Date();
        const lease = await prisma.codexRuntime.updateMany({ where: { id: "local", AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, { OR: [{ backoffUntil: null }, { backoffUntil: { lte: now } }] }] }, data: { leaseOwner: this.workerId, leaseUntil: new Date(Date.now() + 110_000) } });
        if (!lease.count) return false;
        let jobId: string | null = null;
        try {
            await prisma.codexJob.updateMany({ where: { status: "running", startedAt: { lt: new Date(Date.now() - 110_000) } }, data: { status: "failed", errorCode: "timeout", finishedAt: now } });
            const job = await prisma.codexJob.findFirst({ where: { status: "pending", cancelRequested: false, notBefore: { lte: now } }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] });
            if (!job) return false;
            jobId = job.id;
            const claimed = await prisma.codexJob.updateMany({ where: { id: job.id, status: "pending" }, data: { status: "running", startedAt: now, attempts: { increment: 1 } } });
            if (!claimed.count) return false;
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal?.addEventListener("abort", abort, { once: true });
            let polling = false;
            const timer = setInterval(() => {
                if (polling) return;
                polling = true;
                void prisma.codexJob.findUnique({ where: { id: job.id } }).then(current => { if (current?.cancelRequested) controller.abort(); }).catch(() => {}).finally(() => { polling = false; });
            }, 500);
            try {
                const payload = JSON.parse(job.payloadJson);
                const result = await runCodex({ model: job.model as CodexInput["model"], ...payload, schema: JSON.parse(job.schemaJson) }, { signal: controller.signal });
                await prisma.codexJob.update({ where: { id: job.id }, data: { status: "completed", resultJson: result.text, usageJson: JSON.stringify(result.usage), payloadJson: "{}", finishedAt: new Date() } });
            } finally { clearInterval(timer); signal?.removeEventListener("abort", abort); }
            return true;
        } catch (error) {
            const code = error instanceof CodexError ? error.code : "failed";
            if (jobId) await prisma.codexJob.update({ where: { id: jobId }, data: { status: code === "cancelled" ? "cancelled" : "failed", errorCode: code, payloadJson: "{}", finishedAt: new Date() } });
            if (code === "quota") await prisma.codexRuntime.update({ where: { id: "local" }, data: { backoffUntil: new Date(Date.now() + 5 * 60_000) } });
            if (["authentication", "model_unavailable", "unavailable"].includes(code) && jobId) {
                const failed = await prisma.codexJob.findUnique({ where: { id: jobId }, select: { model: true } });
                const health = await this.availability();
                if (failed) health.models[failed.model] = { available: false, error: code };
                await prisma.codexRuntime.update({ where: { id: "local" }, data: { modelsJson: JSON.stringify(health.models) } });
            }
            return true;
        } finally {
            await prisma.codexRuntime.updateMany({ where: { id: "local", leaseOwner: this.workerId }, data: { leaseOwner: null, leaseUntil: null } });
        }
    }
}
