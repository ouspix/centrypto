import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), mkdtemp: vi.fn(), writeFile: vi.fn(), rm: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mocks.spawn, execFile: vi.fn(), default: { spawn: mocks.spawn, execFile: vi.fn() } }));
vi.mock("fs/promises", () => ({ default: { mkdtemp: mocks.mkdtemp, writeFile: mocks.writeFile, rm: mocks.rm } }));
import { codexEnvironment, runCodex } from "@/lib/llm/codex-runner";
const request = { model: "gpt-6-luna" as const, instructions: "Analyze evidence only", input: "Untrusted news", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; kill: ReturnType<typeof vi.fn> };
let mode: "success" | "schema" | "tool" | "wait" | "quota" = "success";
beforeEach(() => {
    vi.clearAllMocks(); mode = "success";
    mocks.mkdtemp.mockResolvedValue("/tmp/centrypto-test"); mocks.writeFile.mockResolvedValue(undefined); mocks.rm.mockResolvedValue(undefined);
    vi.spyOn(process, "kill").mockImplementation(() => { queueMicrotask(() => child.emit("close", null)); return true; });
    mocks.spawn.mockImplementation(() => {
        child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 987654, kill: vi.fn() });
        child.stdin.on("finish", () => {
            if (mode === "wait") return;
            queueMicrotask(() => {
                if (mode === "tool") child.stdout.write(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "forbidden" } }) + "\n");
                else if (mode === "quota") child.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "Usage limit exceeded" } }) + "\n");
                else {
                    const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: mode === "schema" ? '{"ok":"not-a-boolean"}' : '{"ok":true}' } }) + "\n";
                    child.stdout.write(line.slice(0, 25)); child.stdout.write(line.slice(25));
                    child.stdout.write(JSON.stringify({ type: "turn.completed", usage: { output_tokens: 4 } }) + "\n");
                }
                child.emit("close", mode === "quota" ? 1 : 0);
            });
        });
        return child;
    });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("bounded data-only Codex subprocess", () => {
    it("uses argument arrays, stdin, the exact model, schema and isolated permissions", async () => {
        const result = await runCodex(request);
        expect(JSON.parse(result.text)).toEqual({ ok: true });
        const [, args, options] = mocks.spawn.mock.calls[0];
        expect(args).toContain("gpt-6-luna"); expect(args).toContain("--output-schema"); expect(args).toContain("--ephemeral"); expect(args).toContain("features.shell_tool=false");
        expect(options).toMatchObject({ shell: false, cwd: "/tmp/centrypto-test" });
        expect(mocks.rm).toHaveBeenCalledWith("/tmp/centrypto-test", { recursive: true, force: true });
    });
    it("does not inherit application secrets", () => {
        vi.stubEnv("HYPERLIQUID_TESTNET_PRIVATE_KEY", "never-inherit"); vi.stubEnv("DATABASE_URL", "private-db"); vi.stubEnv("OPENROUTER_API_KEY", "private-api");
        expect(codexEnvironment()).not.toHaveProperty("HYPERLIQUID_TESTNET_PRIVATE_KEY");
        expect(codexEnvironment()).not.toHaveProperty("DATABASE_URL"); expect(codexEnvironment()).not.toHaveProperty("OPENROUTER_API_KEY");
        vi.unstubAllEnvs();
    });
    it("rejects output that violates the response schema", async () => {
        mode = "schema"; await expect(runCodex(request)).rejects.toMatchObject({ code: "invalid_output" });
    });
    it("kills unexpected tool execution and never accepts its answer", async () => {
        mode = "tool"; await expect(runCodex(request)).rejects.toMatchObject({ code: "unexpected_tool" }); expect(process.kill).toHaveBeenCalledWith(-987654, "SIGKILL");
    });
    it("reports quota failures without exposing raw server output", async () => {
        mode = "quota"; await expect(runCodex(request)).rejects.toMatchObject({ code: "quota", message: "Codex quota" });
    });
    it("cancels an active process group", async () => {
        mode = "wait"; const controller = new AbortController(); const promise = runCodex(request, { signal: controller.signal });
        const rejected = expect(promise).rejects.toMatchObject({ code: "cancelled" });
        await new Promise(resolve => setTimeout(resolve, 0)); controller.abort(); await rejected;
    });
    it("enforces the 90-second execution ceiling", async () => {
        vi.useFakeTimers(); mode = "wait";
        const rejected = expect(runCodex(request, { timeoutMs: 120000 })).rejects.toMatchObject({ code: "timeout" });
        await vi.advanceTimersByTimeAsync(90_001); await rejected;
    });
});
