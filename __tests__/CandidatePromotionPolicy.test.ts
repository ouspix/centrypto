import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from "@/lib/agent-config";
import { buildPriorBucketKey } from "@/lib/candidate-promotion";
import { CandidatePromotionPolicy } from "@/lib/trader/CandidatePromotionPolicy";
import type { MarketStructure } from "@/services/MarketStructureService";
import type { MarketEntry } from "@/types/snapshot";

describe("CandidatePromotionPolicy", () => {
    it("leaves opportunities unchanged with inert defaults", () => {
        const decision = new CandidatePromotionPolicy(config()).evaluate({
            market: market(freshContinuationStructure()),
            side: "long",
            playbook: "Momentum:long",
            regime: "RISK_ON",
            inPlayScore: 62,
            setupScore: 72,
            costBps: 7,
            currentStatus: "NEAR_MISS"
        });

        expect(decision.finalStatus).toBe("unchanged");
        expect(decision.promotionReason).toBeNull();
        expect(decision.demotionReason).toBeNull();
    });

    it("records shadow prior buckets without changing eligibility", () => {
        const bucketKey = buildPriorBucketKey({
            playbook: "Momentum:long",
            side: "long",
            regime: "RISK_ON",
            inPlayScore: 62,
            setupScore: 72,
            costBps: 7
        });
        const decision = new CandidatePromotionPolicy(config({
            prior_buckets: {
                [bucketKey]: { status: "SHADOW" }
            },
            config_epoch: "2026-06-05T08:00:00.000Z"
        })).evaluate({
            market: market(freshContinuationStructure()),
            side: "long",
            playbook: "Momentum:long",
            regime: "RISK_ON",
            inPlayScore: 62,
            setupScore: 72,
            costBps: 7,
            currentStatus: "NEAR_MISS"
        });

        expect(decision.finalStatus).toBe("unchanged");
        expect(decision.shadowReason).toBe(`PRIOR_BUCKET_SHADOW:${bucketKey}`);
        expect(decision.configEpoch).toBe("2026-06-05T08:00:00.000Z");
    });

    it("demotes late chase candidates to near miss before considering promotions", () => {
        const bucketKey = buildPriorBucketKey({
            playbook: "Momentum:long",
            side: "long",
            regime: "RISK_ON",
            inPlayScore: 62,
            setupScore: 72,
            costBps: 7
        });
        const decision = new CandidatePromotionPolicy(config({
            global_structure_rules: {
                lateChase: "BLOCK",
                extendedBreakoutWithoutPullback: "ALLOW",
                freshContinuationBonus: false,
                pullbackContinuationBonus: false
            },
            prior_buckets: {
                [bucketKey]: { status: "LIVE" }
            }
        })).evaluate({
            market: market(lateChaseStructure()),
            side: "long",
            playbook: "Momentum:long",
            regime: "RISK_ON",
            inPlayScore: 62,
            setupScore: 72,
            costBps: 7,
            currentStatus: "CANDIDATE"
        });

        expect(decision.finalStatus).toBe("demote");
        expect(decision.demotionReason).toBe("LATE_CHASE_BLOCK");
        expect(decision.promotionReason).toBeNull();
        expect(decision.structureFlags.is_late_chase).toBe(true);
    });

    it("promotes live positive prior bucket matches", () => {
        const bucketKey = buildPriorBucketKey({
            playbook: "Momentum:long",
            side: "long",
            regime: "RISK_ON",
            inPlayScore: 62,
            setupScore: 72,
            costBps: 7
        });
        const decision = new CandidatePromotionPolicy(config({
            prior_buckets: {
                [bucketKey]: { status: "LIVE" }
            }
        })).evaluate({
            market: market(freshContinuationStructure()),
            side: "long",
            playbook: "Momentum:long",
            regime: "RISK_ON",
            inPlayScore: 62,
            setupScore: 72,
            costBps: 7,
            currentStatus: "NEAR_MISS"
        });

        expect(decision.finalStatus).toBe("promote");
        expect(decision.promotionReason).toBe(`PRIOR_BUCKET_LIVE:${bucketKey}`);
        expect(decision.demotionReason).toBeNull();
    });
});

function config(candidatePromotion: Record<string, any> = {}): AgentConfig {
    return {
        ...DEFAULT_AGENT_CONFIG,
        candidate_promotion: candidatePromotion as any
    };
}

function market(structure: MarketStructure): MarketEntry {
    return {
        symbol: "BTC-PERP",
        price: 50000,
        execution: { tradeable: true, blockReasons: [], spreadBps: 2, depthUsd: 100000, costBps: 7 },
        derived: {
            costs: { fees_bps: 3.5, slippage_bps_est: 1, cost_bps: 7, cost_ok: true },
            structure
        }
    } as unknown as MarketEntry;
}

function freshContinuationStructure(): MarketStructure {
    return structure({
        impulse: { direction: "up", impulseBps: 30, ageMinutes: 1, followThrough: true, stalled: false },
        range: { rangeExpansionRatio: 1.1, distanceFromLocalHighBps: -2, distanceFromLocalLowBps: 30 }
    });
}

function lateChaseStructure(): MarketStructure {
    return structure({
        impulse: { direction: "up", impulseBps: 100, ageMinutes: 1, followThrough: true, stalled: true },
        range: { rangeExpansionRatio: 1.6, distanceFromLocalHighBps: -5, distanceFromLocalLowBps: 100 }
    });
}

function structure(overrides: {
    impulse: MarketStructure["impulse"];
    range: Partial<MarketStructure["range"]>;
}): MarketStructure {
    return {
        absMoveBps: { m15: null, h1: null, h4: null },
        relativeMoveBps: {
            vsBtc_m15: null,
            vsBtc_h1: null,
            vsBtc_h4: null,
            vsMarket_m15: null,
            vsMarket_h1: null,
            vsMarket_h4: null
        },
        volume: { recentQuoteVolume: null, relativeVolumeRatio: null, volumeSpike: false },
        range: {
            rangeExpansionRatio: null,
            compressionThenExpansion: false,
            newHigh1h: false,
            newLow1h: false,
            newHigh4h: false,
            newLow4h: false,
            distanceFromLocalHighBps: null,
            distanceFromLocalLowBps: null,
            ...overrides.range
        },
        impulse: overrides.impulse,
        participation: { openInterestDelta5m: null, fundingDelta5m: null, bookPressure: null },
        optionalIndicators: {}
    };
}
