import { describe, expect, it } from "vitest";
import { AGENT_PRESETS } from "@/lib/agent-config";
import { clampRiskPlan, computeRiskPlan, resolveAnchor } from "@/lib/risk/shared";
import { TradeDecision } from "@/types/trading";

describe("risk plan width controls", () => {
    it("prefers ATR/realized-vol anchors over expected move by default", () => {
        const config = AGENT_PRESETS.optimized;
        const anchor = resolveAnchor(market({ expectedMoveBps: 2500, atrM5: 0.004 }), config);

        expect(anchor.key).toBe("atr_pct.m5");
        expect(anchor.value).toBe(0.004);
    });

    it("caps optimized short-horizon TP/SL even when expected move is huge", () => {
        const config = AGENT_PRESETS.optimized;
        const plan = computeRiskPlan("Momentum:long", market({ expectedMoveBps: 2500, atrM5: 0.08 }), config, "RISK_ON", 4);

        expect(plan).toEqual({ stop_loss_pct: 0.012, take_profit_pct_primary: 0.024 });
        expect(plan!.stop_loss_pct * 10000).toBeLessThan(500);
        expect(plan!.take_profit_pct_primary * 10000).toBeLessThan(500);
    });

    it("does not let risk clamps re-expand TP beyond configured caps", () => {
        const config = AGENT_PRESETS.optimized;
        const decision: TradeDecision = {
            scope: "candidate",
            candidate_id: "BTC-PERP:long:Momentum",
            action: "OPEN_POSITION",
            symbol: "BTC-PERP",
            side: "long",
            target_side: "long",
            target_size_fraction_of_equity: 0.05,
            size_fraction_of_equity: 0.05,
            risk_plan: { stop_loss_pct: 0.20, take_profit_pct_primary: 0.50 },
            playbook: "Momentum:long",
            confidence: 0.8,
            reason_code: "momentum_edge",
            notes: "test",
            audit: { regime: "RISK_ON" }
        };

        clampRiskPlan(decision, { config, regime: "RISK_ON" });

        expect(decision.risk_plan).toEqual({ stop_loss_pct: 0.012, take_profit_pct_primary: 0.024 });
    });

    it("allows explicit cap overrides for larger widths", () => {
        const config = {
            ...AGENT_PRESETS.optimized,
            risk_plan_model: {
                ...AGENT_PRESETS.optimized.risk_plan_model,
                max_width_bps_by_playbook: {
                    Momentum: {
                        RISK_ON: { sl_bps: 600, tp_bps: 1200 }
                    }
                }
            }
        };
        const plan = computeRiskPlan("Momentum:long", market({ expectedMoveBps: 2500, atrM5: 0.08 }), config, "RISK_ON", 4);

        expect(plan).toEqual({ stop_loss_pct: 0.06, take_profit_pct_primary: 0.12 });
    });

    it("applies economic min width floors before caps to avoid fee-churn brackets", () => {
        const config = AGENT_PRESETS["Balanced PM v2"];
        const plan = computeRiskPlan("Mean Reversion:long", market({ expectedMoveBps: 10, atrM5: 0.001 }), config, "CHOP", 1);

        expect(plan!.stop_loss_pct * 10000).toBeGreaterThanOrEqual(30);
        expect(plan!.take_profit_pct_primary * 10000).toBeGreaterThanOrEqual(45);
        expect(plan!.take_profit_pct_primary).toBeGreaterThanOrEqual(1.5 * plan!.stop_loss_pct);
    });

    it("keeps Balanced PM v2 momentum shorts eligible at config level", () => {
        expect(AGENT_PRESETS["Balanced PM v2"].strategy_filters.playbookBlocklist).not.toContain("Momentum:short");
    });

    it("normalizes TP/SL caps so capped plans keep the RiskCheck RR floor", () => {
        const config = {
            ...AGENT_PRESETS.optimized,
            risk_plan_model: {
                ...AGENT_PRESETS.optimized.risk_plan_model,
                max_width_bps_by_playbook: {
                    "Mean Reversion": {
                        CHOP: { sl_bps: 60, tp_bps: 80 }
                    }
                }
            }
        };
        const decision: TradeDecision = {
            scope: "candidate",
            candidate_id: "BTC-PERP:long:Mean_Reversion",
            action: "OPEN_POSITION",
            symbol: "BTC-PERP",
            side: "long",
            target_side: "long",
            target_size_fraction_of_equity: 0.05,
            size_fraction_of_equity: 0.05,
            risk_plan: { stop_loss_pct: 0.02, take_profit_pct_primary: 0.02 },
            playbook: "Mean Reversion:long",
            confidence: 0.8,
            reason_code: "mean_reversion_edge",
            notes: "test",
            audit: { regime: "CHOP" }
        };

        clampRiskPlan(decision, { config, regime: "CHOP" });

        expect(decision.risk_plan!.take_profit_pct_primary).toBeGreaterThanOrEqual(1.5 * decision.risk_plan!.stop_loss_pct);
        expect(decision.risk_plan!.take_profit_pct_primary).toBe(0.008);
        expect(decision.risk_plan!.stop_loss_pct).toBeCloseTo(0.005333, 8);
    });
});

function market(input: { expectedMoveBps: number; atrM5: number }) {
    return {
        symbol: "BTC-PERP",
        price: 100,
        atr_pct: { m5: input.atrM5, h1: input.atrM5 * 2 },
        realized_vol: { m1: 0.002, m5: input.atrM5 * 0.5, m15: 0.003, h1: 0.004, h4: 0.005 },
        derived: {
            edge: { expected_move_bps: input.expectedMoveBps, edge_bps: input.expectedMoveBps - 5, edge_ok: true },
            risk: {
                eligible: true,
                eligible_playbooks: ["Momentum:long"],
                best_anchor_key: "edge.expected_move_bps",
                best_anchor_value: input.expectedMoveBps / 10000
            }
        }
    } as any;
}
