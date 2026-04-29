export interface ScreenerConfig {
    // A. Liquidity / execution (hard-gates)
    maxSpreadBps: number;
    minDepthUsd: number; // min(bid_depth, ask_depth) at fixed band (e.g. 1%)
    maxCostBps?: number; // Optional: total cost = fees + spread + slippage

    // B. Activity / "in-play" (hard-gates)
    minRecentVolume: number; // Quote volume in last N minutes
    recentVolumeMinutes: number;
    minRealizedVol: number; // Floor on realized volatility (e.g. m5)

    // C. Universe control (hard-gates)
    minVolume24h: number;
    topN: number;
    depthBandsPct: string[];

    // D. Quality scoring (ranking, NOT gating)
    quality_weights: {
        vol_score: number;
        move_score: number;
        trend_align: number;
        spread_penalty: number;
        illiquidity_penalty: number;
        cost_to_edge_penalty: number;
    };

    // Legacy/Internal flags (kept for compatibility)
    layer1Enabled: boolean; // Volume
    layer2Enabled: boolean; // Liquidity
    layer3Enabled: boolean; // Activity
    layer4Enabled: boolean; // Scoring
}

const DEPTH_BANDS = ["0.10", "0.25", "0.50", "1.00"];

export const SCREENER_PRESETS: Record<string, ScreenerConfig> = {
    "Scalper Strict": {
        maxSpreadBps: 8,
        minDepthUsd: 75_000,
        minRecentVolume: 20_000,
        recentVolumeMinutes: 15,
        minRealizedVol: 0.0008,
        minVolume24h: 10_000_000,
        topN: 8,
        depthBandsPct: DEPTH_BANDS,
        quality_weights: {
            vol_score: 2.0,
            move_score: 1.0,
            trend_align: 0.7,
            spread_penalty: 2.5,
            illiquidity_penalty: 2.5,
            cost_to_edge_penalty: 2.0
        },
        layer1Enabled: true,
        layer2Enabled: true,
        layer3Enabled: true,
        layer4Enabled: true
    },
    "Momentum Moderate": {
        maxSpreadBps: 15,
        minDepthUsd: 25_000,
        minRecentVolume: 750,
        recentVolumeMinutes: 15,
        minRealizedVol: 0.0006,
        minVolume24h: 1_000_000,
        topN: 16,
        depthBandsPct: DEPTH_BANDS,
        quality_weights: {
            vol_score: 1.5,
            move_score: 1.2,
            trend_align: 0.7,
            spread_penalty: 1.7,
            illiquidity_penalty: 1.5,
            cost_to_edge_penalty: 1.5
        },
        layer1Enabled: true,
        layer2Enabled: true,
        layer3Enabled: true,
        layer4Enabled: true
    },
    "Swing Relaxed": {
        maxSpreadBps: 25,
        minDepthUsd: 15_000,
        minRecentVolume: 500,
        recentVolumeMinutes: 20,
        minRealizedVol: 0.0004,
        minVolume24h: 500_000,
        topN: 20,
        depthBandsPct: DEPTH_BANDS,
        quality_weights: {
            vol_score: 1.0,
            move_score: 1.3,
            trend_align: 0.5,
            spread_penalty: 1.0,
            illiquidity_penalty: 1.0,
            cost_to_edge_penalty: 1.0
        },
        layer1Enabled: true,
        layer2Enabled: true,
        layer3Enabled: true,
        layer4Enabled: true
    },
    "Testnet Aggressive": {
        maxSpreadBps: 300,
        minDepthUsd: 0,
        minRecentVolume: 0,
        recentVolumeMinutes: 20,
        minRealizedVol: 0,
        minVolume24h: 0,
        topN: 25,
        depthBandsPct: DEPTH_BANDS,
        quality_weights: {
            vol_score: 0.1,
            move_score: 0.1,
            trend_align: 0.1,
            spread_penalty: 0.1,
            illiquidity_penalty: 0.1,
            cost_to_edge_penalty: 0.1
        },
        layer1Enabled: true,
        layer2Enabled: true,
        layer3Enabled: true,
        layer4Enabled: true
    }
};

// Live default: broad enough discovery without loose execution filters.
export const DEFAULT_SCREENER_CONFIG: ScreenerConfig = SCREENER_PRESETS["Momentum Moderate"];
