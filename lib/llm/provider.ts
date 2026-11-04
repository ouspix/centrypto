import "server-only";
import OpenAI from "openai";
import { CodexQueueService } from "@/services/CodexQueueService";
import { CodexError, CodexModel } from "@/lib/llm/codex-runner";

export type ModelRequest = {
    model: string;
    purpose: "news" | "trader";
    ownerAddress: string;
    instructions: string;
    input: string;
    schema: object;
    signal?: AbortSignal;
};
export type ModelResponse = { text: string; provider: "codex" | "openrouter" | "ollama"; model: string; jobId?: string };
export function resolveProvider(model: string, hasOpenRouter: boolean): ModelResponse["provider"] {
    if (model.startsWith("codex:")) return "codex";
    return hasOpenRouter && (model.includes("/") || model.startsWith("gpt") || model.startsWith("anthropic")) ? "openrouter" : "ollama";
}

function codexModel(request: ModelRequest): CodexModel {
    const model = request.model.slice("codex:".length) as CodexModel;
    if (!request.model.startsWith("codex:") || (request.purpose === "news" && model !== "gpt-6-luna") || (request.purpose === "trader" && model !== "gpt-6.1-sol")) throw new CodexError("model_unavailable");
    return model;
}

// News prepares a durable request before claiming its remote evidence. Trading
// submits the same request interface and waits for its validated response.
export async function prepareModelRequest(request: ModelRequest, metadata: object) {
    const model = codexModel(request);
    return new CodexQueueService().enqueue(request.ownerAddress, request.purpose, { model, instructions: request.instructions, input: request.input, schema: request.schema }, metadata, true);
}

export async function generateModelResponse(request: ModelRequest, options: { openRouter?: OpenAI | null; ollamaUrl?: string } = {}): Promise<ModelResponse> {
    const provider = resolveProvider(request.model, !!options.openRouter);
    if (provider === "codex") {
        const model = codexModel(request);
        const result = await new CodexQueueService().submit(request.ownerAddress, request.purpose, { model, instructions: request.instructions, input: request.input, schema: request.schema }, request.signal);
        return { text: result.text, provider, model, jobId: result.jobId };
    }
    if (provider === "openrouter") {
        let model = request.model;
        const reasoning = model.endsWith(":reasoning") || /r1|reasoner/.test(model);
        model = model.replace(/:reasoning$/, "");
        const result = await options.openRouter!.chat.completions.create({
            model,
            messages: [{ role: "system", content: request.instructions }, { role: "user", content: request.input }],
            temperature: reasoning ? 0.6 : 0.3, top_p: 0.9, max_tokens: 8000,
            ...(reasoning ? { extra_body: { include_reasoning: true } } : {})
        }, { signal: request.signal });
        if (result.choices[0]?.finish_reason === "length") throw new Error("Model output exceeded its token limit");
        return { text: result.choices[0]?.message.content ?? "", provider, model };
    }
    const response = await fetch(`${options.ollamaUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434"}/api/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: request.signal,
        body: JSON.stringify({ model: request.model, system: request.instructions, prompt: request.input, stream: true, options: { temperature: 0.3, top_p: 0.9, num_ctx: 15000 } })
    });
    if (!response.ok) throw new Error(`Ollama API Error: ${response.status}`);
    if (!response.body?.getReader) {
        const result = await response.json();
        return { text: typeof result.response === "string" ? result.response : JSON.stringify(result), provider, model: request.model };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const consume = (line: string) => { if (line.trim()) { const value = JSON.parse(line); if (value.error) throw new Error("Ollama generation failed"); text += value.response ?? ""; } };
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index: number;
            while ((index = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
            if (text.length + buffer.length > 2_000_000) throw new Error("Model output is too large");
        }
        consume(buffer + decoder.decode());
    } finally { reader.releaseLock(); }
    return { text, provider, model: request.model };
}
