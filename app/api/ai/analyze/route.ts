import { NextResponse } from 'next/server';
import { OrchestratorService } from '@/services/OrchestratorService';
import { ensureCollectorReady } from '@/services/CollectorRunner';

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

        // Merge configs
        // configOverride comes from ConfigEditor (AgentConfig)
        // screeningConfig comes from ScreeningParameters (ScreenerConfig)
        const finalConfig = {
            ...configOverride,
            screener: screeningConfig || configOverride?.screener
        };

        // Check if this is a manual analysis request
        if (body.isManual) {
            await ensureCollectorReady(isTestnet);
            const jobId = await orchestrator.analyzeMarketWithJobTracking(
                userAddress,
                model,
                isTestnet,
                finalConfig
            );
            return NextResponse.json({ jobId, status: 'pending' });
        }

        // Legacy/Auto-trading path (Synchronous)
        await ensureCollectorReady(isTestnet);
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
