/**
 * Shared risk utility functions used by both OrchestratorService and RiskCheckModule.
 * Extracted to eliminate duplication.
 */

import { AgentConfig } from "@/lib/agent-config";
import { MarketEntry, GlobalRegime } from "@/types/snapshot";
import { TradeDecision } from "@/types/trading";

export type RiskPlanCaps = { sl_bps: number; tp_bps: number };
export type RiskPlanFloors = { sl_bps: number; tp_bps: number };

export const DEFAULT_RISK_PLAN_CAPS: Record<string, Partial<Record<GlobalRegime["current"] | "DEFAULT", RiskPlanCaps>>> = {
    Momentum: {
        RISK_ON: { sl_bps: 120, tp_bps: 240 },
        RISK_OFF: { sl_bps: 100, tp_bps: 180 },
        CHOP: { sl_bps: 80, tp_bps: 120 }
    },
    Breakout: {
        RISK_ON: { sl_bps: 150, tp_bps: 300 },
        RISK_OFF: { sl_bps: 120, tp_bps: 220 },
        CHOP: { sl_bps: 90, tp_bps: 150 }
    },
    "Mean Reversion": {
        RISK_ON: { sl_bps: 80, tp_bps: 120 },
        RISK_OFF: { sl_bps: 70, tp_bps: 100 },
        CHOP: { sl_bps: 50, tp_bps: 80 }
    },
    DEFAULT: {
        DEFAULT: { sl_bps: 100, tp_bps: 200 }
    }
};

export const DEFAULT_RISK_PLAN_FLOORS: Record<string, Partial<Record<GlobalRegime["current"] | "DEFAULT", RiskPlanFloors>>> = {
    "Mean Reversion": {
        CHOP: { sl_bps: 30, tp_bps: 45 },
        RISK_ON: { sl_bps: 35, tp_bps: 55 },
        RISK_OFF: { sl_bps: 30, tp_bps: 45 }
    },
    Momentum: {
        CHOP: { sl_bps: 50, tp_bps: 80 },
        RISK_ON: { sl_bps: 60, tp_bps: 100 },
        RISK_OFF: { sl_bps: 50, tp_bps: 90 }
    },
    DEFAULT: {
        DEFAULT: { sl_bps: 10, tp_bps: 20 }
    }
};

/**
 * Traverse an object by dot-separated path and return the numeric value, or null.
 */
export function getValueByPath(obj: any, path: string): number | null {
    const parts = path.split(".");
    let current: any = obj;

    for (const part of parts) {
        if (current && Object.prototype.hasOwnProperty.call(current, part)) {
            current = current[part];
        } else {
            return null;
        }
    }

    if (typeof current !== "number" || Number.isNaN(current)) return null;
    return current;
}

/**
 * Resolve the best volatility anchor for a market using the configured priority list.
 */
export function resolveAnchor(market: MarketEntry | any, config: AgentConfig): { key: string | null, value: number | null } {
    const priority = config.risk_plan_model.vol_anchor_priority;
    if (
        market?.derived?.risk?.best_anchor_key &&
        priority.includes(market.derived.risk.best_anchor_key) &&
        market?.derived?.risk?.best_anchor_value !== undefined &&
        market?.derived?.risk?.best_anchor_value !== null
    ) {
        return { key: market.derived.risk.best_anchor_key, value: market.derived.risk.best_anchor_value };
    }

    for (const key of priority) {
        const raw = getValueByPath(market, key);
        if (raw === null) continue;
        const value = key.includes("bps") ? raw / 10000 : raw;
        return { key, value };
    }

    return { key: null, value: null };
}

/**
 * Compute a size as a fraction of equity using confidence buckets, clamped to per-trade and per-symbol caps.
 */
export function computeSizeFraction(confidence: number, config: AgentConfig, equity: number): number | null {
    if (!equity || equity <= 0) return null;

    const risk = config.risk;
    const perTradeCap = risk.max_position_fraction ?? risk.max_position_fraction_per_symbol ?? 0;
    const perSymbolCap = risk.max_position_fraction_per_symbol ?? risk.max_position_fraction ?? 0;
    const hardCap = perTradeCap > 0 && perSymbolCap > 0 ? Math.min(perTradeCap, perSymbolCap) : Math.max(perTradeCap, perSymbolCap);
    if (hardCap <= 0) return null;

    const exposureBudget = Math.min(hardCap, risk.max_total_exposure_fraction ?? hardCap);
    const riskFactor = Math.max(0, Math.min(1, confidence ?? 0));
    const scaled = exposureBudget * (0.30 + 0.70 * riskFactor); // 30%-100% of budget driven by confidence

    const minTradeFraction = (risk.min_trade_notional_usd ?? 0) / equity;
    const target = Math.max(scaled, minTradeFraction);

    return Math.min(target, hardCap);
}

/**
 * Clamp a decision's risk plan to enforce SL/TP bounds and minimum risk-reward ratio.
 */
export function clampRiskPlan(
    decision: TradeDecision,
    options: { config?: AgentConfig; regime?: GlobalRegime["current"] } = {}
): void {
    if (!decision.risk_plan) return;
    const minRr = 1.5;

    const sl = decision.risk_plan.stop_loss_pct;
    if (sl === undefined || sl === null) return;
    const auditRegime = decision.audit?.regime as GlobalRegime["current"] | undefined;
    const bounded = applyRiskPlanWidthBounds({
        playbook: decision.playbook,
        regime: options.regime ?? auditRegime,
        config: options.config,
        stopLossPct: Math.abs(sl),
        takeProfitPct: Math.abs(decision.risk_plan.take_profit_pct_primary ?? 0),
        minRr
    });
    decision.risk_plan.stop_loss_pct = bounded.stop_loss_pct;
    decision.risk_plan.take_profit_pct_primary = bounded.take_profit_pct_primary;
}

/**
 * Compute a risk plan (stop loss + take profit) from market anchor, playbook multipliers, and regime adjustments.
 */
export function computeRiskPlan(
    playbook: string,
    market: MarketEntry | any,
    config: AgentConfig,
    regime: GlobalRegime["current"],
    _exchangeLeverageCeiling: number
): { stop_loss_pct: number; take_profit_pct_primary: number } | null {
    const anchor = resolveAnchor(market, config);
    if (!anchor.value || anchor.value <= 0) return null;

    const basePlaybook = (playbook || "").split(":")[0]?.trim() || "Discretionary Edge";
    const multipliers = config.risk_plan_model.multipliers_by_playbook?.[basePlaybook] || { sl_mult: 1, tp_mult: 2 };
    const regimeAdj = config.risk_plan_model.regime_adjustments?.[regime] || { sl_mult_factor: 1, tp_mult_factor: 1 };

    const rawStopLossPct = anchor.value * (multipliers.sl_mult ?? 1) * (regimeAdj.sl_mult_factor ?? 1);
    const rawTakeProfitPct = anchor.value * (multipliers.tp_mult ?? 2) * (regimeAdj.tp_mult_factor ?? 1);
    return applyRiskPlanWidthBounds({
        playbook: basePlaybook,
        regime,
        config,
        stopLossPct: rawStopLossPct,
        takeProfitPct: rawTakeProfitPct,
        minRr: 1.5
    });
}

export function resolveRiskPlanCaps(
    playbook: string | null | undefined,
    regime: GlobalRegime["current"] | undefined,
    config?: AgentConfig
): RiskPlanCaps {
    const basePlaybook = (playbook || "").split(":")[0]?.trim() || "DEFAULT";
    const configured = config?.risk_plan_model.max_width_bps_by_playbook;
    return configured?.[basePlaybook]?.[regime ?? "DEFAULT"] ??
        configured?.[basePlaybook]?.DEFAULT ??
        configured?.DEFAULT?.[regime ?? "DEFAULT"] ??
        configured?.DEFAULT?.DEFAULT ??
        DEFAULT_RISK_PLAN_CAPS[basePlaybook]?.[regime ?? "DEFAULT"] ??
        DEFAULT_RISK_PLAN_CAPS[basePlaybook]?.DEFAULT ??
        DEFAULT_RISK_PLAN_CAPS.DEFAULT.DEFAULT!;
}

export function resolveRiskPlanFloors(
    playbook: string | null | undefined,
    regime: GlobalRegime["current"] | undefined,
    config?: AgentConfig
): RiskPlanFloors {
    const basePlaybook = (playbook || "").split(":")[0]?.trim() || "DEFAULT";
    const configured = config?.risk_plan_model.min_width_bps_by_playbook;
    return configured?.[basePlaybook]?.[regime ?? "DEFAULT"] ??
        configured?.[basePlaybook]?.DEFAULT ??
        configured?.DEFAULT?.[regime ?? "DEFAULT"] ??
        configured?.DEFAULT?.DEFAULT ??
        DEFAULT_RISK_PLAN_FLOORS[basePlaybook]?.[regime ?? "DEFAULT"] ??
        DEFAULT_RISK_PLAN_FLOORS[basePlaybook]?.DEFAULT ??
        DEFAULT_RISK_PLAN_FLOORS.DEFAULT.DEFAULT!;
}

function applyRiskPlanWidthBounds(input: {
    playbook: string | null | undefined;
    regime: GlobalRegime["current"] | undefined;
    config?: AgentConfig;
    stopLossPct: number;
    takeProfitPct: number;
    minRr: number;
}): { stop_loss_pct: number; take_profit_pct_primary: number } {
    const caps = normalizeCapsForMinRr(resolveRiskPlanCaps(input.playbook, input.regime, input.config), input.minRr);
    const rawFloors = resolveRiskPlanFloors(input.playbook, input.regime, input.config);
    const floors = normalizeFloorsForCaps(rawFloors, caps, input.minRr);
    const minSlPct = Math.max(0.001, floors.sl_bps / 10000);
    const maxSlPct = caps.sl_bps / 10000;
    const minTpPct = Math.max(0.002, floors.tp_bps / 10000);
    const maxTpPct = caps.tp_bps / 10000;

    let stop_loss_pct = clamp(input.stopLossPct, minSlPct, maxSlPct);
    let take_profit_pct_primary = clamp(input.takeProfitPct, Math.max(minTpPct, stop_loss_pct * input.minRr), maxTpPct);

    if (take_profit_pct_primary < stop_loss_pct * input.minRr) {
        stop_loss_pct = clamp(take_profit_pct_primary / input.minRr, minSlPct, maxSlPct);
        take_profit_pct_primary = clamp(take_profit_pct_primary, Math.max(minTpPct, stop_loss_pct * input.minRr), maxTpPct);
    }

    return { stop_loss_pct, take_profit_pct_primary };
}

function normalizeCapsForMinRr(caps: RiskPlanCaps, minRr: number): RiskPlanCaps {
    if (caps.tp_bps >= caps.sl_bps * minRr) return caps;
    return {
        ...caps,
        sl_bps: Math.floor((caps.tp_bps / minRr) * 100) / 100
    };
}

function normalizeFloorsForCaps(floors: RiskPlanFloors, caps: RiskPlanCaps, minRr: number): RiskPlanFloors {
    const sl_bps = Math.min(floors.sl_bps, caps.sl_bps);
    const tp_bps = Math.min(Math.max(floors.tp_bps, sl_bps * minRr), caps.tp_bps);
    return {
        sl_bps: Math.min(sl_bps, tp_bps / minRr),
        tp_bps
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * Infer trade side ("long" | "short") from a playbook name.
 */
export function inferSideFromPlaybook(playbook: string): "long" | "short" | null {
    const lower = (playbook || "").toLowerCase();
    if (lower.includes("short")) return "short";
    if (lower.includes("long")) return "long";
    return null;
}

/**
 * Check if a playbook is in the list of eligible playbooks (case-insensitive).
 */
export function isPlaybookAllowed(playbook: string, eligiblePlaybooks: string[]): boolean {
    if (!eligiblePlaybooks || eligiblePlaybooks.length === 0) return true;
    const normalized = (playbook || "").toLowerCase().trim();
    return eligiblePlaybooks.some(p => p.toLowerCase().trim() === normalized);
}

/**
 * Compute minimum confidence threshold based on market regime.
 */
export function computeMinConfidence(regime: string | undefined): number {
    const base = 0.3;
    if (regime === "CHOP") return parseFloat((base * 1.2).toFixed(4));
    return base;
}
