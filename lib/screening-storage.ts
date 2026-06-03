import { ScreenerConfig } from "@/lib/screener-config";
import { findMatchingScreenerPresetName, normalizeScreenerConfig } from "@/lib/auto-trader-config";

export const ACTIVE_SCREENING_CONFIG_KEY = "screeningConfig";
export const DRAFT_SCREENING_CONFIG_KEY = "screeningConfigDraft";
export const ACTIVE_SCREENING_PRESET_KEY = "screeningConfigPreset";
export const DRAFT_SCREENING_PRESET_KEY = "screeningConfigDraftPreset";
export const SCREENING_CONFIG_APPLIED_EVENT = "screeningConfigApplied";

export type ScreeningConfigState = {
    config: ScreenerConfig;
    presetName: string;
    hasStoredConfig: boolean;
};

function mergeScreenerConfig(value: unknown): ScreenerConfig {
    return normalizeScreenerConfig(value) as ScreenerConfig;
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

function readString(key: string): string | null {
    if (typeof window === "undefined") return null;
    const value = localStorage.getItem(key);
    return value && value.trim() ? value : null;
}

function resolvePresetName(config: ScreenerConfig, configuredPreset: string | null, fallback = "custom"): string {
    if (configuredPreset) return configuredPreset;
    return findMatchingScreenerPresetName(config) ?? fallback;
}

export function readActiveScreeningConfig(): ScreenerConfig {
    return readActiveScreeningState().config;
}

export function readDraftScreeningConfig(): ScreenerConfig {
    return readDraftScreeningState().config;
}

export function readActiveScreeningState(): ScreeningConfigState {
    const loaded = readJson(ACTIVE_SCREENING_CONFIG_KEY);
    const config = mergeScreenerConfig(loaded);
    return {
        config,
        presetName: resolvePresetName(
            config,
            readString(ACTIVE_SCREENING_PRESET_KEY),
            loaded ? "custom" : "Momentum Moderate"
        ),
        hasStoredConfig: !!loaded
    };
}

export function readDraftScreeningState(): ScreeningConfigState {
    const draft = readJson(DRAFT_SCREENING_CONFIG_KEY);
    const active = readJson(ACTIVE_SCREENING_CONFIG_KEY);
    const config = mergeScreenerConfig(draft ?? active);
    return {
        config,
        presetName: resolvePresetName(
            config,
            readString(DRAFT_SCREENING_PRESET_KEY) ??
            readString(ACTIVE_SCREENING_PRESET_KEY) ??
            null,
            draft || active ? "custom" : "Momentum Moderate"
        ),
        hasStoredConfig: !!(draft ?? active)
    };
}

export function saveDraftScreeningConfig(config: ScreenerConfig, presetName = "custom") {
    if (typeof window === "undefined") return;
    localStorage.setItem(DRAFT_SCREENING_CONFIG_KEY, JSON.stringify(config));
    localStorage.setItem(DRAFT_SCREENING_PRESET_KEY, presetName);
}

export function applyDraftScreeningConfig(): ScreenerConfig {
    const { config, presetName } = readDraftScreeningState();

    if (typeof window !== "undefined") {
        localStorage.setItem(ACTIVE_SCREENING_CONFIG_KEY, JSON.stringify(config));
        localStorage.setItem(ACTIVE_SCREENING_PRESET_KEY, presetName);
        window.dispatchEvent(new CustomEvent(SCREENING_CONFIG_APPLIED_EVENT, {
            detail: { config, presetName }
        }));
    }

    return config;
}

export function screeningConfigFromAppliedEventDetail(detail: unknown): ScreeningConfigState {
    if (detail && typeof detail === "object" && "config" in detail) {
        const state = detail as Partial<ScreeningConfigState>;
        const config = mergeScreenerConfig(state.config);
        return {
            config,
            presetName: resolvePresetName(config, typeof state.presetName === "string" ? state.presetName : null),
            hasStoredConfig: true
        };
    }

    const config = mergeScreenerConfig(detail);
    return {
        config,
        presetName: resolvePresetName(config, null),
        hasStoredConfig: detail !== null && detail !== undefined
    };
}
