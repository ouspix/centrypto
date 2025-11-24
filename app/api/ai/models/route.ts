import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const ollamaUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
        const response = await fetch(`${ollamaUrl}/api/tags`);

        if (!response.ok) {
            throw new Error('Failed to fetch models from Ollama');
        }

        const data = await response.json();

        // Add OpenRouter models if configured
        const openRouterModel = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v3.2-exp";
        if (process.env.OPENROUTER_API_KEY) {
            data.models.push({ name: openRouterModel });
            // Add other common OpenRouter models if desired
            data.models.push({ name: "deepseek/deepseek-chat-v3-0324:free" });
        }

        return NextResponse.json(data);
    } catch (error) {
        console.error('Models Fetch Error:', error);
        return NextResponse.json({ models: [] }, { status: 500 });
    }
}
