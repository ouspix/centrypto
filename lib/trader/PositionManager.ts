import type { AgentConfig } from "@/lib/agent-config";
import {
    basePlaybookFrom,
    DEFAULT_POSITION_MANAGEMENT_CONFIG,
    mergePositionManagementConfig,
    resolvePositionPolicy
} from "@/lib/trader/position-management-policy";
import {
    betterStopPrice,
    breakevenStopPrice,
    capStopPrice,
    capTakeProfitPrice,
    isStopWorseThan,
    liquidationDistancePct,
    stopDistanceBps,
    takeProfitDistanceBps,
    trailingStopPrice
} from "@/lib/trader/position-management-math";
import type {
    ManagedLifecycleState,
    ManagedOpenOrder,
    PositionLifecycleState,
    PositionManagementAction,
    PositionManagementActionName,
    PositionManagementConfig,
    PositionManagementEvidence,
    PositionManagementInput,
    PositionManagementReasonCode,
    PositionManagementResolvedPolicy,
    PositionManagementResult,
    PositionManagementUrgency
} from "@/lib/trader/position-management-types";
import type { StateSnapshot } from "@/types/snapshot";
import type { TradeDecision } from "@/types/trading";

export class PositionManager {
    constructor(private readonly policy: PositionManagementConfig = DEFAULT_POSITION_MANAGEMENT_CONFIG) {}

    public evaluate(input: PositionManagementInput): PositionManagementResult {
        const config = mergePositionManagementConfig(input.config.position_management, this.policy);
        if (!config.enabled) {
            return {
                actions: [],
                portfolioFlags: { blockNewEntries: false, reasonCodes: [] },
                diagnostics: { evaluatedPositions: 0, urgentActionCount: 0, repairActionCount: 0, holdCount: 0 }
            };
        }

        const actions = input.openLifecycles.map(position => {
            const policy = resolvePositionPolicy(position.basePlaybook, position.currentRegime, config);
            return this.evaluatePosition(position, input.openOrders, policy, config, input.now);
        });
        const blockReasons = new Set<string>();
        for (const action of actions) {
            if (blocksNewEntries(action, config)) blockReasons.add(action.reasonCode);
        }

        return {
            actions,
            portfolioFlags: {
                blockNewEntries: blockReasons.size > 0,
                reasonCodes: Array.from(blockReasons)
            },
            diagnostics: {
                evaluatedPositions: actions.length,
                urgentActionCount: actions.filter(action => action.bypassLlm && !isPassiveAction(action.action)).length,
                repairActionCount: actions.filter(action => isRepairAction(action.action)).length,
                holdCount: actions.filter(action => action.action === "HOLD_POSITION" || action.action === "NO_ACTION").length
            }
        };
    }

    private evaluatePosition(
        position: ManagedLifecycleState,
        openOrders: ManagedOpenOrder[],
        policy: PositionManagementResolvedPolicy,
        config: PositionManagementConfig,
        now: Date
    ): PositionManagementAction {
        const orders = openOrdersForPosition(openOrders, position.symbol, position.side);
        const orderState = resolveOrderState(position, orders);
        const stateBefore = resolveLifecycleState(position, policy);
        const evidence = this.buildEvidence(position, orderState, policy);
        const protectAfterMfeBps = hardProtectAfterMfeBps(policy);
        const partialAfterMfeBps = hardPartialAfterMfeBps(policy);
        const givebackAfterMfeBps = hardGivebackAfterMfeBps(policy);
        const maxGivebackPct = hardMaxGivebackPct(policy);

        if (!policy.enabled) {
            return this.action(position, stateBefore, stateBefore, "NO_ACTION", "LOW", false, "HOLD_WITH_SUPPORT", "position management disabled by policy", evidence);
        }

        if (!hasRequiredData(position)) {
            return this.action(position, stateBefore, stateBefore, "NO_ACTION", "LOW", false, "INSUFFICIENT_DATA", "missing entry price, current price, or size", evidence);
        }

        if (position.netCurrentBps <= -policy.hardStopBps || (position.maeBps !== null && position.maeBps <= -policy.hardStopBps)) {
            return this.action(position, stateBefore, "EXIT_NOW", "CLOSE_POSITION", "EMERGENCY", true, "EMERGENCY_MAX_LOSS", "hard stop breached", evidence);
        }

        const liqDistance = liquidationDistancePct(position.side, position.currentPrice, position.liquidationPrice);
        if (liqDistance !== null && liqDistance < config.global.liquidationDistanceMinPct) {
            return this.action(position, stateBefore, "EXIT_NOW", "CLOSE_POSITION", "EMERGENCY", true, "LIQUIDATION_RISK", "position is too close to liquidation", evidence);
        }

        if (isCoolingDown(position, now, config) && !isHardExit(position, policy)) {
            return this.action(position, "COOLDOWN", "COOLDOWN", "HOLD_POSITION", "LOW", false, "POSITION_TOO_NEW", "position manager is waiting for state to refresh after a recent action", evidence);
        }

        if (stateBefore !== "NEW" && !orderState.hasStop && policy.repairMissingStop) {
            if (position.netCurrentBps < 0) {
                return this.action(position, stateBefore, "EXIT_NOW", "CLOSE_POSITION", "HIGH", true, "MISSING_PROTECTIVE_STOP", "position is red and has no protective stop", evidence);
            }
            return this.action(position, stateBefore, "COOLDOWN", "PLACE_BREAKEVEN_STOP", "HIGH", true, "MISSING_PROTECTIVE_STOP", "live position has no protective stop", evidence, {
                stopReplacement: breakevenStopReplacement(position, policy, orderState, "missing protective stop")
            });
        }

        if ((position.mfeBps ?? 0) >= protectAfterMfeBps && position.netCurrentBps < 0) {
            return this.action(position, stateBefore, "EXIT_NOW", "CLOSE_POSITION", "HIGH", true, "OPEN_WAS_GREEN_NOW_RED", "trade had sufficient MFE and is now net red", evidence);
        }

        const breakevenPx = breakevenStopPrice(position.side, position.entryPrice, policy.breakevenBufferBps);
        if ((position.mfeBps ?? 0) >= protectAfterMfeBps && isStopWorseThan(position.side, orderState.currentStopPx, breakevenPx)) {
            return this.action(position, stateBefore, "COOLDOWN", orderState.hasStop ? "REPLACE_STOP" : "PLACE_BREAKEVEN_STOP", "HIGH", true, "BREAKEVEN_PROTECTION", "green trade requires fee-adjusted breakeven protection", evidence, {
                stopReplacement: breakevenStopReplacement(position, policy, orderState, "breakeven protection")
            });
        }

        if (position.ageMinutes >= policy.discoveryTimeStopMinutes && position.netCurrentBps <= 0) {
            const reason = position.basePlaybook === "Mean Reversion" ? "MEAN_REVERSION_FAILED" : "TIME_STOP_NOT_GREEN";
            return this.action(position, stateBefore, "EXIT_NOW", "CLOSE_POSITION", "HIGH", true, reason, "position failed to become net green before time stop", evidence);
        }

        const staleTp = orderState.takeProfitDistanceBps !== null && orderState.takeProfitDistanceBps > policy.maxAllowedTakeProfitBps + config.global.staleOrderToleranceBps;
        if (staleTp && policy.repairStaleTakeProfit) {
            return this.action(position, stateBefore, "COOLDOWN", "REPLACE_TAKE_PROFIT", "NORMAL", true, "STALE_TAKE_PROFIT", "take-profit order is outside playbook/regime cap", evidence, {
                takeProfitReplacement: {
                    takeProfitPx: round8(capTakeProfitPrice(position.side, position.entryPrice, policy.maxAllowedTakeProfitBps)),
                    reason: "capped take profit",
                    cancelExistingTakeProfitOids: orderState.takeProfitOids
                }
            });
        }

        const staleStop = orderState.stopDistanceBps !== null && orderState.stopDistanceBps > policy.maxAllowedStopLossBps + config.global.staleOrderToleranceBps;
        if (staleStop) {
            const cappedStop = capStopPrice(position.side, position.entryPrice, policy.maxAllowedStopLossBps);
            const stopPx = (position.mfeBps ?? 0) >= protectAfterMfeBps
                ? betterStopPrice(position.side, cappedStop, breakevenPx)
                : cappedStop;
            return this.action(position, stateBefore, "COOLDOWN", "REPLACE_STOP", "NORMAL", true, "STALE_STOP", "stop-loss order is outside playbook/regime cap", evidence, {
                stopReplacement: {
                    stopPx: round8(stopPx),
                    reason: "capped stop",
                    cancelExistingStopOids: orderState.stopOids
                }
            });
        }

        if ((position.mfeBps ?? 0) >= partialAfterMfeBps && partialTakenFraction(position) < policy.partialCloseFraction) {
            return this.reduceAction(position, stateBefore, policy.partialCloseFraction, "PARTIAL_TP_AFTER_MFE", "position reached deterministic partial-profit threshold", evidence);
        }

        if ((position.mfeBps ?? 0) >= givebackAfterMfeBps && (position.givebackPct ?? 0) >= maxGivebackPct) {
            if (position.netCurrentBps <= policy.breakevenBufferBps || partialTakenFraction(position) >= policy.partialCloseFraction || policy.allowRunner) {
                return this.action(position, stateBefore, "EXIT_NOW", "CLOSE_POSITION", "HIGH", true, "MFE_GIVEBACK_LIMIT", "MFE giveback exceeded policy limit", evidence);
            }
            return this.reduceAction(position, stateBefore, Math.max(0.5, policy.partialCloseFraction), "MFE_GIVEBACK_LIMIT", "MFE giveback exceeded policy limit", evidence);
        }

        if ((position.mfeBps ?? 0) >= policy.trailingActivationMfeBps) {
            const trailPx = betterStopPrice(
                position.side,
                trailingStopPrice(position.side, position.currentPrice, policy.trailingDistanceBps),
                breakevenPx
            );
            if (isStopWorseThan(position.side, orderState.currentStopPx, trailPx)) {
                return this.action(position, stateBefore, "COOLDOWN", "REPLACE_STOP", "NORMAL", true, "TRAILING_STOP_HIT", "runner stop should trail without loosening protection", evidence, {
                    stopReplacement: {
                        stopPx: round8(trailPx),
                        reason: "trailing runner protection",
                        cancelExistingStopOids: orderState.stopOids
                    }
                });
            }
        }

        if (position.ageMinutes >= policy.profitableTimeStopMinutes && position.netCurrentBps > 0 && !mfeImproving(position)) {
            if (policy.allowRunner && partialTakenFraction(position) >= policy.partialCloseFraction) {
                return this.action(position, stateBefore, "EXIT_NOW", "CLOSE_POSITION", "NORMAL", true, "TIME_STOP_STALE_GREEN", "profitable runner stopped improving within policy time", evidence);
            }
            return this.reduceAction(position, stateBefore, Math.max(0.5, policy.partialCloseFraction), "TIME_STOP_STALE_GREEN", "profitable position stopped improving within policy time", evidence);
        }

        const invalidation = thesisInvalidation(position, policy);
        if (invalidation) {
            const action = position.netCurrentBps <= policy.breakevenBufferBps ? "CLOSE_POSITION" : "REDUCE_POSITION";
            if (action === "CLOSE_POSITION") {
                return this.action(position, stateBefore, "EXIT_NOW", "CLOSE_POSITION", "HIGH", true, invalidation, "position thesis/regime invalidated", evidence);
            }
            return this.reduceAction(position, stateBefore, Math.max(0.5, policy.partialCloseFraction), invalidation, "position thesis/regime invalidated", evidence);
        }

        if (stateBefore === "NEW") {
            return this.action(position, stateBefore, stateBefore, "HOLD_POSITION", "LOW", false, "POSITION_TOO_NEW", "position is too new for normal management", evidence);
        }

        return this.action(position, stateBefore, stateBefore, "HOLD_POSITION", "LOW", false, orderState.hasStop || orderState.hasTakeProfit ? "ORDER_STATE_OK" : "HOLD_WITH_SUPPORT", "position remains inside deterministic management limits", evidence);
    }

    private reduceAction(
        position: ManagedLifecycleState,
        stateBefore: PositionLifecycleState,
        reduceFraction: number,
        reasonCode: PositionManagementReasonCode,
        notes: string,
        evidence: PositionManagementEvidence
    ): PositionManagementAction {
        const fraction = clamp(reduceFraction, 0.01, 1);
        return this.action(position, stateBefore, "COOLDOWN", "REDUCE_POSITION", "NORMAL", true, reasonCode, notes, evidence, {
            reduceFraction: fraction,
            targetSizeFractionOfEquity: round6(position.exposureFraction * (1 - fraction))
        });
    }

    private action(
        position: ManagedLifecycleState,
        stateBefore: PositionLifecycleState,
        stateAfter: PositionLifecycleState,
        action: PositionManagementActionName,
        urgency: PositionManagementUrgency,
        bypassLlm: boolean,
        reasonCode: PositionManagementReasonCode,
        notes: string,
        evidence: PositionManagementEvidence,
        extras: Partial<Pick<PositionManagementAction, "targetSizeFractionOfEquity" | "reduceFraction" | "stopReplacement" | "takeProfitReplacement" | "cancelOrderOids">> = {}
    ): PositionManagementAction {
        return {
            source: "POSITION_MANAGER",
            lifecycleId: position.lifecycleId,
            symbol: position.symbol,
            side: position.side,
            stateBefore,
            stateAfter,
            action,
            urgency,
            bypassLlm,
            reasonCode,
            notes,
            ...extras,
            evidence
        };
    }

    private buildEvidence(
        position: ManagedLifecycleState,
        orderState: OrderState,
        policy: PositionManagementResolvedPolicy
    ): PositionManagementEvidence {
        return {
            ageMinutes: round4(position.ageMinutes),
            entryPrice: position.entryPrice,
            currentPrice: position.currentPrice,
            grossCurrentBps: round4(position.grossCurrentBps),
            netCurrentBps: round4(position.netCurrentBps),
            mfeBps: nullableRound4(position.mfeBps),
            maeBps: nullableRound4(position.maeBps),
            givebackPct: nullableRound4(position.givebackPct),
            currentUnrealizedPnlUsd: round4(position.currentUnrealizedPnlUsd),
            peakUnrealizedPnlUsd: nullableRound4(position.peakUnrealizedPnlUsd),
            drawdownFromPeakUsd: nullableRound4(position.drawdownFromPeakUsd),
            estimatedFeeBps: round4(position.estimatedFeeBps),
            playbook: position.playbook,
            basePlaybook: position.basePlaybook,
            currentRegime: position.currentRegime,
            marketTags: position.marketTags,
            bookPressure: position.marketSignal.bookPressure,
            bookPressureAlignment: position.marketSignal.bookPressureAlignment,
            trendAligned: position.marketSignal.trendAligned,
            hasStop: orderState.hasStop,
            hasTakeProfit: orderState.hasTakeProfit,
            currentStopPx: orderState.currentStopPx,
            currentTakeProfitPx: orderState.currentTakeProfitPx,
            stopDistanceBps: nullableRound4(orderState.stopDistanceBps),
            takeProfitDistanceBps: nullableRound4(orderState.takeProfitDistanceBps),
            policy
        };
    }
}

export function convertManagerActionToTradeDecision(action: PositionManagementAction, config: AgentConfig): TradeDecision | null {
    if (action.action !== "CLOSE_POSITION" && action.action !== "REDUCE_POSITION") return null;
    const targetSide = action.action === "CLOSE_POSITION" ? "flat" : action.side;
    const targetFraction = action.action === "CLOSE_POSITION"
        ? 0
        : action.targetSizeFractionOfEquity ?? 0;

    return {
        scope: "position",
        candidate_id: null,
        action: action.action,
        symbol: action.symbol,
        side: targetSide === "flat" ? null : action.side,
        target_side: targetSide,
        target_size_fraction_of_equity: targetFraction,
        size_fraction_of_equity: targetFraction,
        risk_plan: null,
        playbook: "position_manager",
        confidence: config.management_policy.close_confidence ?? 1,
        reason_code: action.reasonCode,
        notes: action.notes,
        audit: {
            regime: action.evidence.currentRegime,
            position_manager: action
        }
    };
}

export function lockedSymbolsFromPositionManagement(result: PositionManagementResult): Set<string> {
    return new Set(result.actions
        .filter(action => action.bypassLlm && !isPassiveAction(action.action))
        .map(action => action.symbol));
}

export { basePlaybookFrom, DEFAULT_POSITION_MANAGEMENT_CONFIG, mergePositionManagementConfig };
export type {
    ManagedLifecycleState,
    ManagedOpenOrder,
    PositionLifecycleState,
    PositionManagementAction,
    PositionManagementConfig,
    PositionManagementInput,
    PositionManagementResult
};

type OrderState = {
    hasStop: boolean;
    hasTakeProfit: boolean;
    currentStopPx: number | null;
    currentTakeProfitPx: number | null;
    stopDistanceBps: number | null;
    takeProfitDistanceBps: number | null;
    stopOids: string[];
    takeProfitOids: string[];
};

function resolveLifecycleState(position: ManagedLifecycleState, policy: PositionManagementResolvedPolicy): PositionLifecycleState {
    const protectAfterMfeBps = hardProtectAfterMfeBps(policy);
    const partialAfterMfeBps = hardPartialAfterMfeBps(policy);
    if (position.ageMinutes < policy.minAgeBeforeManagementMinutes) return "NEW";
    if (position.netCurrentBps <= -policy.hardStopBps || ((position.mfeBps ?? 0) >= protectAfterMfeBps && position.netCurrentBps < 0)) return "EXIT_NOW";
    if (partialTakenFraction(position) >= policy.partialCloseFraction || (position.mfeBps ?? 0) >= policy.trailingActivationMfeBps) return "TRAILING";
    if ((position.mfeBps ?? 0) >= partialAfterMfeBps) return "HARVESTING";
    if ((position.mfeBps ?? 0) >= protectAfterMfeBps) return "PROTECTED";
    return "DISCOVERY";
}

function resolveOrderState(position: ManagedLifecycleState, orders: ManagedOpenOrder[]): OrderState {
    const stopOrders = orders.filter(order => order.orderRole === "STOP_LOSS" && order.reduceOnly);
    const tpOrders = orders.filter(order => order.orderRole === "TAKE_PROFIT" && order.reduceOnly);
    const currentStopPx = bestStopPx(position.side, stopOrders);
    const currentTakeProfitPx = bestTakeProfitPx(position.side, tpOrders);
    return {
        hasStop: stopOrders.length > 0 && currentStopPx !== null,
        hasTakeProfit: tpOrders.length > 0 && currentTakeProfitPx !== null,
        currentStopPx,
        currentTakeProfitPx,
        stopDistanceBps: stopDistanceBps(position.side, position.entryPrice, currentStopPx),
        takeProfitDistanceBps: takeProfitDistanceBps(position.side, position.entryPrice, currentTakeProfitPx),
        stopOids: stopOrders.map(order => order.oid ?? order.cloid ?? "").filter(Boolean),
        takeProfitOids: tpOrders.map(order => order.oid ?? order.cloid ?? "").filter(Boolean)
    };
}

function openOrdersForPosition(orders: ManagedOpenOrder[], symbol: string, side: string): ManagedOpenOrder[] {
    return orders.filter(order =>
        order.symbol === symbol &&
        (order.positionSide === null || order.positionSide === side) &&
        order.status !== "UNKNOWN"
    );
}

function bestStopPx(side: "long" | "short", orders: ManagedOpenOrder[]): number | null {
    const prices = orders.map(order => finite(order.triggerPx) ?? finite(order.px)).filter((price): price is number => price !== null && price > 0);
    if (!prices.length) return null;
    return side === "long" ? Math.max(...prices) : Math.min(...prices);
}

function bestTakeProfitPx(side: "long" | "short", orders: ManagedOpenOrder[]): number | null {
    const prices = orders.map(order => finite(order.triggerPx) ?? finite(order.px)).filter((price): price is number => price !== null && price > 0);
    if (!prices.length) return null;
    return side === "long" ? Math.min(...prices) : Math.max(...prices);
}

function breakevenStopReplacement(
    position: ManagedLifecycleState,
    policy: PositionManagementResolvedPolicy,
    orderState: OrderState,
    reason: string
): NonNullable<PositionManagementAction["stopReplacement"]> {
    return {
        stopPx: round8(breakevenStopPrice(position.side, position.entryPrice, policy.breakevenBufferBps)),
        reason,
        cancelExistingStopOids: orderState.stopOids
    };
}

function hasRequiredData(position: ManagedLifecycleState): boolean {
    return position.entryPrice > 0 && position.currentPrice > 0 && (position.sizeUsd > 0 || position.sizeCoin > 0);
}

function isHardExit(position: ManagedLifecycleState, policy: PositionManagementResolvedPolicy): boolean {
    return position.netCurrentBps <= -policy.hardStopBps ||
        ((position.mfeBps ?? 0) >= hardProtectAfterMfeBps(policy) && position.netCurrentBps < 0);
}

function isCoolingDown(position: ManagedLifecycleState, now: Date, config: PositionManagementConfig): boolean {
    const lastActionAt = position.priorManagementState?.lastActionAt ? new Date(position.priorManagementState.lastActionAt).getTime() : NaN;
    if (!Number.isFinite(lastActionAt)) return false;
    return now.getTime() - lastActionAt < config.global.minSecondsBetweenActionsPerPosition * 1000;
}

function partialTakenFraction(position: ManagedLifecycleState): number {
    const fraction = finite(position.priorManagementState?.partialTakenFraction);
    return fraction === null ? 0 : clamp(fraction, 0, 1);
}

function mfeImproving(position: ManagedLifecycleState): boolean {
    const prior = finite(position.priorManagementState?.highestMfeBps);
    if (prior === null || position.mfeBps === null) return (position.givebackPct ?? 0) < 25;
    return position.mfeBps > prior + 0.5;
}

function thesisInvalidation(position: ManagedLifecycleState, policy: PositionManagementResolvedPolicy): PositionManagementReasonCode | null {
    const oppositePressure = position.marketSignal.bookPressureAlignment === "opposite";
    const entryFailed = position.marketSignal.entryOk === false;
    const riskFailed = position.marketSignal.riskEligible === false;
    const regimeChanged = position.regimeAtEntry && position.regimeAtEntry !== position.currentRegime;

    if (policy.closeOnRegimeConflict && regimeChanged) {
        if (position.basePlaybook === "Momentum" && position.currentRegime === "RISK_OFF" && position.side === "short") return null;
        return "REGIME_INVALIDATION";
    }

    if (position.basePlaybook === "Mean Reversion") {
        if (oppositePressure && position.netCurrentBps <= 0) return "MEAN_REVERSION_FAILED";
        if (position.marketTags.includes("bb_expansion") && position.netCurrentBps <= policy.breakevenBufferBps) return "MEAN_REVERSION_FAILED";
        if (entryFailed && riskFailed && oppositePressure) return "THESIS_INVALIDATED";
    }

    if (position.basePlaybook === "Momentum") {
        if (position.marketSignal.trendAligned === false && oppositePressure && (position.givebackPct ?? 0) > 40) return "MOMENTUM_FAILED";
    }

    if (position.basePlaybook === "Breakout") {
        const volCollapsed = (position.marketSignal.volRatio5mVs1h ?? 1) < 1;
        if ((entryFailed || riskFailed) && oppositePressure && volCollapsed) return "BREAKOUT_FAILED";
    }

    if (policy.closeOnThesisInvalidation && entryFailed && riskFailed && oppositePressure) return "THESIS_INVALIDATED";
    return null;
}

function blocksNewEntries(action: PositionManagementAction, config: PositionManagementConfig): boolean {
    if (!config.global.blockNewEntriesWhenUrgentExit) return false;
    if (action.urgency === "EMERGENCY") return true;
    if (action.urgency === "HIGH" && action.bypassLlm && !isPassiveAction(action.action)) return true;
    return action.reasonCode === "OPEN_WAS_GREEN_NOW_RED" || action.reasonCode === "MISSING_PROTECTIVE_STOP";
}

function isPassiveAction(action: PositionManagementActionName): boolean {
    return action === "HOLD_POSITION" || action === "NO_ACTION";
}

function isRepairAction(action: PositionManagementActionName): boolean {
    return action === "PLACE_BREAKEVEN_STOP" ||
        action === "REPLACE_STOP" ||
        action === "REPLACE_TAKE_PROFIT" ||
        action === "REPLACE_BRACKET" ||
        action === "CANCEL_STALE_ORDER";
}

function hardProtectAfterMfeBps(policy: PositionManagementResolvedPolicy): number {
    return Math.min(policy.protectAfterMfeBps, 20);
}

function hardPartialAfterMfeBps(policy: PositionManagementResolvedPolicy): number {
    return Math.min(policy.partialTakeProfitAfterMfeBps, 50);
}

function hardGivebackAfterMfeBps(policy: PositionManagementResolvedPolicy): number {
    return Math.max(35, hardProtectAfterMfeBps(policy));
}

function hardMaxGivebackPct(policy: PositionManagementResolvedPolicy): number {
    return Math.min(policy.maxGivebackPct, 60);
}

function finite(value: unknown): number | null {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function nullableRound4(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? round4(value) : null;
}

function round4(value: number): number {
    return Math.round(value * 10000) / 10000;
}

function round6(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
}

function round8(value: number): number {
    return Math.round(value * 100_000_000) / 100_000_000;
}
