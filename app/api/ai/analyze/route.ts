import { NextResponse } from 'next/server';
import { OrchestratorService } from '@/services/OrchestratorService';
import { ensureCollectorReady } from '@/services/CollectorRunner';
import { requireWalletSession, WalletSessionError } from '@/lib/auth/wallet-session';
import { prisma } from '@/lib/db';

export async function POST(request: Request) {
    try {
        const session = requireWalletSession(request);
        const body = await request.json();
        const {
            autoTrading = false,
            model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v3.2-exp", // Default to OpenRouter model if available
            isTestnet = true,
            screeningConfig, // Legacy
            configOverride // New full config
        } = body;
        const userAddress = session.address;

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
            const [running, queued] = await Promise.all([
                prisma.analysisJob.count({ where: { userAddress, status: 'running' } }),
                prisma.analysisJob.count({ where: { userAddress, status: 'pending' } })
            ]);
            if (running >= 1 && queued >= 1) {
                return NextResponse.json({ error: 'Only one running and one queued AI job are allowed per wallet' }, { status: 429 });
            }
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
        if (error instanceof WalletSessionError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
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
