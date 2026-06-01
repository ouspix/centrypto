import { MarketStructure } from "@/services/MarketStructureService";

export type InPlayScore = {
    score: number;
    reasons: string[];
    warnings: string[];
};

export function computeInPlayScore(input: {
    structure: MarketStructure;
    executionCostBps: number;
    spreadBps: number;
    depthUsd: number;
}): InPlayScore {
    const reasons: string[] = [];
    const warnings: string[] = [];
    let score = 0;

    const maxAbsMove = Math.max(
        input.structure.absMoveBps.m15 ?? 0,
        input.structure.absMoveBps.h1 ?? 0,
        input.structure.absMoveBps.h4 ?? 0
    );
    if (maxAbsMove >= 1000) reasons.push("HOT_4H_MOVE");
    if ((input.structure.absMoveBps.h1 ?? 0) >= 500) reasons.push("HOT_1H_MOVE");
    score += Math.min(25, maxAbsMove / 40);

    const relativeMove = Math.max(
        Math.abs(input.structure.relativeMoveBps.vsBtc_m15 ?? 0),
        Math.abs(input.structure.relativeMoveBps.vsBtc_h1 ?? 0),
        Math.abs(input.structure.relativeMoveBps.vsMarket_m15 ?? 0),
        Math.abs(input.structure.relativeMoveBps.vsMarket_h1 ?? 0)
    );
    if (relativeMove >= 150) {
        reasons.push(input.structure.impulse.direction === "down" ? "RELATIVE_WEAKNESS" : "RELATIVE_STRENGTH");
    }
    score += Math.min(20, relativeMove / 15);

    const volumeRatio = input.structure.volume.relativeVolumeRatio ?? 0;
    if (input.structure.volume.volumeSpike) reasons.push("VOLUME_SPIKE");
    score += Math.min(15, Math.max(0, volumeRatio - 1) * 10);

    const rangeExpansion = input.structure.range.rangeExpansionRatio ?? 0;
    if (rangeExpansion >= 1.5) reasons.push("RANGE_EXPANSION");
    score += Math.min(15, Math.max(0, rangeExpansion - 1) * 10);

    if (input.structure.impulse.direction !== "none") {
        reasons.push(input.structure.impulse.direction === "up" ? "IMPULSE_UP" : "IMPULSE_DOWN");
        score += Math.min(15, input.structure.impulse.impulseBps / 50);
        if (input.structure.impulse.followThrough) score += 4;
        if (input.structure.impulse.stalled) warnings.push("IMPULSE_STALLED");
    }

    const oiDelta = input.structure.participation.openInterestDelta5m;
    const bookPressure = input.structure.participation.bookPressure;
    if (oiDelta !== null && Math.abs(oiDelta) > 0) score += 4;
    if (bookPressure !== null && Math.abs(bookPressure) >= 0.25) score += 6;

    let executionPenalty = 0;
    if (input.executionCostBps >= 20) {
        warnings.push("EXECUTION_COST_HIGH");
        executionPenalty += 10;
    } else if (input.executionCostBps >= 12) {
        executionPenalty += 5;
    }
    if (input.spreadBps >= 15) {
        warnings.push("SPREAD_WIDE");
        executionPenalty += 5;
    }
    if (input.depthUsd < 25_000) {
        warnings.push("DEPTH_WEAK");
        executionPenalty += 5;
    }

    score = Math.max(0, Math.min(100, score - Math.min(20, executionPenalty)));
    return {
        score: round(score),
        reasons: Array.from(new Set(reasons)),
        warnings: Array.from(new Set(warnings))
    };
}

function round(value: number): number {
    return parseFloat(value.toFixed(2));
}
