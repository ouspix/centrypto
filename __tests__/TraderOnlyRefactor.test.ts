import { describe, expect, it } from "vitest";
import { AGENT_PRESETS, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { DEFAULT_SCREENER_CONFIG, SCREENER_PRESETS } from "@/lib/screener-config";
import { TraderDecisionValidator } from "@/lib/trader/TraderDecisionValidator";
import { MarketDerivedMetricsService } from "@/services/MarketDerivedMetricsService";
import { TraderContextBuilder } from "@/services/TraderContextBuilder";
import { StateSnapshot } from "@/types/snapshot";
import { TraderContext, TraderDecision } from "@/types/trading";

function baseMarket(overrides: any = {}) {
    return {
        symbol: "BTC-PERP",
        price: 50000,
        spread_bps: 2,
        orderbook: {
            book_pressure: 0.55,
            bid_liquidity_usd: 100000,
            ask_liquidity_usd: 50000
        },
        returns: { m5: 0.01, m15: 0.02, h1: 0.02 },
        vol_zscores: { vol_5m_vs_1h: 2.5, ret_5m_vs_1h: 2.2 },
        atr_pct: { m5: 0.01, h1: 0.02 },
        realized_vol: { m1: 0.002, m5: 0.003, m15: 0.004, h1: 0.005, h4: 0.006 },
        funding: { current_8h: 0 },
        open_interest: { current: 1000000 },
        sentiment: { score: 0, mentionsVsBaseline: 0, disagreement: 0, change2h: 0 },
        ...overrides
    } as any;
}

function baseSnapshot(markets: Record<string, any>): StateSnapshot {
    return {
        timestamp: 1777231828,
        account: {
            equity_usd: 10000,
            daily_realized_pnl: 0,
            daily_total_pnl_usd: 0,
            max_daily_loss: 300,
            current_positions: [],
            derived_portfolio: {
                total_exposure_fraction: 0,
                remaining_capacity: 0.5,
                position_slots_used: 0,
                slots_remaining: 3
            }
        },
        markets,
        constraints: {
            max_position_pct_equity: 0.1,
            max_position_pct_equity_per_symbol: 0.1,
            max_total_exposure_pct_equity: 0.5,
            min_trade_notional_usd: 10,
            kill_switch: false,
            no_flip_same_tick: true,
            max_new_positions_per_cycle: 1,
            daily_loss_kill_switch_fraction: 0.03,
            max_new_trades_allowed: 1
        },
        allowed_actions: ["OPEN_POSITION", "REDUCE_POSITION", "CLOSE_POSITION", "HOLD_POSITION", "SKIP"],
        meta: { note: "test", snapshot_id: 1 },
        global_regime: { current: "RISK_ON", score: 1, reason: "test" },
        presets: { agent: DEFAULT_AGENT_CONFIG, screening: {} as any }
    };
}

describe("Trader-only v1 trigger scope", () => {
    it("uses the four v1 presets with Momentum Moderate as the default", () => {
        expect(Object.keys(SCREENER_PRESETS)).toEqual([
            "Scalper Strict",
            "Momentum Moderate",
            "optimized",
            "Swing Relaxed",
            "Testnet Aggressive"
        ]);
        expect(Object.keys(AGENT_PRESETS)).toEqual([
            "Scalper Strict",
            "Momentum Moderate",
            "optimized",
            "Swing Relaxed",
            "LLM Permissive",
            "Testnet Aggressive"
        ]);

        expect(DEFAULT_SCREENER_CONFIG).toBe(SCREENER_PRESETS["Momentum Moderate"]);
        expect(DEFAULT_AGENT_CONFIG).toBe(AGENT_PRESETS["Momentum Moderate"]);
        expect(SCREENER_PRESETS["Scalper Strict"].maxSpreadBps).toBe(8);
        expect(SCREENER_PRESETS["Momentum Moderate"].quality_weights.cost_to_edge_penalty).toBe(1.5);
        expect(AGENT_PRESETS["Scalper Strict"].risk.max_correlation_group_exposure_fraction).toBe(0.3);
        expect(AGENT_PRESETS["Swing Relaxed"].preset_live_mode).toBe("limited_manual");
        expect(AGENT_PRESETS["LLM Permissive"].gates.edge_to_cost_mult_by_regime.CHOP).toBe(6);
        expect(AGENT_PRESETS["Testnet Aggressive"].preset_live_mode).toBe("non_live");
        expect(AGENT_PRESETS["Momentum Moderate"].cost_sanity.min_edge_to_cost_mult).toBe(4);
        expect(SCREENER_PRESETS.optimized.topN).toBe(26);
        expect(AGENT_PRESETS.optimized.risk.default_leverage).toBe(4);
    });

    it("creates exact hard-trigger playbooks and no discretionary entries", () => {
        const markets = { "BTC-PERP": baseMarket() };
        new MarketDerivedMetricsService().applyDerivedMetrics(markets, DEFAULT_AGENT_CONFIG, "RISK_ON", false);

        expect(markets["BTC-PERP"].derived.risk.eligible_playbooks).toContain("Momentum:long");
        expect(markets["BTC-PERP"].derived.risk.eligible_playbooks).toContain("Breakout:long");
        expect(markets["BTC-PERP"].derived.risk.eligible_playbooks).not.toContain("Discretionary Edge:long");
        expect(markets["BTC-PERP"].derived.risk.eligible_playbooks).not.toContain("Liquidity Grab:long");
        expect(markets["BTC-PERP"].derived.risk.best_anchor_key).toBe("edge.expected_move_bps");
    });

    it("only creates mean-reversion candidates in CHOP", () => {
        const market = baseMarket({
            orderbook: { book_pressure: 0.25, bid_liquidity_usd: 100000, ask_liquidity_usd: 60000 },
            returns: { m5: -0.02, m15: -0.03, h1: 0.01 },
            vol_zscores: { vol_5m_vs_1h: 0.8, ret_5m_vs_1h: -4.2 }
        });

        const riskOnMarkets = { "BTC-PERP": { ...market } };
        new MarketDerivedMetricsService().applyDerivedMetrics(riskOnMarkets, DEFAULT_AGENT_CONFIG, "RISK_ON", false);
        expect(riskOnMarkets["BTC-PERP"].derived.risk.eligible_playbooks).not.toContain("Mean Reversion:long");

        const chopMarkets = { "BTC-PERP": baseMarket({
            orderbook: { book_pressure: 0.25, bid_liquidity_usd: 100000, ask_liquidity_usd: 60000 },
            returns: { m5: -0.02, m15: -0.03, h1: 0.01 },
            vol_zscores: { vol_5m_vs_1h: 0.8, ret_5m_vs_1h: -4.2 }
        }) };
        new MarketDerivedMetricsService().applyDerivedMetrics(chopMarkets, DEFAULT_AGENT_CONFIG, "CHOP", false);
        expect(chopMarkets["BTC-PERP"].derived.risk.eligible_playbooks).toContain("Mean Reversion:long");
    });
});

describe("Trader context builder", () => {
    it("emits eligible backend candidates with backend-owned sizing and risk", async () => {
        const markets = { "BTC-PERP": baseMarket() };
        new MarketDerivedMetricsService().applyDerivedMetrics(markets, DEFAULT_AGENT_CONFIG, "RISK_ON", false);

        const { context } = await new TraderContextBuilder().build(baseSnapshot(markets), DEFAULT_AGENT_CONFIG, true, "Scalper Strict");

        expect(context.eligible_candidates).toHaveLength(1);
        expect(context.eligible_candidates[0].candidate_id).toBe("BTC-PERP:long:Momentum");
        expect(context.eligible_candidates[0].risk.stop_loss_pct).toBeGreaterThan(0);
        expect(context.eligible_candidates[0].sizing.max_allowed_size_fraction).toBeGreaterThan(0);
        expect(context.eligible_candidates[0].sizing.suggested_size_fraction)
            .toBeLessThanOrEqual(context.eligible_candidates[0].sizing.max_allowed_size_fraction);
    });

    it("keeps min-notional candidates when soft sizing falls below the executable floor", async () => {
        const config = AGENT_PRESETS.optimized;
        const markets = {
            "PENGU-PERP": baseMarket({
                symbol: "PENGU-PERP",
                price: 0.008532,
                spread_bps: 1.17,
                orderbook: {
                    book_pressure: 0.27,
                    bid_liquidity_usd: 130711,
                    ask_liquidity_usd: 75368
                },
                returns: { m5: -0.0047, m15: -0.0063, h1: -0.0111 },
                vol_zscores: { vol_5m_vs_1h: 1.1072, ret_5m_vs_1h: -6.1669 },
                atr_pct: { m5: 0.001817, h1: 0.003 },
                realized_vol: { m1: 0.0008, m5: 0.001, m15: 0.0012, h1: 0.0018, h4: 0.002 }
            })
        };
        new MarketDerivedMetricsService().applyDerivedMetrics(markets, config, "CHOP", false);

        const snapshot = baseSnapshot(markets);
        snapshot.account.equity_usd = 101.704298;
        snapshot.account.max_daily_loss = snapshot.account.equity_usd * config.risk.daily_loss_kill_switch_fraction;
        snapshot.account.derived_portfolio.remaining_capacity = config.risk.max_total_exposure_fraction;
        snapshot.account.derived_portfolio.slots_remaining = config.risk.max_positions;
        snapshot.constraints.max_position_pct_equity = config.risk.max_position_fraction;
        snapshot.constraints.max_position_pct_equity_per_symbol = config.risk.max_position_fraction_per_symbol;
        snapshot.constraints.max_total_exposure_pct_equity = config.risk.max_total_exposure_fraction;
        snapshot.constraints.max_new_positions_per_cycle = config.risk.max_new_positions_per_cycle;
        snapshot.constraints.max_new_trades_allowed = config.risk.max_new_positions_per_cycle;
        snapshot.global_regime = { current: "CHOP", score: 0, reason: "test" };

        const { context, diagnostics } = await new TraderContextBuilder().build(snapshot, config, true, "optimized");

        expect(diagnostics.rejection_counts.SIZE_GATE).toBeUndefined();
        expect(context.eligible_candidates).toHaveLength(1);
        expect(context.eligible_candidates[0].eligible_playbooks).toEqual(["Mean Reversion:long"]);
        expect(context.eligible_candidates[0].sizing.min_size_fraction).toBeCloseTo(10 / 101.704298, 6);
        expect(context.eligible_candidates[0].sizing.suggested_size_fraction)
            .toBe(context.eligible_candidates[0].sizing.min_size_fraction);
        expect(context.eligible_candidates[0].sizing.suggested_size_fraction)
            .toBeLessThanOrEqual(context.eligible_candidates[0].sizing.max_allowed_size_fraction);
    });
});

describe("Trader decision validator", () => {
    const context: TraderContext = {
        snapshot_id: 1,
        timestamp: 1,
        global_regime: "RISK_ON",
        profile: "test",
        portfolio: {
            equity_usd: 10000,
            gross_exposure_fraction: 0,
            remaining_capacity_fraction: 0.5,
            daily_pnl_pct: 0,
            kill_switch: false
        },
        existing_positions: [{
            symbol: "ETH-PERP",
            side: "long",
            exposure_fraction: 0.2,
            size_usd: 2000,
            entry_price: 3000,
            unrealized_pnl_usd: 0,
            market_signal: {
                edge_ok: true,
                entry_ok: true,
                risk_eligible: true,
                reasons_failed: [],
                book_pressure: 0.2,
                book_pressure_side_alignment: "supportive",
                ret_sigma_5m_vs_1h: 1,
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
            management_bias: "HOLD",
            failure_signals: [],
            support_signals: ["edge_ok_true"]
        }],
        eligible_candidates: [{
            candidate_id: "BTC-PERP:long:Momentum",
            symbol: "BTC-PERP",
            side: "long",
            eligible_playbooks: ["Momentum:long"],
            has_hard_trigger: true,
            trigger_diagnostics: {
                trigger_profile: "test",
                triggered_playbooks: ["Momentum:long"],
                trigger_margin: { regime_size_multiplier: 1 }
            },
            market_quality: {
                rank: 1,
                cost_bps: 5,
                edge_bps: 50,
                edge_to_cost_mult: 10,
                book_pressure: 0.5,
                vol_ratio_5m_vs_1h: 2,
                ret_sigma_5m_vs_1h: 2,
                trend_aligned: true,
                min_depth_usd: 100000
            },
            risk: {
                stop_loss_pct: 0.01,
                take_profit_pct_primary: 0.02,
                stop_bps: 100,
                take_profit_bps: 200,
                cost_to_stop_ratio: 0.05,
                cost_to_tp_ratio: 0.025
            },
            sizing: {
                risk_based_size_fraction: 0.25,
                max_allowed_size_fraction: 0.1,
                suggested_size_fraction: 0.05,
                min_size_fraction: 0.001,
                risk_at_suggested_size_pct_equity: 0.0005,
                effective_leverage_at_suggested_size: 0.05,
                max_effective_leverage_allowed: 5,
                exchange_max_leverage_allowed: 5
            },
            correlation: {
                group: "CRYPTO_BETA",
                same_direction_group_exposure: 0,
                max_group_exposure: 0.5,
                highest_corr_existing_position: null,
                correlation_size_multiplier: 1
            },
            warnings: []
        }]
    };

    it("rejects oversized candidate opens", () => {
        const decision: TraderDecision = {
            scope: "candidate",
            action: "OPEN_POSITION",
            candidate_id: "BTC-PERP:long:Momentum",
            symbol: "BTC-PERP",
            target_side: "long",
            target_size_fraction_of_equity: 0.11,
            playbook: "Momentum:long",
            confidence: 0.7,
            reason_code: "momentum_edge",
            notes: "test"
        };

        expect(new TraderDecisionValidator().validateBatch([decision], context)).toEqual({
            accepted: false,
            reason: "size_exceeds_max"
        });
    });

    it("accepts candidate playbook shorthand when it matches the candidate side", () => {
        const decision: TraderDecision = {
            scope: "candidate",
            action: "OPEN_POSITION",
            candidate_id: "BTC-PERP:long:Momentum",
            symbol: "BTC-PERP",
            target_side: "long",
            target_size_fraction_of_equity: 0.05,
            playbook: "Momentum",
            confidence: 0.7,
            reason_code: "momentum_edge",
            notes: "test"
        };

        expect(new TraderDecisionValidator().validateBatch([decision], context)).toEqual({
            accepted: true,
            reason: "accepted"
        });
    });

    it("rejects SKIP for existing positions and disabled increases", () => {
        const skipPosition = {
            scope: "position",
            action: "SKIP",
            candidate_id: null,
            symbol: "ETH-PERP",
            target_side: "flat",
            target_size_fraction_of_equity: 0,
            playbook: null,
            confidence: 0.4,
            reason_code: "skip",
            notes: "test"
        } as TraderDecision;

        const increase = {
            ...skipPosition,
            scope: "candidate",
            action: "INCREASE_POSITION",
            candidate_id: "BTC-PERP:long:Momentum",
            symbol: "BTC-PERP",
            target_side: "long"
        } as unknown as TraderDecision;

        expect(new TraderDecisionValidator().validateBatch([skipPosition], context).reason).toBe("invalid_position_action");
        expect(new TraderDecisionValidator().validateBatch([increase], context).reason).toBe("invalid_action");
    });
});
