import { NextResponse } from 'next/server';
import { OrchestratorService } from '@/services/OrchestratorService';

const orchestrator = new OrchestratorService();

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const {
            userAddress, // Optional
            autoTrading = false,
            model = "deepseek-r1:14b" // Default
        } = body;

        // Call Orchestrator
        const result = await orchestrator.analyzeMarket(userAddress, autoTrading, model);

        return NextResponse.json(result);

    } catch (error) {
        console.error('AI Analyze Error:', error);
        return NextResponse.json({
            error: 'Analysis failed',
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
