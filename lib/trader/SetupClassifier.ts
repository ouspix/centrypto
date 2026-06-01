import { MarketStructure } from "@/services/MarketStructureService";
import { TradeSide } from "@/types/trading";

export type SetupType =
    | "MOMENTUM_CONTINUATION"
    | "PULLBACK_CONTINUATION"
    | "BREAKOUT_EXPANSION"
    | "FAILED_BREAKOUT"
    | "FAILED_BOUNCE"
    | "CAPITULATION_BOUNCE"
    | "MEAN_REVERSION_RANGE"
    | "NO_SETUP";

export type SetupSignal = {
    setupType: SetupType;
    side: TradeSide;
    playbook:
        | "Momentum:long"
        | "Momentum:short"
        | "Breakout:long"
        | "Breakout:short"
        | "Mean Reversion:long"
        | "Mean Reversion:short"
        | "Pullback Continuation:long"
        | "Pullback Continuation:short"
        | "Failed Bounce:short"
        | "Failed Breakdown:long"
        | "Capitulation Bounce:long"
        | "Capitulation Bounce:short";
    score: number;
    reasons: string[];
    risks: string[];
};

export function classifySetups(input: {
    structure: MarketStructure;
    executionCostBps?: number | null;
    depthUsd?: number | null;
}): SetupSignal[] {
    const signals: SetupSignal[] = [];
    const structure = input.structure;
    const impulseBps = structure.impulse.impulseBps;
    const volumeSpike = structure.volume.volumeSpike;
    const rangeExpansion = (structure.range.rangeExpansionRatio ?? 0) >= 1.4;
    const pressure = structure.participation.bookPressure ?? 0;
    const risks = executionRisks(input.executionCostBps, input.depthUsd);

    if (structure.impulse.direction === "up" && impulseBps >= 150) {
        const reasons = ["IMPULSE_UP"];
        if (volumeSpike) reasons.push("VOLUME_SPIKE");
        if (rangeExpansion) reasons.push("RANGE_EXPANSION");
        if (structure.impulse.followThrough) reasons.push("FOLLOW_THROUGH");

        signals.push({
            setupType: rangeExpansion ? "BREAKOUT_EXPANSION" : "MOMENTUM_CONTINUATION",
            side: "long",
            playbook: rangeExpansion ? "Breakout:long" : "Momentum:long",
            score: setupScore(55, impulseBps, volumeSpike, rangeExpansion, structure.impulse.followThrough, pressure > 0.15),
            reasons,
            risks
        });

        if (structure.impulse.stalled && pressure < -0.05) {
            signals.push({
                setupType: "FAILED_BREAKOUT",
                side: "short",
                playbook: "Failed Bounce:short",
                score: setupScore(45, impulseBps * 0.6, volumeSpike, rangeExpansion, false, true),
                reasons: ["IMPULSE_UP", "STALL", "SELLER_PRESSURE_RETURNED"],
                risks
            });
        }
    }

    if (structure.impulse.direction === "down" && impulseBps >= 150) {
        const reasons = ["IMPULSE_DOWN"];
        if (volumeSpike) reasons.push("VOLUME_SPIKE");
        if (rangeExpansion) reasons.push("RANGE_EXPANSION");
        if (structure.impulse.followThrough) reasons.push("FOLLOW_THROUGH");

        signals.push({
            setupType: "MOMENTUM_CONTINUATION",
            side: "short",
            playbook: "Momentum:short",
            score: setupScore(55, impulseBps, volumeSpike, rangeExpansion, structure.impulse.followThrough, pressure < -0.15),
            reasons,
            risks
        });

        if (structure.impulse.stalled || pressure >= 0.05) {
            signals.push({
                setupType: "FAILED_BOUNCE",
                side: "short",
                playbook: "Failed Bounce:short",
                score: setupScore(50, impulseBps * 0.7, volumeSpike, rangeExpansion, false, pressure <= 0),
                reasons: ["IMPULSE_DOWN", "BOUNCE_STALLED"],
                risks
            });
        }

        if (volumeSpike && !structure.impulse.followThrough && pressure > 0.1) {
            signals.push({
                setupType: "CAPITULATION_BOUNCE",
                side: "long",
                playbook: "Capitulation Bounce:long",
                score: setupScore(48, impulseBps * 0.6, true, rangeExpansion, false, true),
                reasons: ["IMPULSE_DOWN", "VOLUME_SPIKE", "SELLING_PRESSURE_FADING"],
                risks: [...risks, "COUNTER_TREND"]
            });
        }
    }

    const quietRange = impulseBps < 150 && (structure.range.rangeExpansionRatio ?? 0) < 1.3;
    if (quietRange && Math.abs(pressure) >= 0.15) {
        const side = pressure > 0 ? "long" : "short";
        signals.push({
            setupType: "MEAN_REVERSION_RANGE",
            side,
            playbook: side === "long" ? "Mean Reversion:long" : "Mean Reversion:short",
            score: Math.min(70, 45 + Math.abs(pressure) * 50),
            reasons: ["RANGE_BEHAVIOR", pressure > 0 ? "BUYER_PRESSURE" : "SELLER_PRESSURE"],
            risks
        });
    }

    return signals
        .map(signal => ({ ...signal, score: round(Math.max(0, Math.min(100, signal.score))) }))
        .sort((a, b) => b.score - a.score);
}

function setupScore(
    base: number,
    impulseBps: number,
    volumeSpike: boolean,
    rangeExpansion: boolean,
    followThrough: boolean,
    pressureConfirms: boolean
): number {
    return base +
        Math.min(18, impulseBps / 60) +
        (volumeSpike ? 8 : 0) +
        (rangeExpansion ? 8 : 0) +
        (followThrough ? 6 : 0) +
        (pressureConfirms ? 5 : 0);
}

function executionRisks(executionCostBps?: number | null, depthUsd?: number | null): string[] {
    const risks: string[] = [];
    if ((executionCostBps ?? 0) >= 18) risks.push("EXECUTION_COST_HIGH");
    if ((depthUsd ?? Infinity) < 25_000) risks.push("DEPTH_WEAK");
    return risks;
}

function round(value: number): number {
    return parseFloat(value.toFixed(2));
}
