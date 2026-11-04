import { describe, expect, it, vi } from "vitest";
const submit = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/services/CodexQueueService", () => ({ CodexQueueService: vi.fn(() => ({ submit, enqueue })) }));
import { generateModelResponse, prepareModelRequest, resolveProvider } from "@/lib/llm/provider";
describe("explicit inference provider routing", () => {
    it("selects Codex before legacy OpenRouter heuristics", () => {
        expect(resolveProvider("codex:gpt-6.1-sol", true)).toBe("codex");
        expect(resolveProvider("deepseek/deepseek-r1", true)).toBe("openrouter");
        expect(resolveProvider("gpt-saved-legacy-model", true)).toBe("openrouter");
        expect(resolveProvider("llama3", true)).toBe("ollama");
    });
    it("preserves the exact requested Sol model and does not call another provider", async () => {
        submit.mockResolvedValue({ text: '{"decisions":[]}', jobId: "job" });
        const result = await generateModelResponse({ model: "codex:gpt-6.1-sol", purpose: "trader", ownerAddress: "0xabc", instructions: "Contract", input: "Context", schema: {} }, { openRouter: { chat: { completions: { create: vi.fn() } } } as any });
        expect(result).toMatchObject({ provider: "codex", model: "gpt-6.1-sol", jobId: "job" });
        expect(submit.mock.calls[0][2].model).toBe("gpt-6.1-sol");
    });
    it("rejects unsupported Codex selections without a fallback", async () => {
        await expect(generateModelResponse({ model: "codex:other", purpose: "trader", ownerAddress: "0xabc", instructions: "", input: "", schema: {} })).rejects.toMatchObject({ code: "model_unavailable" });
    });
    it("prepares Luna evidence work through the same provider request interface", async () => {
        enqueue.mockResolvedValue({ id: "prepared-job", status: "preparing" });
        const metadata = { universe: ["BTC"], documentIds: ["evidence"] };
        expect(await prepareModelRequest({ model: "codex:gpt-6-luna", purpose: "news", ownerAddress: "0xabc", instructions: "Contract", input: "Evidence", schema: {} }, metadata)).toMatchObject({ id: "prepared-job", status: "preparing" });
        expect(enqueue).toHaveBeenCalledWith("0xabc", "news", { model: "gpt-6-luna", instructions: "Contract", input: "Evidence", schema: {} }, metadata, true);
    });
    it("parses Ollama streaming records split across network chunks", async () => {
        vi.mocked(fetch).mockResolvedValue({ ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"response":"hel')); controller.enqueue(new TextEncoder().encode('lo"}\n{"response":" world","done":true}')); controller.close(); } }) } as Response);
        const result = await generateModelResponse({ model: "local", purpose: "trader", ownerAddress: "0xabc", instructions: "", input: "", schema: {} });
        expect(result.text).toBe("hello world");
    });
});
