// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { beginTokenMeter, deskModel, readBookUsage, readUsageSnapshot, usageDayWindow } from "@/lib/desk/token-usage";
import { codexDeskTransport, verifyDeskRuntime, deskProbeCoolingDown } from "@/lib/desk/runtime";

let db: PrismaClient, directory: string;
vi.mock("@/lib/db", () => ({
    get prisma() {
        return db;
    },
}));
const counts = (n: number) => ({
    totalTokens: 100 * n,
    inputTokens: 80 * n,
    cachedInputTokens: 50 * n,
    cacheWriteInputTokens: 2 * n,
    outputTokens: 20 * n,
    reasoningOutputTokens: 10 * n,
});
beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "centrypto-usage-test-"));
    db = new PrismaClient({ datasources: { db: { url: "file:" + path.join(directory, "fixture.db") } } });
    for (const migration of ["20261102000000_desk_books", "20261103000000_desk_token_usage"]) {
        const sql = await readFile(path.join("prisma/migrations", migration, "migration.sql"), "utf8");
        for (const stmt of sql
            .split("-- SQLite arbitrates")[0]
            .split(";")
            .filter((s) => s.trim()))
            await db.$executeRawUnsafe(stmt);
    }
});
afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$disconnect();
    await rm(directory, { force: true, recursive: true });
});

describe("desk token accounting", () => {
    it("uses the day of turn start, including both Paris DST transitions", () => {
        expect(usageDayWindow("2026-03-29")).toMatchObject({
            start: new Date("2026-03-28T23:00Z"),
            end: new Date("2026-03-29T22:00Z"),
        });
        expect(usageDayWindow("2026-10-25")).toMatchObject({
            start: new Date("2026-10-24T22:00Z"),
            end: new Date("2026-10-25T23:00Z"),
        });
        expect(usageDayWindow(null, new Date("2026-11-02T23:00Z")).day).toBe("2026-11-03");
        expect(() => usageDayWindow("2026-11-31")).toThrow();
        expect(readUsageSnapshot({ totalTokens: 0 })).toBeNull();
    });
    it("counts cumulative totals once across repeats, failed calls, crashes and charged retries; keeps different books separate", async () => {
        const start = { model: deskModel, role: "lead", kind: "role" as const, bookId: "A", shiftId: "shared-shift" };
        const first = await beginTokenMeter({ ...start, threadId: "first" }, db, new Date("2026-11-02T22:59:59.999Z"));
        await Promise.all([
            first.snapshot("turn-a", counts(1)),
            first.snapshot("turn-a", counts(3)),
            first.snapshot("turn-a", counts(3)),
            first.snapshot("turn-a", counts(1)),
        ]);
        await first.snapshot("wrong-turn", counts(8));
        await first.finish("completed", "turn-a");
        const failed = await beginTokenMeter(
            { ...start, kind: "consult", threadId: "failed" },
            db,
            new Date("2026-11-02T23:00Z"),
        );
        await failed.snapshot("turn-b", counts(2));
        await failed.finish("failed", "turn-b");
        const interrupted = await beginTokenMeter(
            { ...start, kind: "public-read", threadId: "crash" },
            db,
            new Date("2026-11-02T23:10Z"),
        );
        await interrupted.snapshot("turn-c", counts(1));
        // Simulate a process that does not execute finally after an abrupt shutdown.
        await beginTokenMeter({ ...start, kind: "probe", threadId: "missing" }, db, new Date("2026-11-02T23:11Z"));
        const retry = await beginTokenMeter(
            { ...start, kind: "public-search", threadId: "retry" },
            db,
            new Date("2026-11-02T23:12Z"),
        );
        await retry.snapshot("turn-retry", counts(1));
        await retry.finish("completed");
        const other = await beginTokenMeter({ ...start, bookId: "B", threadId: "other" }, db);
        await other.snapshot("turn-other", counts(100));
        const result = await readBookUsage("A", "2026-11-03", db);
        expect(result.period).toMatchObject({
            attempts: 4,
            reported: 3,
            missing: 1,
            unfinished: 2,
            failed: 1,
            counts: { totalTokens: "400", outputTokens: "80", reasoningOutputTokens: "40" },
        });
        expect(result.allTime).toMatchObject({
            attempts: 5,
            counts: { totalTokens: "700", inputTokens: "560", cachedInputTokens: "350", cacheWriteInputTokens: "14" },
        });
        expect(result.period.byKind).toContainEqual({ kind: "public-search", attempts: 1, totalTokens: "100" });
        const before = await readBookUsage("A", "2026-11-02", db);
        expect(before.period.counts.totalTokens).toBe("300");
    });
    it.skipIf(process.platform === "win32")(
        "records the pinned notification wire format before completion and on a failed turn",
        async () => {
            const bin = path.join(directory, "codex-fixture");
            const script = `#!/usr/bin/env node
const readline=require("node:readline"),crypto=require("node:crypto");
if(process.argv.includes("--version")){console.log("codex-cli 0.166.0");process.exit(0);}
const write=x=>console.log(JSON.stringify(x)),threadId=crypto.randomUUID(),turnId=crypto.randomUUID();
readline.createInterface({input:process.stdin}).on("line",line=>{
 const {id,method,params}=JSON.parse(line),res=result=>write({id,result}),event=(method,p)=>write({method,params:{threadId,turnId,...p}});
 if(method==="initialize")res({});if(method==="config/read")res({config:{}});
 if(method==="thread/start")res({thread:{id:threadId},model:"gpt-6.1-sol",modelProvider:"openai"});
 if(method==="turn/start"){
  res({turn:{id:turnId}});event("turn/started",{turn:{id:turnId}});
  const count=${counts.toString()};
  for(const n of [1,3,3])event("thread/tokenUsage/updated",{tokenUsage:{total:count(n),last:count(1)}});
  const failed=params.input[0].text==="fail";
  event("item/completed",{item:{type:"agentMessage",text:"done",phase:"final_answer"}});
  event("turn/completed",{turn:{id:turnId,status:failed?"failed":"completed",error:failed?{message:"fixture failure"}:null}});
 }
});`;
            await writeFile(bin, script, { mode: 0o700 });
            vi.stubEnv("CODEX_CLI_PATH", bin);
            const turn = {
                role: "lead" as const,
                shiftId: "s",
                meter: { kind: "role" as const, bookId: "protocol" },
                input: "ok",
                instructions: "Fixture",
                schema: {},
                tools: [],
            };
            expect(await codexDeskTransport(turn)).toBe("done");
            await expect(
                codexDeskTransport({ ...turn, input: "fail", meter: { kind: "consult", bookId: "protocol" } }),
            ).rejects.toThrow("fixture failure");
            expect((await readBookUsage("protocol", null, db)).allTime).toMatchObject({
                attempts: 2,
                reported: 2,
                failed: 1,
                unfinished: 0,
                counts: { totalTokens: "600" },
            });
            await expect(verifyDeskRuntime(undefined, "probe-fixture")).rejects.toThrow();
            expect(deskProbeCoolingDown()).toBe(true);
            await expect(verifyDeskRuntime(undefined, "probe-fixture")).rejects.toThrow("cooling down");
            const probe = (await readBookUsage("probe-fixture", null, db)).allTime;
            expect(probe.byKind).toEqual([{kind:"probe",attempts:1,totalTokens:"300"}]);
        },
    );
});
