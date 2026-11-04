import "server-only";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Ajv from "ajv";
import { codexEnvironment } from "@/lib/llm/codex-runner";
import type { DeskRole } from "./roles";
import { beginTokenMeter, deskModel, type UsageKind } from "./token-usage";

export const DESK_CODEX_VERSION = "0.166.0";
const defaultModel = deskModel;
const exec = promisify(execFile);
const schemaValidator = new Ajv({ strict: false, addUsedSchema: false });
type JsonObject = Record<string, unknown>;
export type ToolContext = { role: DeskRole; shiftId: string; callId: string; signal: AbortSignal; bookId?: string };
export type DeskTool = {
    name: string;
    description: string;
    inputSchema: JsonObject;
    access: "read" | "journal" | "lead" | "execution";
    run: (args: JsonObject, context: ToolContext) => Promise<unknown>;
};
export type DeskTurn = {
    meter?: { kind: UsageKind; bookId?: string };
    role: DeskRole;
    shiftId: string;
    instructions: string;
    input: string;
    schema: JsonObject;
    tools: DeskTool[];
    signal?: AbortSignal;
};
export type DeskTransport = (turn: DeskTurn) => Promise<string>;
type RpcMessage = { id?: string | number; method?: string; params?: any; result?: any; error?: { message?: string } };
type Pending = { resolve(value: any): void; reject(error: Error): void };

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: Error) => void;
    const promise = new Promise<T>((ok, fail) => {
        resolve = ok;
        reject = fail;
    });
    // Also handle failure before the asynchronous protocol handshake completes.
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
}

function childEnvironment() {
    const env = codexEnvironment();
    if (process.env.CENTRYPT_DESK_CODEX_HOME) env.CODEX_HOME = process.env.CENTRYPT_DESK_CODEX_HOME;
    return env;
}

function binary() {
    return process.env.CODEX_CLI_PATH || "codex";
}

let versionProbe: Promise<void> | undefined;
export function assertDeskProtocolVersion() {
    versionProbe ??= exec(binary(), ["--version"], { env: childEnvironment(), timeout: 10000, maxBuffer: 16384 })
        .then(({ stdout }) => {
            if (stdout.trim() !== `codex-cli ${DESK_CODEX_VERSION}`)
                throw new Error(
                    `Desk requires codex-cli ${DESK_CODEX_VERSION}; dynamic tool protocol has not been verified for this version.`,
                );
        })
        .catch((error) => {
            versionProbe = undefined;
            throw error;
        });
    return versionProbe;
}

const privateField =
    /^(privateKey|apiKey|walletKey|apiWalletAddress|walletAddress|ownerAddress|accountAddress|vaultAddress|subAccountAddress|secret|signature|cookie|authorization|accessToken|refreshToken|credential)$/i;
function redact(text: string) {
    return text
        .replace(/\b0x[a-f\d]{40,}\b/gi, "[private identifier]")
        .replace(/\b(?:sk-[\w-]{16,}|Bearer\s+[\w./+=-]+)\b/gi, "[credential]");
}
export function deskModelJson(value: unknown) {
    return (
        JSON.stringify(value, (key, item: unknown) => {
            if (privateField.test(key)) return undefined;
            if (typeof item === "string") return redact(item);
            return typeof item === "bigint" ? String(item) : item;
        }) ?? "null"
    );
}

function record(value: unknown): value is JsonObject {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function secureCliFlags(web: boolean): string[] {
    const flags = [
        "-c",
        `web_search="${web ? "live" : "disabled"}"`,
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        "mcp_servers={}",
        "-c",
        "analytics.enabled=false",
    ];
    for (const feature of [
        "shell_tool",
        "unified_exec",
        "shell_snapshot",
        "apps",
        "plugins",
        "hooks",
        "multi_agent",
        "workspace_dependencies",
        "browser_use",
        "computer_use",
        "js_repl",
        "view_image",
        "image_generation",
        "memories",
        "code_mode",
        "tool_suggest",
        "apply_patch_freeform",
        "sleep_tool",
        "request_permissions_tool",
    ])
        flags.push("-c", `features.${feature}=false`);
    return flags;
}

class AppServerRpc {
    private seq = 0;
    private closed = false;
    private pending = new Map<number, Pending>();
    private buffer = "";
    constructor(
        private child: ChildProcessWithoutNullStreams,
        private dispatch: (msg: RpcMessage) => Promise<void>,
        private failed: (error: Error) => void,
    ) {
        child.stdout.setEncoding("utf8");
        child.stderr.resume(); // Never echo local config/credentials from stderr into a role journal.
        child.stdout.on("data", (chunk: string) => {
            this.buffer += chunk;
            let end: number;
            try {
                while ((end = this.buffer.indexOf("\n")) >= 0) {
                    if (end > 2_000_000) throw new Error("Oversize Codex protocol frame");
                    const line = this.buffer.slice(0, end).trim();
                    this.buffer = this.buffer.slice(end + 1);
                    if (line) this.receive(JSON.parse(line));
                }
                if (this.buffer.length > 2_000_000) throw new Error("Oversize Codex protocol frame");
            } catch {
                this.fail(new Error("Invalid Codex protocol frame"));
            }
        });
        child.once("error", () => this.fail(new Error("Codex App Server unavailable")));
        child.once("close", () => this.fail(new Error("Codex App Server disconnected")));
        child.stdin.on("error", () => this.fail(new Error("Codex App Server input closed")));
    }
    private receive(msg: RpcMessage) {
        if (this.closed) return;
        if (msg.method) {
            void this.dispatch(msg).catch((error) =>
                this.fail(error instanceof Error ? error : new Error("Codex tool dispatch failed")),
            );
            return;
        }
        if (typeof msg.id !== "number") return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(redact(String(msg.error.message ?? "Codex RPC rejected")).slice(0, 420)));
        else p.resolve(msg.result);
    }
    write(msg: RpcMessage) {
        if (this.closed) throw new Error("Codex App Server closed");
        this.child.stdin.write(JSON.stringify(msg) + "\n");
    }
    request(method: string, params: unknown): Promise<any> {
        const id = ++this.seq;
        const p = deferred<unknown>();
        this.pending.set(id, p);
        this.write({ id, method, params });
        return p.promise;
    }
    fail(error: Error) {
        if (this.closed) return;
        this.closed = true;
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        this.failed(error);
        this.child.stdin.destroy();
        if (this.child.pid && process.platform !== "win32") {
            try {
                process.kill(-this.child.pid, "SIGKILL");
            } catch {
                this.child.kill("SIGKILL");
            }
        } else this.child.kill("SIGKILL");
    }
}

function checkedToolRegistry(tools: DeskTool[]) {
    const registry = new Map<string, { tool: DeskTool; validate: ReturnType<Ajv["compile"]> }>();
    for (const tool of tools) {
        if (!/^[a-zA-Z][\w-]{0,63}$/.test(tool.name) || registry.has(tool.name))
            throw new Error("Invalid or duplicate desk tool name");
        registry.set(tool.name, { tool, validate: schemaValidator.compile(tool.inputSchema) });
    }
    return registry;
}

// Each turn owns a subprocess and an ephemeral workspace. Persistent desk memory is scoped
// by the host, never by a shared Codex conversation or provider session.
async function callAppServer(turn: DeskTurn, web?: { seen: (item: JsonObject) => void }): Promise<string> {
    if (turn.signal?.aborted) throw new Error("Desk turn cancelled");
    if (turn.input.length > 200000) throw new Error("Desk brief exceeds 200000 characters");
    const registry = checkedToolRegistry(turn.tools);
    await assertDeskProtocolVersion();
    const directory = await mkdtemp(path.join(tmpdir(), "centrypto-desk-"));
    const controller = new AbortController();
    let meter: Awaited<ReturnType<typeof beginTokenMeter>> | undefined;
    let status: "completed" | "failed" | "cancelled" = "failed";
    let turnId: string | undefined;
    let rpc: AppServerRpc | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => rpc?.fail(new Error("Desk turn cancelled"));
    try {
        const child = spawn(binary(), ["app-server", "--stdio", ...secureCliFlags(!!web)], {
            cwd: directory,
            env: childEnvironment(),
            detached: process.platform !== "win32",
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const completed = deferred<string>();
        let threadId: string | undefined,
            final = "",
            count = 0;
        const seenCalls = new Set<string>();
        rpc = new AppServerRpc(
            child,
            async (msg) => {
                const p = msg.params ?? {};
                if (msg.id !== undefined) {
                    if (
                        msg.method !== "item/tool/call" ||
                        !threadId ||
                        p.threadId !== threadId ||
                        p.turnId !== turnId ||
                        p.namespace != null ||
                        typeof p.callId !== "string" ||
                        !p.callId ||
                        seenCalls.has(p.callId) ||
                        ++count > 32
                    )
                        throw new Error("Unexpected Codex tool request");
                    const entry = registry.get(p.tool);
                    if (!entry) throw new Error("Unregistered desk capability");
                    seenCalls.add(p.callId);
                    let text: string,
                        success = false;
                    try {
                        if (!record(p.arguments) || !entry.validate(p.arguments))
                            throw new Error("Arguments do not match tool schema");
                        const result = await entry.tool.run(p.arguments, {
                            role: turn.role,
                            shiftId: turn.shiftId,
                            callId: p.callId,
                            signal: controller.signal,
                        });
                        text = deskModelJson(result);
                        if (text.length > 48000)
                            text = JSON.stringify({
                                truncated: true,
                                preview: text.slice(0, 46000),
                                hint: "Narrow the query for additional results.",
                            });
                        success = true;
                    } catch (error) {
                        text = redact(error instanceof Error ? error.message : "Desk tool failed").slice(0, 500);
                    }
                    if (!controller.signal.aborted)
                        rpc!.write({ id: msg.id, result: { contentItems: [{ type: "inputText", text }], success } });
                    return;
                }
                if (!threadId || p.threadId !== threadId) return;
                if (msg.method === "turn/started") {
                    turnId = p.turn?.id;
                    return;
                }
                if (msg.method === "thread/tokenUsage/updated") {
                    if (typeof p.turnId === "string" && (!turnId || p.turnId === turnId)) {
                        await meter?.snapshot(p.turnId, p.tokenUsage?.total);
                    }
                    return;
                }
                if (msg.method === "turn/completed") {
                    if (!turnId || p.turn?.id !== turnId) throw new Error("Wrong desk turn completed");
                    if (p.turn.status !== "completed" || !final)
                        throw new Error(redact(String(p.turn.error?.message ?? "Incomplete Codex turn")).slice(0, 400));
                    completed.resolve(final);
                    return;
                }
                if (msg.method !== "item/started" && msg.method !== "item/completed") return;
                const item = p.item;
                if (!turnId || p.turnId !== turnId) throw new Error("Unexpected desk item scope");
                if (web && item?.type === "webSearch") {
                    if (msg.method === "item/completed") web.seen(item);
                    return;
                }
                if (
                    ![
                        "userMessage",
                        "agentMessage",
                        "reasoning",
                        "dynamicToolCall",
                        "contextCompaction",
                        "plan",
                    ].includes(item?.type)
                )
                    throw new Error(`Unexpected Codex item: ${String(item?.type).slice(0, 60)}`);
                if (item.type === "agentMessage" && msg.method === "item/completed" && item.phase !== "commentary") {
                    if (typeof item.text !== "string" || item.text.length > 64000)
                        throw new Error("Invalid desk response");
                    final = item.text;
                }
            },
            (error) => {
                controller.abort();
                completed.reject(error);
            },
        );
        timer = setTimeout(() => rpc!.fail(new Error("Codex desk turn timed out")), web ? 90000 : 210000);
        turn.signal?.addEventListener("abort", stop, { once: true });
        if (turn.signal?.aborted) stop();
        await rpc.request("initialize", {
            clientInfo: { name: "centrypto_desk", version: "1.0", title: "Centrypto desk" },
            capabilities: { experimentalApi: true, requestAttestation: false },
        });
        rpc.write({ method: "initialized" });
        const effective = await rpc.request("config/read", { cwd: directory });
        if (
            Object.values(effective?.config?.mcp_servers ?? {}).some(
                (server) => record(server) && server.enabled !== false,
            )
        )
            throw new Error(
                "Desk Codex home has active external MCP servers; configure an isolated CENTRYPT_DESK_CODEX_HOME",
            );
        const started = await rpc.request("thread/start", {
            model: defaultModel,
            modelProvider: "openai",
            allowProviderModelFallback: false,
            cwd: directory,
            ephemeral: true,
            sandbox: "read-only",
            approvalPolicy: "never",
            environments: [],
            developerInstructions: turn.instructions,
            dynamicTools: turn.tools.map((t) => ({
                type: "function",
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
                deferLoading: false,
            })),
        });
        if (!started?.thread?.id || started.model !== defaultModel || started.modelProvider !== "openai")
            throw new Error("Codex desk model mismatch");
        threadId = started.thread.id;
        // Register each actual inference attempt before turn/start. A crash leaves a visible,
        // unresolved record. A retry opens a fresh thread and incurs its own usage.
        meter = await beginTokenMeter({
            threadId: started.thread.id,
            bookId: turn.meter?.bookId,
            shiftId: turn.meter?.kind === "probe" ? undefined : turn.shiftId,
            kind: turn.meter?.kind ?? "role",
            role: turn.role,
            model: started.model,
        });
        const response = await rpc.request("turn/start", {
            threadId,
            effort: "medium",
            outputSchema: turn.schema,
            input: [{ type: "text", text: turn.input, text_elements: [] }],
        });
        if (!response?.turn?.id || (turnId && turnId !== response.turn.id)) throw new Error("Codex desk turn mismatch");
        turnId = response.turn.id;
        const result = await completed.promise;
        status = "completed";
        return result;
    } finally {
        if (timer) clearTimeout(timer);
        turn.signal?.removeEventListener("abort", stop);
        rpc?.fail(new Error("Desk turn finished"));
        controller.abort();
        try {
            await meter?.finish(turn.signal?.aborted && status !== "completed" ? "cancelled" : status, turnId);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
}

export const codexDeskTransport: DeskTransport = (turn) => callAppServer(turn);
export const codexPublicTransport = (turn: DeskTurn, seen: (item: JsonObject) => void) =>
    callAppServer({ ...turn, tools: [] }, { seen });

let healthy: Promise<void> | undefined;
let probeRetryAt = 0;
export function deskProbeCoolingDown(now = Date.now()) {
    return now < probeRetryAt;
}
export function verifyDeskRuntime(signal?: AbortSignal, bookId?: string) {
    if (healthy) return healthy;
    if (deskProbeCoolingDown()) return Promise.reject(new Error("Codex capability probe is cooling down"));
    const proof = randomUUID();
    let called = false;
    healthy = codexDeskTransport({
        role: "lead",
        shiftId: "capability-probe",
        meter: { kind: "probe", bookId },
        signal,
        instructions:
            "Call the provided desk_handshake tool once, then return its proof unmodified in the JSON object.",
        input: "Verify local desk tool dispatch.",
        schema: {
            type: "object",
            required: ["proof"],
            additionalProperties: false,
            properties: { proof: { type: "string" } },
        },
        tools: [
            {
                name: "desk_handshake",
                description: "Read the startup challenge response.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
                access: "read",
                run: async () => {
                    called = true;
                    return { proof };
                },
            },
        ],
    })
        .then((raw) => {
            if (!called || JSON.parse(raw).proof !== proof) throw new Error("Codex desk capability probe failed");
        })
        .catch((error) => {
            healthy = undefined;
            if (!signal?.aborted) probeRetryAt = Date.now() + 5 * 60_000;
            throw error;
        });
    return healthy;
}
