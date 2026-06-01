import { describe, expect, it } from "vitest";
import { classifySetups } from "@/lib/trader/SetupClassifier";
import { MarketStructure } from "@/services/MarketStructureService";

describe("SetupClassifier", () => {
    it("emits a momentum or breakout setup for a FARTCOIN-style pump", () => {
        const signals = classifySetups({
            structure: structure({ direction: "up", impulseBps: 2000, volumeSpike: true, rangeRatio: 2.1, bookPressure: 0.4 }),
            executionCostBps: 8,
            depthUsd: 100_000
        });

        expect(signals[0].side).toBe("long");
        expect(["MOMENTUM_CONTINUATION", "BREAKOUT_EXPANSION"]).toContain(signals[0].setupType);
        expect(signals[0].score).toBeGreaterThanOrEqual(70);
        expect(signals[0].reasons).toEqual(expect.arrayContaining(["IMPULSE_UP", "VOLUME_SPIKE"]));
    });

    it("emits continuation or failed-bounce diagnostics for a sharp dump", () => {
        const signals = classifySetups({
            structure: structure({ direction: "down", impulseBps: 1200, volumeSpike: true, rangeRatio: 1.8, bookPressure: -0.2, stalled: true }),
            executionCostBps: 10,
            depthUsd: 80_000
        });

        expect(signals.map(signal => signal.setupType)).toEqual(expect.arrayContaining(["MOMENTUM_CONTINUATION", "FAILED_BOUNCE"]));
        expect(signals.some(signal => signal.side === "short")).toBe(true);
    });
});

function structure(input: {
    direction: "up" | "down";
    impulseBps: number;
    volumeSpike: boolean;
    rangeRatio: number;
    bookPressure: number;
    stalled?: boolean;
}): MarketStructure {
    return {
        absMoveBps: { m15: input.impulseBps / 2, h1: input.impulseBps, h4: input.impulseBps },
        relativeMoveBps: {
            vsBtc_m15: 500,
            vsBtc_h1: 500,
            vsBtc_h4: 500,
            vsMarket_m15: 500,
            vsMarket_h1: 500,
            vsMarket_h4: 500
        },
        volume: {
            recentQuoteVolume: 100_000,
            relativeVolumeRatio: input.volumeSpike ? 2 : 1,
            volumeSpike: input.volumeSpike
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
            followThrough: true,
            stalled: input.stalled ?? false
        },
        participation: {
            openInterestDelta5m: 1000,
            fundingDelta5m: 0,
            bookPressure: input.bookPressure
        },
        optionalIndicators: {}
    };
}
