import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const ollamaUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
        const response = await fetch(`${ollamaUrl}/api/tags`);

        if (!response.ok) {
            throw new Error('Failed to fetch models from Ollama');
        }

        const data = await response.json();
        return NextResponse.json(data);
    } catch (error) {
        console.error('Models Fetch Error:', error);
        return NextResponse.json({ models: [] }, { status: 500 });
    }
}
