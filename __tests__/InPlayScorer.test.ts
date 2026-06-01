import { describe, expect, it } from "vitest";
import { computeInPlayScore } from "@/lib/trader/InPlayScorer";
import { MarketStructure } from "@/services/MarketStructureService";

describe("InPlayScorer", () => {
    it("gives high scores to 10-20% movers even when execution is expensive", () => {
        const score = computeInPlayScore({
            structure: structure({ impulseBps: 1800, direction: "up", relativeMoveBps: 800, volumeRatio: 2.4, rangeRatio: 2 }),
            executionCostBps: 22,
            spreadBps: 18,
            depthUsd: 18_000
        });

        expect(score.score).toBeGreaterThanOrEqual(60);
        expect(score.reasons).toEqual(expect.arrayContaining(["HOT_1H_MOVE", "RELATIVE_STRENGTH", "VOLUME_SPIKE", "IMPULSE_UP"]));
        expect(score.warnings).toEqual(expect.arrayContaining(["EXECUTION_COST_HIGH", "DEPTH_WEAK"]));
    });

    it("keeps flat symbols low without volume or range expansion", () => {
        const score = computeInPlayScore({
            structure: structure({ impulseBps: 5, direction: "none", relativeMoveBps: 0, volumeRatio: 0.8, rangeRatio: 0.9 }),
            executionCostBps: 5,
            spreadBps: 2,
            depthUsd: 100_000
        });

        expect(score.score).toBeLessThan(15);
        expect(score.reasons).toHaveLength(0);
    });
});

function structure(input: {
    impulseBps: number;
    direction: "up" | "down" | "none";
    relativeMoveBps: number;
    volumeRatio: number;
    rangeRatio: number;
}): MarketStructure {
    return {
        absMoveBps: { m15: input.impulseBps / 2, h1: input.impulseBps, h4: input.impulseBps },
        relativeMoveBps: {
            vsBtc_m15: input.relativeMoveBps,
            vsBtc_h1: input.relativeMoveBps,
            vsBtc_h4: input.relativeMoveBps,
            vsMarket_m15: input.relativeMoveBps,
            vsMarket_h1: input.relativeMoveBps,
            vsMarket_h4: input.relativeMoveBps
        },
        volume: {
            recentQuoteVolume: 100_000,
            relativeVolumeRatio: input.volumeRatio,
            volumeSpike: input.volumeRatio >= 1.5
        },
        range: {
            rangeExpansionRatio: input.rangeRatio,
            compressionThenExpansion: input.rangeRatio >= 1.8,
            newHigh1h: input.direction === "up",
            newLow1h: input.direction === "down",
            newHigh4h: false,
            newLow4h: false,
            distanceFromLocalHighBps: null,
            distanceFromLocalLowBps: null
        },
        impulse: {
            direction: input.direction,
            impulseBps: input.impulseBps,
            ageMinutes: 0,
            followThrough: input.direction !== "none",
            stalled: false
        },
        participation: {
            openInterestDelta5m: 1000,
            fundingDelta5m: 0,
            bookPressure: input.direction === "down" ? -0.4 : 0.4
        },
        optionalIndicators: {}
    };
}
