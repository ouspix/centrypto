import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { RiskCheckModule } from "@/lib/risk/RiskCheckModule";
import { MainAppDeterministicProvider, assessDecisionsForRisk, buildBackendDecisions } from "@/lib/trader/TraderWorkflow";
import { buildDecisionProvider, buildManagementPolicy } from "@/src/backtest/TraderPolicies";
import { StateSnapshot } from "@/types/snapshot";
import { EligibleCandidate, ManagedPosition, TraderContext } from "@/types/trading";

describe("main-app trader workflow helpers", () => {
    it("deterministically manages positions and opens ranked candidates up to the cycle cap", async () => {
        const context = traderContext({
            existing_positions: [
                managedPosition("ETH-PERP", "long", "CLOSE", 0.12, 25),
                managedPosition("SOL-PERP", "short", "REDUCE", 0.08, 15),
                managedPosition("DOGE-PERP", "long", "HOLD", 0.04)
            ],
            eligible_candidates: [
                candidate("BTC-PERP", "long", 2, 12, 0.03),
                candidate("ARB-PERP", "long", 1, 6, 0.02),
                candidate("LINK-PERP", "short", 3, 20, 0.04)
            ],
            max_new_trades_allowed: 1
        });

        const decisions = await new MainAppDeterministicProvider(DEFAULT_AGENT_CONFIG).decide(context);

        expect(decisions.map(decision => decision.action)).toEqual([
            "CLOSE_POSITION",
            "REDUCE_POSITION",
            "HOLD_POSITION",
            "OPEN_POSITION"
        ]);
        expect(decisions[1].target_size_fraction_of_equity).toBe(0.04);
        expect(decisions[3].candidate_id).toBe("ARB-PERP:long:Momentum");
        expect(decisions[3].target_size_fraction_of_equity).toBe(0.02);
    });

    it("builds backend decisions and approves deterministic opens through risk checks", async () => {
        const eligible = candidate("BTC-PERP", "long", 1, 10, 0.05);
        const context = traderContext({
            eligible_candidates: [eligible],
            max_new_trades_allowed: 1
        });
        const traderDecisions = await new MainAppDeterministicProvider(DEFAULT_AGENT_CONFIG).decide(context);
        const backendDecisions = buildBackendDecisions(traderDecisions, context, "accepted");

        expect(backendDecisions[0].risk_plan).toEqual({
            stop_loss_pct: eligible.risk.stop_loss_pct,
            take_profit_pct_primary: eligible.risk.take_profit_pct_primary
        });
        expect(backendDecisions[0].audit?.validator_status).toBe("accepted");

        const result = assessDecisionsForRisk(backendDecisions, snapshotFor(eligible), new RiskCheckModule());

        expect(result.riskAssessments).toHaveLength(1);
        expect(result.riskAssessments[0].approved).toBe(true);
        expect(result.approvedDecisions).toHaveLength(1);
        expect(result.approvedDecisions[0].symbol).toBe("BTC-PERP");
    });

    it("canonicalizes candidate playbook shorthand in backend decisions", () => {
        const eligible = candidate("HYPE-PERP", "long", 1, 20, 0.0225);
        const context = traderContext({ eligible_candidates: [eligible] });
        const backendDecisions = buildBackendDecisions([{
            scope: "candidate",
            action: "OPEN_POSITION",
            candidate_id: eligible.candidate_id,
            symbol: "HYPE-PERP",
            target_side: "long",
            target_size_fraction_of_equity: 0.0225,
            playbook: "Momentum",
            confidence: 0.55,
            reason_code: "momentum_edge",
            notes: "test"
        }], context, "accepted");

        expect(backendDecisions[0].playbook).toBe("Momentum:long");
    });

    it("defaults legacy non-LLM policies to the deterministic main-app provider without LLM config", async () => {
        const provider = buildDecisionProvider({
            policyName: "take_top_rank",
            managementPolicy: buildManagementPolicy("never_close", DEFAULT_AGENT_CONFIG),
            positions: new Map(),
            agentConfig: DEFAULT_AGENT_CONFIG
        });

        const decisions = await provider.decide(traderContext({
            eligible_candidates: [candidate("BTC-PERP", "long", 1, 10, 0.05)]
        }));

        expect(decisions).toHaveLength(1);
        expect(decisions[0].action).toBe("OPEN_POSITION");
    });
});

function traderContext(overrides: Partial<TraderContext> = {}): TraderContext {
    return {
        snapshot_id: 1,
        timestamp: 1777231800,
        global_regime: "RISK_ON",
        profile: "test",
        portfolio: {
            equity_usd: 10000,
            gross_exposure_fraction: 0,
            remaining_capacity_fraction: 0.75,
            daily_pnl_pct: 0,
            kill_switch: false
        },
        existing_positions: [],
        eligible_candidates: [],
        max_new_trades_allowed: 2,
        ...overrides
    };
}

function candidate(symbol: string, side: "long" | "short", rank: number, edgeToCost: number, size: number): EligibleCandidate {
    const playbook = side === "long" ? "Momentum:long" : "Momentum:short";
    const costBps = 5;
    const stopLossPct = 0.02;
    const takeProfitPct = 0.04;
    return {
        candidate_id: `${symbol}:${side}:Momentum`,
        symbol,
        side,
        eligible_playbooks: [playbook],
        has_hard_trigger: true,
        trigger_diagnostics: {
            trigger_profile: "test",
            triggered_playbooks: [playbook],
            trigger_margin: { vol_ratio_margin: 1, book_pressure_margin: 0.5, regime_size_multiplier: 1 }
        },
        market_quality: {
            rank,
            cost_bps: costBps,
            edge_bps: costBps * edgeToCost + costBps,
            edge_to_cost_mult: edgeToCost,
            book_pressure: side === "long" ? 0.4 : -0.4,
            vol_ratio_5m_vs_1h: 2,
            ret_sigma_5m_vs_1h: side === "long" ? 2 : -2,
            trend_aligned: true,
            min_depth_usd: 100000
        },
        risk: {
            stop_loss_pct: stopLossPct,
            take_profit_pct_primary: takeProfitPct,
            stop_bps: stopLossPct * 10000,
            take_profit_bps: takeProfitPct * 10000,
            cost_to_stop_ratio: costBps / (stopLossPct * 10000),
            cost_to_tp_ratio: costBps / (takeProfitPct * 10000)
        },
        sizing: {
            risk_based_size_fraction: 0.1,
            max_allowed_size_fraction: 0.1,
            suggested_size_fraction: size,
            min_size_fraction: 0.001,
            risk_at_suggested_size_pct_equity: size * stopLossPct,
            effective_leverage_at_suggested_size: size,
            max_effective_leverage_allowed: 3,
            exchange_max_leverage_allowed: 5
        },
        correlation: {
            group: "CRYPTO_BETA",
            same_direction_group_exposure: 0,
            max_group_exposure: 0.45,
            highest_corr_existing_position: null,
            correlation_size_multiplier: 1
        },
        warnings: []
    };
}

function managedPosition(symbol: string, side: "long" | "short", bias: ManagedPosition["management_bias"], exposure: number, unrealizedPnl = 0): ManagedPosition {
    return {
        symbol,
        side,
        exposure_fraction: exposure,
        size_usd: 10000 * exposure,
        entry_price: 100,
        unrealized_pnl_usd: unrealizedPnl,
        market_signal: {
            edge_ok: bias === "HOLD",
            entry_ok: bias !== "CLOSE",
            risk_eligible: bias !== "CLOSE",
            reasons_failed: [],
            book_pressure: side === "long" ? 0.2 : -0.2,
            book_pressure_side_alignment: "supportive",
            ret_sigma_5m_vs_1h: side === "long" ? 1 : -1,
            vol_ratio_5m_vs_1h: 1,
            trend_aligned: true,
            regime_conflict: false
        },
        management_limits: {
            can_hold: true,
            can_reduce: true,
            can_close: true,
            can_increase: false,
            max_increase_to_fraction: 0
        },
        management_bias: bias,
        failure_signals: bias === "HOLD" ? [] : ["entry_ok_false"],
        support_signals: bias === "HOLD" ? ["edge_ok_true"] : []
    };
}

function snapshotFor(eligible: EligibleCandidate): StateSnapshot {
    return {
        timestamp: 1777231800,
        account: {
            equity_usd: 10000,
            daily_realized_pnl: 0,
            daily_total_pnl_usd: 0,
            max_daily_loss: 500,
            current_positions: [],
            derived_portfolio: {
                total_exposure_fraction: 0,
                remaining_capacity: 0.75,
                position_slots_used: 0,
                slots_remaining: 4
            }
        },
        markets: {
            [eligible.symbol]: {
                symbol: eligible.symbol,
                price: 100,
                spread_bps: 2,
                orderbook: {
                    best_bid: 99.99,
                    best_ask: 100.01,
                    mid: 100,
                    book_pressure: eligible.market_quality.book_pressure,
                    bid_liquidity_usd: 100000,
                    ask_liquidity_usd: 100000
                },
                returns: { m5: 0.01, m15: 0.02, h1: 0.03 },
                vol_zscores: { vol_5m_vs_1h: 2, ret_5m_vs_1h: 2 },
                funding: { current_8h: 0 },
                open_interest: { current: 1000000 },
                sentiment: { score: 0, mentionsVsBaseline: 0, disagreement: 0, change2h: 0 },
                derived: {
                    costs: { fees_bps: 3.5, slippage_bps_est: 1, cost_bps: eligible.market_quality.cost_bps, cost_ok: true },
                    edge: { expected_move_bps: 80, edge_bps: eligible.market_quality.edge_bps, edge_ok: true },
                    technicals: { high_low: {}, bb_width_m5: 0.01 },
                    triggers: {
                        direction_m15: 1,
                        direction_h1: 1,
                        trend_aligned: true,
                        momentum_ok_long: eligible.side === "long",
                        momentum_ok_short: eligible.side === "short",
                        mr_ok_long: false,
                        mr_ok_short: false,
                        breakout_ok: false,
                        breakout_ok_long: false,
                        breakout_ok_short: false
                    },
                    liquidity: { min_depth_usd: 100000, depth_ok: true, tradeable: true },
                    normalized: { ret_sigma_5m_vs_1h: 2, vol_ratio_5m_vs_1h: 2 },
                    entry: { entry_ok: true, edge_to_cost_mult: eligible.market_quality.edge_to_cost_mult, reasons_failed: [] },
                    risk: {
                        eligible: true,
                        eligible_playbooks: eligible.eligible_playbooks,
                        best_anchor_key: "edge.expected_move_bps",
                        best_anchor_value: 0.008,
                        trigger_diagnostics: {
                            has_hard_trigger: true,
                            triggered_playbooks: eligible.eligible_playbooks,
                            trigger_profile: "test",
                            trigger_margin: eligible.trigger_diagnostics.trigger_margin
                        }
                    }
                }
            }
        },
        constraints: {
            max_position_pct_equity: 0.2,
            max_position_pct_equity_per_symbol: 0.2,
            max_total_exposure_pct_equity: 1,
            min_trade_notional_usd: 10,
            kill_switch: false,
            no_flip_same_tick: true,
            max_new_positions_per_cycle: 2,
            daily_loss_kill_switch_fraction: DEFAULT_AGENT_CONFIG.risk.daily_loss_kill_switch_fraction,
            max_new_trades_allowed: 2
        },
        allowed_actions: ["OPEN_POSITION", "REDUCE_POSITION", "CLOSE_POSITION", "HOLD_POSITION", "SKIP"],
        meta: { note: "test", snapshot_id: 1 },
        global_regime: { current: "RISK_ON", score: 1, reason: "test" },
        presets: { agent: DEFAULT_AGENT_CONFIG, screening: {} as any }
    } as StateSnapshot;
}
