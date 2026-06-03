import { DEFAULT_SCREENER_CONFIG, SCREENER_PRESETS, ScreenerConfig } from "@/lib/screener-config";

export type ActiveScreenerSummary = {
    maxSpreadBps: number;
    minDepthUsd: number;
    maxCostBps?: number;
    topN: number;
    discoveryMaxSymbols?: number;
    hotMoverTopN?: number;
    volumeSpikeTopN?: number;
    rangeExpansionTopN?: number;
    includeExecutionBlockedForDiagnostics?: boolean;
};

const DISCOVERY_BALANCED = "Discovery Balanced";

function isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

export function resolveScreenerPresetName(configOverride?: unknown): string | null {
    if (!isRecord(configOverride)) return null;

    const screenerPresetName = typeof configOverride.screenerPresetName === "string"
        ? configOverride.screenerPresetName
        : null;
    if (screenerPresetName && SCREENER_PRESETS[screenerPresetName]) {
        return screenerPresetName;
    }

    if (configOverride.preset_name === DISCOVERY_BALANCED || screenerPresetName === DISCOVERY_BALANCED) {
        return DISCOVERY_BALANCED;
    }

    return null;
}

export function normalizeScreenerConfig(
    screener?: unknown,
    screenerPresetName?: string | null
): ScreenerConfig & Record<string, any> {
    const preset = screenerPresetName && SCREENER_PRESETS[screenerPresetName]
        ? SCREENER_PRESETS[screenerPresetName]
        : DEFAULT_SCREENER_CONFIG;
    const loaded = isRecord(screener) ? screener : {};

    return {
        ...DEFAULT_SCREENER_CONFIG,
        ...preset,
        ...loaded,
        quality_weights: {
            ...DEFAULT_SCREENER_CONFIG.quality_weights,
            ...preset.quality_weights,
            ...(isRecord(loaded.quality_weights) ? loaded.quality_weights : {})
        }
    };
}

export function normalizeAutoTraderConfigOverride(configOverride?: unknown): Record<string, any> {
    const loaded = isRecord(configOverride) ? { ...configOverride } : {};
    const presetName = resolveScreenerPresetName(loaded);
    const screener = normalizeScreenerConfig(loaded.screener, presetName);

    return {
        ...loaded,
        ...(presetName ? { screenerPresetName: presetName } : {}),
        screener
    };
}

export function buildActiveScreenerSummary(configOverride?: unknown): ActiveScreenerSummary {
    const normalized = normalizeAutoTraderConfigOverride(configOverride);
    const screener = normalized.screener as ScreenerConfig;

    return {
        maxSpreadBps: screener.maxSpreadBps,
        minDepthUsd: screener.minDepthUsd,
        maxCostBps: screener.maxCostBps,
        topN: screener.topN,
        discoveryMaxSymbols: screener.discoveryMaxSymbols,
        hotMoverTopN: screener.hotMoverTopN,
        volumeSpikeTopN: screener.volumeSpikeTopN,
        rangeExpansionTopN: screener.rangeExpansionTopN,
        includeExecutionBlockedForDiagnostics: screener.includeExecutionBlockedForDiagnostics
    };
}

export function findMatchingScreenerPresetName(screener?: unknown): string | null {
    if (!isRecord(screener)) return null;
    const keysToCompare = [
        "maxSpreadBps",
        "minDepthUsd",
        "maxCostBps",
        "minRecentVolume",
        "recentVolumeMinutes",
        "minRealizedVol",
        "minVolume24h",
        "topN",
        "discoveryMaxSymbols",
        "hotMoverTopN",
        "volumeSpikeTopN",
        "rangeExpansionTopN",
        "hotMoverMinAbsMoveBps",
        "hotMoverLookbacks",
        "includeHotMoversEvenIfNotTopN",
        "includeExecutionBlockedForDiagnostics"
    ];

    for (const [name, preset] of Object.entries(SCREENER_PRESETS)) {
        const matches = keysToCompare.every(key => {
            const presetValue = (preset as Record<string, any>)[key];
            const loadedValue = screener[key];
            return JSON.stringify(loadedValue) === JSON.stringify(presetValue);
        });
        if (matches) {
            return name;
        }
    }
    return null;
}
