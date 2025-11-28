
export interface ScreenerConfig {
    layer1Enabled: boolean;
    minVolume24h: number;
    layer2Enabled: boolean;
    maxSpreadBps: number;
    dynamicSpreadEnabled: boolean;
    minDepthUsd: number;
    layer3Enabled: boolean;
    minVolZscore: number;
    minRetZscore: number;
    minRealizedVol: number;
    minRetM5: number;
    minRetM15: number;
    layer4Enabled: boolean;
    topN: number;
    // Recent Activity Filter (Layer 1)
    minRecentVolume: number;
    recentVolumeMinutes: number;

    // Quality weights were in AgentConfig but not in ScreeningParameters.
    // We should include them here to maintain logic in ScreenerService, 
    // even if not exposed in UI yet, or use defaults.
    quality_weights: {
        vol_score: number;
        move_score: number;
        trend_align: number;
        spread_penalty: number;
        illiquidity_penalty: number;
    };
}

export const DEFAULT_SCREENER_CONFIG: ScreenerConfig = {
    layer1Enabled: true,
    minVolume24h: 1_000_000,
    minRecentVolume: 50_000,
    recentVolumeMinutes: 15,
    layer2Enabled: true,
    maxSpreadBps: 50,
    dynamicSpreadEnabled: true,
    minDepthUsd: 10_000,
    layer3Enabled: true,
    minVolZscore: 0.5,
    minRetZscore: 0.5,
    minRealizedVol: 0.0005,
    minRetM5: 0.0001,
    minRetM15: 0.0001,
    layer4Enabled: true,
    topN: 20,
    quality_weights: {
        vol_score: 2.0,
        move_score: 1.0,
        trend_align: 0.5,
        spread_penalty: 1.0,
        illiquidity_penalty: 0.5
    }
};
