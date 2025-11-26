import { NextResponse } from 'next/server';
import { DEFAULT_AGENT_CONFIG } from '@/lib/agent-config';
import { ScreenerService } from '@/services/ScreenerService';

const screener = new ScreenerService();

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { isTestnet = true, screeningConfig } = body;

        // Construct a valid AgentConfig
        let config = DEFAULT_AGENT_CONFIG;
        if (screeningConfig) {
            // Check if it's a full config (has 'screener' property) or just screener params (legacy)
            if (screeningConfig.screener) {
                config = { ...DEFAULT_AGENT_CONFIG, ...screeningConfig };
            } else {
                // Legacy: screeningConfig IS the screener params (camelCase)
                // We need to map these to the snake_case AgentConfig structure
                // and handle the 'Enabled' flags.

                const legacy = screeningConfig;

                config = {
                    ...DEFAULT_AGENT_CONFIG,
                    gates: {
                        ...DEFAULT_AGENT_CONFIG.gates,
                        // Map maxSpreadBps -> spread_bps_hard_max
                        // If layer2 disabled, set to high value to effectively disable filter
                        spread_bps_hard_max: legacy.layer2Enabled ? (legacy.maxSpreadBps || 50) : 10000,
                    },
                    screener: {
                        ...DEFAULT_AGENT_CONFIG.screener,
                        // Map minVolume24h -> min_volume_24h
                        min_volume_24h: legacy.layer1Enabled ? (legacy.minVolume24h || 0) : 0,

                        // Map minDepthUsd -> min_depth_usd
                        min_depth_usd: legacy.layer2Enabled ? (legacy.minDepthUsd || 0) : 0,

                        // Map minVolZscore -> min_vol_ratio_5m_vs_1h
                        min_vol_ratio_5m_vs_1h: legacy.layer3Enabled ? (legacy.minVolZscore || 0) : 0,

                        // Map minRetZscore -> min_abs_ret_sigma_5m_vs_1h
                        min_abs_ret_sigma_5m_vs_1h: legacy.layer3Enabled ? (legacy.minRetZscore || 0) : 0,

                        // Map topN -> top_n
                        top_n: legacy.layer4Enabled ? (legacy.topN || 20) : 100
                    }
                };
            }
        }

        const symbols = await screener.getScreenedSymbols(isTestnet, [], config);

        return NextResponse.json({ symbols });
    } catch (error) {
        console.error('Screener API Error:', error);
        return NextResponse.json({
            error: 'Screening failed',
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
