import { NextResponse } from 'next/server';
import { OrchestratorService } from '@/services/OrchestratorService';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const {
            userAddress, // Optional
            autoTrading = false,
            model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v3.2-exp", // Default to OpenRouter model if available
            isTestnet = true,
            screeningConfig, // Legacy
            configOverride // New full config
        } = body;

        // Get singleton instance
        const orchestrator = OrchestratorService.getInstance();

        // Call Orchestrator
        // Prioritize configOverride (from ConfigEditor) over screeningConfig (from old UI)
        const finalConfig = configOverride || screeningConfig;

        const result = await orchestrator.analyzeMarket(
            userAddress,
            autoTrading,
            model,
            isTestnet,
            finalConfig
        );

        return NextResponse.json(result);

    } catch (error) {
        // Handle abort errors gracefully
        if (error instanceof Error && error.name === 'AbortError') {
            console.log('✅ Request successfully cancelled');
            return NextResponse.json({
                error: 'Request cancelled',
                details: 'Analysis was cancelled by user'
            }, { status: 499 }); // 499 Client Closed Request
        }

        console.error('AI Analyze Error:', error);
        return NextResponse.json({
            error: 'Analysis failed',
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
