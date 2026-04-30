import { DEFAULT_SCREENER_CONFIG, ScreenerConfig } from "@/lib/screener-config";

export const ACTIVE_SCREENING_CONFIG_KEY = "screeningConfig";
export const DRAFT_SCREENING_CONFIG_KEY = "screeningConfigDraft";
export const SCREENING_CONFIG_APPLIED_EVENT = "screeningConfigApplied";

function mergeScreenerConfig(value: unknown): ScreenerConfig {
    const loaded = value && typeof value === "object" ? value as Partial<ScreenerConfig> : {};

    return {
        ...DEFAULT_SCREENER_CONFIG,
        ...loaded,
        quality_weights: {
            ...DEFAULT_SCREENER_CONFIG.quality_weights,
            ...(loaded.quality_weights || {})
        }
    };
}

function readJson(key: string): unknown | null {
    if (typeof window === "undefined") return null;

    const raw = localStorage.getItem(key);
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch (error) {
        console.error(`Failed to load ${key}`, error);
        return null;
    }
}

export function readActiveScreeningConfig(): ScreenerConfig {
    return mergeScreenerConfig(readJson(ACTIVE_SCREENING_CONFIG_KEY));
}

export function readDraftScreeningConfig(): ScreenerConfig {
    return mergeScreenerConfig(
        readJson(DRAFT_SCREENING_CONFIG_KEY) ??
        readJson(ACTIVE_SCREENING_CONFIG_KEY)
    );
}

export function saveDraftScreeningConfig(config: ScreenerConfig) {
    if (typeof window === "undefined") return;
    localStorage.setItem(DRAFT_SCREENING_CONFIG_KEY, JSON.stringify(config));
}

export function applyDraftScreeningConfig(): ScreenerConfig {
    const config = readDraftScreeningConfig();

    if (typeof window !== "undefined") {
        localStorage.setItem(ACTIVE_SCREENING_CONFIG_KEY, JSON.stringify(config));
        window.dispatchEvent(new CustomEvent(SCREENING_CONFIG_APPLIED_EVENT, { detail: config }));
    }

    return config;
}
