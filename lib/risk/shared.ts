/**
 * Shared risk utility functions used by both OrchestratorService and RiskCheckModule.
 * Extracted to eliminate duplication.
 */

import { AgentConfig } from "@/lib/agent-config";
import { MarketEntry, GlobalRegime } from "@/types/snapshot";
import { TradeDecision } from "@/types/trading";

export type RiskPlanCaps = { sl_bps: number; tp_bps: number };

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
        CHOP: { sl_bps: 60, tp_bps: 80 }
    },
    DEFAULT: {
        DEFAULT: { sl_bps: 100, tp_bps: 200 }
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
    const minSl = 0.001; // 0.1% price move
    const maxSl = 0.05;  // 5% of equity
    const minTp = 0.002;  // 0.2% target floor to avoid tiny profits
    const minRr = 1.5;

    const sl = decision.risk_plan.stop_loss_pct;
    if (sl === undefined || sl === null) return;
    const clampedSl = Math.min(maxSl, Math.max(minSl, Math.abs(sl)));
    decision.risk_plan.stop_loss_pct = clampedSl;

    const tp = decision.risk_plan.take_profit_pct_primary;
    const floorTp = Math.max(minTp, minRr * clampedSl);
    if (tp === undefined || tp === null || tp < floorTp) {
        decision.risk_plan.take_profit_pct_primary = floorTp;
    }

    const auditRegime = decision.audit?.regime as GlobalRegime["current"] | undefined;
    const caps = resolveRiskPlanCaps(decision.playbook, options.regime ?? auditRegime, options.config);
    decision.risk_plan.stop_loss_pct = Math.min(decision.risk_plan.stop_loss_pct, caps.sl_bps / 10000);
    decision.risk_plan.take_profit_pct_primary = Math.min(decision.risk_plan.take_profit_pct_primary, caps.tp_bps / 10000);
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
    const caps = resolveRiskPlanCaps(basePlaybook, regime, config);

    const rawStopLossPct = anchor.value * (multipliers.sl_mult ?? 1) * (regimeAdj.sl_mult_factor ?? 1);
    const rawTakeProfitPct = anchor.value * (multipliers.tp_mult ?? 2) * (regimeAdj.tp_mult_factor ?? 1);
    const stop_loss_pct = Math.min(rawStopLossPct, caps.sl_bps / 10000);
    const take_profit_pct_primary = Math.min(rawTakeProfitPct, caps.tp_bps / 10000);

    return { stop_loss_pct, take_profit_pct_primary };
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
