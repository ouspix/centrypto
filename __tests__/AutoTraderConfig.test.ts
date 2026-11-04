import { describe, expect, it } from "vitest";
import { buildActiveScreenerSummary, normalizeAutoTraderConfigOverride } from "@/lib/auto-trader-config";
import { buildAutoTraderActivityReport } from "@/lib/auto-trader-activity-report";
import {
    candidatePromotionRulesEqual,
    candidatePromotionRulesHash,
    normalizeCandidatePromotionConfig
} from "@/lib/candidate-promotion";
import { SCREENER_PRESETS } from "@/lib/screener-config";

describe("auto-trader config normalization", () => {
    it("keeps the Discovery Balanced screener preset complete", () => {
        expect(SCREENER_PRESETS["Discovery Balanced"]).toMatchObject({
            maxSpreadBps: 15,
            minDepthUsd: 20_000,
            maxCostBps: 25,
            minRecentVolume: 1_000,
            recentVolumeMinutes: 15,
            minRealizedVol: 0.0004,
            minVolume24h: 1_000_000,
            topN: 16,
            discoveryMaxSymbols: 40,
            hotMoverTopN: 12,
            volumeSpikeTopN: 10,
            rangeExpansionTopN: 10,
            hotMoverMinAbsMoveBps: 150,
            hotMoverLookbacks: ["m15", "h1", "h4"],
            includeHotMoversEvenIfNotTopN: true,
            includeExecutionBlockedForDiagnostics: true,
            depthBandsPct: ["0.10", "0.25", "0.50", "1.00"],
            quality_weights: {
                vol_score: 1.4,
                move_score: 1.8,
                trend_align: 0.7,
                spread_penalty: 1.2,
                illiquidity_penalty: 1.2,
                cost_to_edge_penalty: 1.0
            },
            layer1Enabled: true,
            layer2Enabled: true,
            layer3Enabled: true,
            layer4Enabled: true
        });
    });

    it("resolves Discovery Balanced by screener preset name and preserves unknown keys", () => {
        const normalized = normalizeAutoTraderConfigOverride({
            screenerPresetName: "Discovery Balanced",
            screener: {
                customDiscoveryFlag: "keep-me",
                quality_weights: {
                    custom_weight: 9
                }
            }
        });

        expect(normalized.screener.discoveryMaxSymbols).toBe(40);
        expect(normalized.screener.hotMoverTopN).toBe(12);
        expect(normalized.screener.includeExecutionBlockedForDiagnostics).toBe(true);
        expect(normalized.screener.customDiscoveryFlag).toBe("keep-me");
        expect(normalized.screener.quality_weights.custom_weight).toBe(9);
    });

    it("resolves Discovery Balanced by config preset_name", () => {
        const normalized = normalizeAutoTraderConfigOverride({
            preset_name: "Discovery Balanced"
        });

        expect(normalized.screenerPresetName).toBe("Discovery Balanced");
        expect(normalized.screener.discoveryMaxSymbols).toBe(40);
    });

    it("builds active screener summary with discovery fields", () => {
        const summary = buildActiveScreenerSummary({
            screenerPresetName: "Discovery Balanced"
        });

        expect(summary).toMatchObject({
            maxSpreadBps: 15,
            minDepthUsd: 20_000,
            maxCostBps: 25,
            topN: 16,
            discoveryMaxSymbols: 40,
            hotMoverTopN: 12,
            volumeSpikeTopN: 10,
            rangeExpansionTopN: 10,
            includeExecutionBlockedForDiagnostics: true
        });
    });

    it("normalizes candidate promotion rules with inert defaults", () => {
        const normalized = normalizeAutoTraderConfigOverride({});

        expect(normalized.candidate_promotion).toMatchObject({
            config_epoch: null,
            global_structure_rules: {
                lateChase: "ALLOW",
                extendedBreakoutWithoutPullback: "ALLOW",
                freshContinuationBonus: false,
                pullbackContinuationBonus: false
            },
            playbook_overrides: {},
            prior_buckets: {}
        });
    });

    it("compares candidate promotion rules without config_epoch", () => {
        const left = normalizeCandidatePromotionConfig({
            config_epoch: "2026-06-05T10:00:00.000Z",
            global_structure_rules: { lateChase: "BLOCK" }
        });
        const right = normalizeCandidatePromotionConfig({
            config_epoch: "2026-06-05T11:00:00.000Z",
            global_structure_rules: { lateChase: "BLOCK" }
        });

        expect(candidatePromotionRulesEqual(left, right)).toBe(true);
        expect(candidatePromotionRulesHash(left)).toBe(candidatePromotionRulesHash(right));
    });
});

describe("auto-trader activity report", () => {
    it("displays discoveryMaxSymbols when present", () => {
        const report = buildAutoTraderActivityReport({
            generatedAt: new Date("2026-06-02T12:00:00Z"),
            settingsConfig: {
                screener: SCREENER_PRESETS["Discovery Balanced"]
            },
            latestSnapshotData: {
                presets: {
                    screening: SCREENER_PRESETS["Discovery Balanced"]
                }
            }
        });

        expect(report).toContain("| Screener discoveryMaxSymbols | 40 |");
        expect(report).toContain("| Snapshot discoveryMaxSymbols | 40 |");
    });
});
