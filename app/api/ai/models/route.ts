import { NextResponse } from 'next/server';
import { CodexQueueService } from '@/services/CodexQueueService';

export const dynamic = 'force-dynamic';

export async function GET() {
    const models = [];

    // 1. Try fetching from Ollama
    try {
        const ollamaUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
        const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) }); // Short timeout

        if (response.ok) {
            const data = await response.json();
            if (data.models) {
                models.push(...data.models.map((model: object) => ({ ...model, provider: 'ollama', available: true })));
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
        models.push({ name: "deepseek/deepseek-v3.2-exp:reasoning" });
        models.push({ name: "deepseek/deepseek-r1" });
        models.push({ name: "deepseek/deepseek-chat" });
        models.push({ name: "deepseek/deepseek-v4-flash" });
        models.push({ name: "deepseek/deepseek-v4-pro" });
        models.push({ name: "moonshotai/kimi-k2.6" });
        models.push({ name: "anthropic/claude-3-opus" });
        models.push({ name: "anthropic/claude-3-sonnet" });
    }

    try {
        const health = await new CodexQueueService().availability();
        const unavailableReason = !health.available ? 'worker_unavailable' : health.models['gpt-6.1-sol']?.error || (health.backoffUntil && health.backoffUntil > new Date() ? 'quota' : null);
        models.push({ name: 'codex:gpt-6.1-sol', provider: 'codex', modelId: 'gpt-6.1-sol', available: health.available && !!health.models['gpt-6.1-sol']?.available && (!health.backoffUntil || health.backoffUntil <= new Date()), unavailableReason, reasoningEfforts: ['medium'] });
    } catch {
        models.push({ name: 'codex:gpt-6.1-sol', provider: 'codex', modelId: 'gpt-6.1-sol', available: false, reasoningEfforts: ['medium'] });
    }
    return NextResponse.json({ models: models.map(model => ({ provider: 'openrouter', available: true, ...model })) }, { headers: { 'Cache-Control': 'no-store' } });
}
