import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { RiskCheckModule } from "@/lib/risk/RiskCheckModule";
import { StateSnapshot } from "@/types/snapshot";
import { TradeDecision } from "@/types/trading";

describe("execution safety", () => {
    it("blocks execution when backend kill switch is active", () => {
        const risk = new RiskCheckModule();
        const assessment = risk.assess(openDecision(), snapshot({ killSwitch: true }));
        expect(assessment.approved).toBe(false);
        expect(assessment.reason).toMatch(/kill switch/i);
    });

    it("blocks execution when daily loss kill switch is active", () => {
        const risk = new RiskCheckModule();
        const assessment = risk.assess(openDecision(), snapshot({ dailyTotalPnl: -600 }));
        expect(assessment.approved).toBe(false);
        expect(assessment.reason).toMatch(/max daily loss/i);
    });

    it("converts a partial reduce to a full close when the remainder would be dust", () => {
        const risk = new RiskCheckModule();
        const assessment = risk.assess(reduceDecision(0.0005), snapshotWithPosition(50));

        expect(assessment.approved).toBe(true);
        expect(assessment.reason).toMatch(/converted to close/i);
        expect(assessment.modifiedOrder?.sizeUsd).toBe(50);
        expect(assessment.modifiedOrder?.sizeCoin).toBe(0.5);
        expect(assessment.modifiedOrder?.clientTag).toBe("AI_TRADER_CLOSE_DUST_REMAINDER");
    });

    it("bumps a too-small partial reduce to the venue minimum notional", () => {
        const risk = new RiskCheckModule();
        const assessment = risk.assess(reduceDecision(0.0045), snapshotWithPosition(50));

        expect(assessment.approved).toBe(true);
        expect(assessment.reason).toMatch(/minimum notional/i);
        expect(assessment.modifiedOrder?.sizeUsd).toBe(10);
        expect(assessment.modifiedOrder?.sizeCoin).toBe(0.1);
        expect(assessment.modifiedOrder?.clientTag).toBe("AI_TRADER_REDUCE_MIN_NOTIONAL");
    });

    it("converts a tiny reduce to a close when the minimum reduce would leave dust", () => {
        const risk = new RiskCheckModule();
        const assessment = risk.assess(reduceDecision(0.00105), snapshotWithPosition(12));

        expect(assessment.approved).toBe(true);
        expect(assessment.reason).toMatch(/minimum reduce would leave/i);
        expect(assessment.modifiedOrder?.sizeUsd).toBe(12);
        expect(assessment.modifiedOrder?.sizeCoin).toBe(0.12);
        expect(assessment.modifiedOrder?.clientTag).toBe("AI_TRADER_CLOSE_DUST_REMAINDER");
    });

    it("uses the exact coin size for full reduce-only dust closes", () => {
        const risk = new RiskCheckModule();
        const assessment = risk.assess(closeDecision(), snapshotWithPosition(6.37));

        expect(assessment.approved).toBe(true);
        expect(assessment.reason).toMatch(/exact reduce-only dust close/i);
        expect(assessment.modifiedOrder?.sizeUsd).toBeCloseTo(6.37, 8);
        expect(assessment.modifiedOrder?.sizeCoin).toBeCloseTo(0.0637, 8);
        expect(assessment.modifiedOrder?.clientTag).toBe("AI_TRADER_CLOSE_DUST");
    });
});

function openDecision(): TradeDecision {
    return {
        scope: "candidate",
        candidate_id: "BTC-PERP:long:Momentum",
        action: "OPEN_POSITION",
        symbol: "BTC-PERP",
        side: "long",
        target_side: "long",
        target_size_fraction_of_equity: 0.05,
        size_fraction_of_equity: 0.05,
        risk_plan: { stop_loss_pct: 0.02, take_profit_pct_primary: 0.04 },
        playbook: "Momentum",
        confidence: 0.8,
        reason_code: "momentum_edge",
        notes: "test"
    };
}

function reduceDecision(targetFraction: number): TradeDecision {
    return {
        scope: "position",
        candidate_id: null,
        action: "REDUCE_POSITION",
        symbol: "BTC-PERP",
        side: "long",
        target_side: "long",
        target_size_fraction_of_equity: targetFraction,
        size_fraction_of_equity: targetFraction,
        risk_plan: null,
        playbook: "none",
        confidence: 0.7,
        reason_code: "risk_reduction",
        notes: "test"
    };
}

function closeDecision(): TradeDecision {
    return {
        scope: "position",
        candidate_id: null,
        action: "CLOSE_POSITION",
        symbol: "BTC-PERP",
        side: null,
        target_side: "flat",
        target_size_fraction_of_equity: 0,
        size_fraction_of_equity: 0,
        risk_plan: null,
        playbook: "none",
        confidence: 0.7,
        reason_code: "risk_reduction",
        notes: "test"
    };
}

function snapshotWithPosition(sizeUsd: number): StateSnapshot {
    const base = snapshot({});
    base.account.current_positions = [{
        symbol: "BTC-PERP",
        side: "long",
        entry_price: 100,
        size_usd: sizeUsd,
        size_coin: sizeUsd / 100,
        fraction_of_equity: sizeUsd / base.account.equity_usd,
        unrealized_pnl: 0,
        leverage: 1
    } as any];
    base.account.derived_portfolio = {
        total_exposure_fraction: sizeUsd / base.account.equity_usd,
        remaining_capacity: 1 - (sizeUsd / base.account.equity_usd),
        position_slots_used: 1,
        slots_remaining: 4
    };
    return base;
}

function snapshot(args: { killSwitch?: boolean; dailyTotalPnl?: number }): StateSnapshot {
    return {
        timestamp: 1,
        account: {
            equity_usd: 10000,
            daily_realized_pnl: args.dailyTotalPnl ?? 0,
            daily_realized_pnl_usd: args.dailyTotalPnl ?? 0,
            daily_unrealized_pnl_usd: 0,
            daily_total_pnl_usd: args.dailyTotalPnl ?? 0,
            max_daily_loss: 500,
            current_positions: [],
            derived_portfolio: {
                total_exposure_fraction: 0,
                remaining_capacity: 1,
                position_slots_used: 0,
                slots_remaining: 5
            }
        },
        markets: {
            "BTC-PERP": {
                symbol: "BTC-PERP",
                price: 100,
                spread_bps: 1,
                orderbook: {
                    best_bid: 99.99,
                    best_ask: 100.01,
                    mid: 100,
                    book_pressure: 0.2,
                    bid_liquidity_usd: 100000,
                    ask_liquidity_usd: 100000
                },
                returns: { m5: 0.01, m15: 0.02, h1: 0.03 },
                vol_zscores: { vol_5m_vs_1h: 2, ret_5m_vs_1h: 2 },
                funding: { current_8h: 0 },
                open_interest: { current: 1000000 },
                sentiment: { score: 0, mentionsVsBaseline: 0, disagreement: 0, change2h: 0 },
                derived: {
                    costs: { fees_bps: 3.5, slippage_bps_est: 1, cost_bps: 8, cost_ok: true },
                    edge: { expected_move_bps: 50, edge_bps: 40, edge_ok: true },
                    technicals: { high_low: {}, bb_width_m5: 0.01 },
                    triggers: {
                        direction_m15: 1,
                        direction_h1: 1,
                        trend_aligned: true,
                        momentum_ok_long: true,
                        momentum_ok_short: false,
                        mr_ok_long: false,
                        mr_ok_short: false,
                        breakout_ok: false
                    },
                    liquidity: { min_depth_usd: 100000, depth_ok: true, tradeable: true },
                    normalized: { ret_sigma_5m_vs_1h: 2, vol_ratio_5m_vs_1h: 2 },
                    entry: { entry_ok: true, edge_to_cost_mult: 5 },
                    risk: { eligible: true, eligible_playbooks: ["Momentum"], best_anchor_key: null, best_anchor_value: null }
                }
            }
        },
        constraints: {
            max_position_pct_equity: 0.2,
            max_position_pct_equity_per_symbol: 0.2,
            max_total_exposure_pct_equity: 1,
            min_trade_notional_usd: 10,
            kill_switch: !!args.killSwitch,
            no_flip_same_tick: true,
            max_new_positions_per_cycle: 2,
            daily_loss_kill_switch_fraction: DEFAULT_AGENT_CONFIG.risk.daily_loss_kill_switch_fraction,
            max_new_trades_allowed: 2
        },
        allowed_actions: ["OPEN_POSITION", "REDUCE_POSITION", "CLOSE_POSITION", "HOLD_POSITION", "SKIP"],
        meta: { note: "test" },
        global_regime: { current: "RISK_ON", score: 1, reason: "test" },
        presets: { agent: DEFAULT_AGENT_CONFIG, screening: {} as any }
    };
}
