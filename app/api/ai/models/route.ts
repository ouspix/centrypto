import { NextResponse } from 'next/server';

export async function GET() {
    const models = [];

    // 1. Try fetching from Ollama
    try {
        const ollamaUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
        const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) }); // Short timeout

        if (response.ok) {
            const data = await response.json();
            if (data.models) {
                models.push(...data.models);
            }
        }
    } catch (e) {
        // Ollama might be down, just ignore
        console.warn("Ollama unreachable, skipping local models.");
    }

    // 2. Add OpenRouter models if configured
    if (process.env.OPENROUTER_API_KEY) {
        const openRouterModel = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v3.2-exp";
        models.push({ name: openRouterModel });
        models.push({ name: "deepseek/deepseek-chat" });
        models.push({ name: "anthropic/claude-3-opus" });
        models.push({ name: "anthropic/claude-3-sonnet" });
    }

    return NextResponse.json({ models });
}
