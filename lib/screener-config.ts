
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
        vol_score: number;        // reward high realized vol / vol_ratio
        move_score: number;       // reward large |return| / |ret_sigma|
        trend_align: number;      // reward m15/h1 alignment
        spread_penalty: number;   // penalize spread even if under hard cap
        illiquidity_penalty: number; // penalize shallow books even if above hard min
    };

    // Legacy/Internal flags (kept for compatibility if needed, or can be deprecated)
    layer1Enabled: boolean; // Volume
    layer2Enabled: boolean; // Liquidity
    layer3Enabled: boolean; // Activity
    layer4Enabled: boolean; // Scoring
}

export const DEFAULT_SCREENER_CONFIG: ScreenerConfig = {
    // Default to "Scalper Strict" preset
    maxSpreadBps: 25,
    minDepthUsd: 50_000,

    minRecentVolume: 200_000,
    recentVolumeMinutes: 10,
    minRealizedVol: 0.0008,

    minVolume24h: 5_000_000,
    topN: 12,
    depthBandsPct: ["0.10", "0.25", "0.50", "1.00"],

    quality_weights: {
        vol_score: 2.0,
        move_score: 1.0,
        trend_align: 0.5,
        spread_penalty: 2.0,
        illiquidity_penalty: 2.0
    },

    layer1Enabled: true,
    layer2Enabled: true,
    layer3Enabled: true,
    layer4Enabled: true
};

export const SCREENER_PRESETS: Record<string, ScreenerConfig> = {
    "Scalper Strict": {
        ...DEFAULT_SCREENER_CONFIG,
        maxSpreadBps: 25,
        minDepthUsd: 50_000,
        minRecentVolume: 200_000,
        recentVolumeMinutes: 10,
        minRealizedVol: 0.0008,
        minVolume24h: 5_000_000,
        topN: 12,
        depthBandsPct: ["0.10", "0.25", "0.50", "1.00"],
        quality_weights: {
            vol_score: 2.0,
            move_score: 1.0,
            trend_align: 0.5,
            spread_penalty: 2.0,
            illiquidity_penalty: 2.0
        }
    },
    "Momentum Moderate": {
        ...DEFAULT_SCREENER_CONFIG,
        maxSpreadBps: 50,
        minDepthUsd: 15_000,
        minRecentVolume: 100_000,
        recentVolumeMinutes: 15,
        minRealizedVol: 0.0005,
        minVolume24h: 2_000_000,
        topN: 20,
        depthBandsPct: ["0.10", "0.25", "0.50", "1.00"],
        quality_weights: {
            vol_score: 1.5,
            move_score: 1.0,
            trend_align: 0.5,
            spread_penalty: 1.0,
            illiquidity_penalty: 1.0
        }
    },
    "Relaxed Liquidity": {
        ...DEFAULT_SCREENER_CONFIG,
        maxSpreadBps: 80,
        minDepthUsd: 5_000,
        minRecentVolume: 25_000,
        recentVolumeMinutes: 20,
        minRealizedVol: 0.0003,
        minVolume24h: 500_000,
        topN: 30,
        depthBandsPct: ["0.10", "0.25", "0.50", "1.00"],
        quality_weights: {
            vol_score: 1.0,
            move_score: 1.5,
            trend_align: 0.5,
            spread_penalty: 0.5,
            illiquidity_penalty: 0.5
        }
    },
    "Testnet Lenient": {
        ...DEFAULT_SCREENER_CONFIG,
        maxSpreadBps: 120,
        minDepthUsd: 1_000,
        minRecentVolume: 10_000,
        recentVolumeMinutes: 20,
        minRealizedVol: 0.0001,
        minVolume24h: 0,
        topN: 25,
        depthBandsPct: ["0.10", "0.25", "0.50", "1.00"],
        quality_weights: {
            vol_score: 0.1,
            move_score: 0.1,
            trend_align: 0.1,
            spread_penalty: 0.1,
            illiquidity_penalty: 0.1
        }
    }
};
