import { NextResponse } from 'next/server';
import { DEFAULT_AGENT_CONFIG } from '@/lib/agent-config';
import { DEFAULT_SCREENER_CONFIG, ScreenerConfig } from '@/lib/screener-config';
import { ScreenerService } from '@/services/ScreenerService';

const screener = new ScreenerService();

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { isTestnet = true, screeningConfig } = body;

        // Construct a valid AgentConfig
        // Construct a valid ScreenerConfig
        let screenerConfig: ScreenerConfig = DEFAULT_SCREENER_CONFIG;
        let agentConfig = DEFAULT_AGENT_CONFIG;

        if (screeningConfig) {
            // Check if it's a full config (has 'screener' property) or just screener params (legacy)
            if (screeningConfig.screener) {
                // If passed as part of full config
                screenerConfig = { ...DEFAULT_SCREENER_CONFIG, ...screeningConfig.screener };
                agentConfig = { ...DEFAULT_AGENT_CONFIG, ...screeningConfig };
            } else if (screeningConfig.topN !== undefined || screeningConfig.layer1Enabled !== undefined) {
                // It IS the ScreenerConfig (from ScreeningParameters)
                screenerConfig = { ...DEFAULT_SCREENER_CONFIG, ...screeningConfig };
            } else {
                // Legacy: screeningConfig IS the screener params (camelCase) but maybe missing some fields
                // We need to map these to the structure
                // Actually, ScreeningParameters ALREADY uses the structure that matches ScreenerConfig mostly.
                // The only difference was AgentConfig used snake_case.
                // Now ScreenerConfig uses camelCase (mostly, based on my definition).
                // Wait, my definition of ScreenerConfig in lib/screener-config.ts used camelCase for UI props?
                // Let me check lib/screener-config.ts content I wrote.
                // Yes, I used camelCase for UI props like minVolume24h.

                // So if screeningConfig comes from UI, it matches ScreenerConfig.
                screenerConfig = { ...DEFAULT_SCREENER_CONFIG, ...screeningConfig };
            }
        }

        const symbols = await screener.getScreenedSymbols(isTestnet, [], agentConfig, screenerConfig);

        return NextResponse.json({ symbols });
    } catch (error) {
        console.error('Screener API Error:', error);
        return NextResponse.json({
            error: 'Screening failed',
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
