import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { PositionManager } from "@/lib/trader/PositionManager";
import type { ManagedLifecycleState, ManagedOpenOrder } from "@/lib/trader/position-management-types";
import { StateSnapshot } from "@/types/snapshot";

describe("PositionManager", () => {
    it("closes a position that was green and is now red", () => {
        const action = evaluate({ currentPrice: 99.95, mfeBps: 35, netCurrentBps: -15 });

        expect(action.action).toBe("CLOSE_POSITION");
        expect(action.stateAfter).toBe("EXIT_NOW");
        expect(action.reasonCode).toBe("OPEN_WAS_GREEN_NOW_RED");
        expect(action.bypassLlm).toBe(true);
    });

    it("replaces a weak stop with breakeven protection after MFE", () => {
        const action = evaluate({
            currentPrice: 100.4,
            mfeBps: 40,
            netCurrentBps: 30,
            openOrders: [stopAt(99)]
        });

        expect(action.action).toBe("REPLACE_STOP");
        expect(action.reasonCode).toBe("BREAKEVEN_PROTECTION");
        expect(action.stopReplacement?.stopPx).toBeGreaterThan(100);
    });

    it("takes partial profit once MFE reaches the playbook threshold", () => {
        const action = evaluate({ currentPrice: 100.55, mfeBps: 55, netCurrentBps: 45 });

        expect(action.action).toBe("REDUCE_POSITION");
        expect(action.reasonCode).toBe("PARTIAL_TP_AFTER_MFE");
        expect(action.reduceFraction).toBe(0.4);
        expect(action.targetSizeFractionOfEquity).toBe(0.06);
    });

    it("closes after a large MFE giveback once partial profit was already taken", () => {
        const action = evaluate({
            currentPrice: 100.25,
            mfeBps: 80,
            netCurrentBps: 25,
            priorPartialTakenFraction: 0.4
        });

        expect(action.action).toBe("CLOSE_POSITION");
        expect(action.reasonCode).toBe("MFE_GIVEBACK_LIMIT");
    });

    it("time-stops mean reversion positions in CHOP when they are not green", () => {
        const action = evaluate({
            currentPrice: 100,
            mfeBps: 10,
            netCurrentBps: -5,
            regime: "CHOP",
            playbook: "Mean Reversion:long",
            holdMinutes: 13
        });

        expect(action.action).toBe("CLOSE_POSITION");
        expect(action.reasonCode).toBe("MEAN_REVERSION_FAILED");
    });

    it("detects a stale take-profit that exceeds the playbook/regime cap", () => {
        const action = evaluate({
            currentPrice: 100.1,
            mfeBps: 12,
            netCurrentBps: 5,
            regime: "CHOP",
            playbook: "Mean Reversion:long",
            holdMinutes: 5,
            openOrders: [protectedStop(), takeProfitAt(102)]
        });

        expect(action.action).toBe("REPLACE_TAKE_PROFIT");
        expect(action.reasonCode).toBe("STALE_TAKE_PROFIT");
        expect(action.takeProfitReplacement?.takeProfitPx).toBeCloseTo(100.9, 6);
    });

    it("repairs a missing stop on a live position", () => {
        const action = evaluate({
            currentPrice: 100.1,
            mfeBps: 10,
            netCurrentBps: 3,
            openOrders: []
        });

        expect(action.action).toBe("PLACE_BREAKEVEN_STOP");
        expect(action.reasonCode).toBe("MISSING_PROTECTIVE_STOP");
    });

    it("prioritizes emergency max loss over missing stop repair", () => {
        const action = evaluate({
            currentPrice: 98.5,
            mfeBps: 5,
            netCurrentBps: -160,
            maeBps: -160,
            openOrders: []
        });

        expect(action.action).toBe("CLOSE_POSITION");
        expect(action.urgency).toBe("EMERGENCY");
        expect(action.reasonCode).toBe("EMERGENCY_MAX_LOSS");
    });

    it("prioritizes green-to-red close over stale take-profit repair", () => {
        const action = evaluate({
            currentPrice: 99.95,
            mfeBps: 40,
            netCurrentBps: -8,
            openOrders: [protectedStop(), takeProfitAt(103)]
        });

        expect(action.action).toBe("CLOSE_POSITION");
        expect(action.reasonCode).toBe("OPEN_WAS_GREEN_NOW_RED");
    });

    it("prioritizes partial profit over trailing repair", () => {
        const action = evaluate({
            currentPrice: 101,
            mfeBps: 100,
            netCurrentBps: 90,
            openOrders: [protectedStop()]
        });

        expect(action.action).toBe("REDUCE_POSITION");
        expect(action.reasonCode).toBe("PARTIAL_TP_AFTER_MFE");
    });

    it("blocks new entries when an urgent manager action exists", () => {
        const snapshot = snapshotFor({ currentPrice: 99.95, netCurrentBps: -10 });
        const lifecycle = managedLifecycle(snapshot, { mfeBps: 35, netCurrentBps: -10 });
        const result = new PositionManager().evaluate({
            accountAddress: "0xabc",
            network: "testnet",
            now: new Date(snapshot.timestamp * 1000),
            snapshot,
            openLifecycles: [lifecycle],
            openOrders: [protectedStop()],
            config: DEFAULT_AGENT_CONFIG
        });

        expect(result.portfolioFlags.blockNewEntries).toBe(true);
        expect(result.portfolioFlags.reasonCodes).toContain("OPEN_WAS_GREEN_NOW_RED");
    });
});

function evaluate(args: {
    currentPrice: number;
    mfeBps: number;
    netCurrentBps?: number;
    maeBps?: number;
    regime?: "RISK_ON" | "RISK_OFF" | "CHOP";
    playbook?: string;
    holdMinutes?: number;
    bookPressure?: number;
    entryOk?: boolean;
    riskEligible?: boolean;
    trendAligned?: boolean;
    priorPartialTakenFraction?: number;
    openOrders?: ManagedOpenOrder[];
}) {
    const snapshot = snapshotFor(args);
    const result = new PositionManager().evaluate({
        accountAddress: "0xabc",
        network: "testnet",
        now: new Date(snapshot.timestamp * 1000),
        snapshot,
        openLifecycles: [managedLifecycle(snapshot, args)],
        openOrders: args.openOrders ?? [protectedStop(), takeProfitAt(101.5)],
        config: DEFAULT_AGENT_CONFIG
    });
    return result.actions[0];
}

function managedLifecycle(snapshot: StateSnapshot, args: {
    mfeBps: number;
    netCurrentBps?: number;
    maeBps?: number;
    playbook?: string;
    holdMinutes?: number;
    priorPartialTakenFraction?: number;
}): ManagedLifecycleState {
    const position = snapshot.account.current_positions[0];
    const market = snapshot.markets[position.symbol];
    const grossCurrentBps = ((market.price - 100) / 100) * 10000;
    const netCurrentBps = args.netCurrentBps ?? grossCurrentBps - 9.5;
    const peakUnrealizedPnlUsd = position.size_usd * (args.mfeBps / 10000);
    return {
        lifecycleId: "life-1",
        symbol: position.symbol,
        side: position.side,
        openedAt: new Date((snapshot.timestamp - (args.holdMinutes ?? 5) * 60) * 1000),
        ageMinutes: args.holdMinutes ?? 5,
        entryPrice: 100,
        currentPrice: market.price,
        sizeUsd: position.size_usd,
        sizeCoin: position.size_coin,
        exposureFraction: position.fraction_of_equity,
        currentUnrealizedPnlUsd: position.unrealized_pnl,
        grossCurrentBps,
        estimatedFeeBps: 4.5,
        netCurrentBps,
        mfeBps: args.mfeBps,
        maeBps: args.maeBps ?? Math.min(0, grossCurrentBps),
        givebackPct: args.mfeBps > 0 ? Math.min(300, Math.max(0, ((args.mfeBps - Math.max(netCurrentBps, 0)) / args.mfeBps) * 100)) : null,
        peakUnrealizedPnlUsd,
        drawdownFromPeakUsd: peakUnrealizedPnlUsd - position.unrealized_pnl,
        playbook: args.playbook ?? "Momentum:long",
        basePlaybook: (args.playbook ?? "Momentum:long").includes("Mean Reversion") ? "Mean Reversion" : "Momentum",
        entryReasonCode: null,
        entryConfidence: null,
        regimeAtEntry: snapshot.global_regime.current,
        currentRegime: snapshot.global_regime.current,
        marketTags: [],
        marketSignal: {
            edgeOk: true,
            entryOk: true,
            riskEligible: true,
            bookPressure: market.orderbook.book_pressure,
            bookPressureAlignment: "supportive",
            trendAligned: true,
            volRatio5mVs1h: 1,
            retSigma5mVs1h: 1,
            reasonsFailed: []
        },
        priorManagementState: args.priorPartialTakenFraction !== undefined ? {
            partialTakenFraction: args.priorPartialTakenFraction
        } : null
    };
}

function protectedStop(): ManagedOpenOrder {
    return stopAt(100.1);
}

function stopAt(px: number): ManagedOpenOrder {
    return {
        symbol: "BTC-PERP",
        side: "sell",
        positionSide: "long",
        orderRole: "STOP_LOSS",
        oid: `stop-${px}`,
        reduceOnly: true,
        px: null,
        triggerPx: px,
        sizeCoin: 1,
        sizeUsd: 100,
        status: "RESTING"
    };
}

function takeProfitAt(px: number): ManagedOpenOrder {
    return {
        symbol: "BTC-PERP",
        side: "sell",
        positionSide: "long",
        orderRole: "TAKE_PROFIT",
        oid: `tp-${px}`,
        reduceOnly: true,
        px: null,
        triggerPx: px,
        sizeCoin: 1,
        sizeUsd: 100,
        status: "RESTING"
    };
}

function snapshotFor(args: {
    currentPrice: number;
    netCurrentBps?: number;
    regime?: "RISK_ON" | "RISK_OFF" | "CHOP";
    playbook?: string;
    holdMinutes?: number;
    bookPressure?: number;
    entryOk?: boolean;
    riskEligible?: boolean;
    trendAligned?: boolean;
}): StateSnapshot {
    const currentBps = ((args.currentPrice - 100) / 100) * 10000;
    return {
        timestamp: 1777231800,
        account: {
            equity_usd: 10000,
            daily_realized_pnl: 0,
            current_positions: [{
                symbol: "BTC-PERP",
                side: "long",
                size_usd: 1000,
                size_coin: 10,
                fraction_of_equity: 0.1,
                entry_price: 100,
                unrealized_pnl: 1000 * (currentBps / 10000),
                leverage: 1,
                position_age_min: args.holdMinutes ?? 5,
                playbook_when_opened: args.playbook ?? "Momentum:long"
            } as any],
            derived_portfolio: {
                total_exposure_fraction: 0.1,
                remaining_capacity: 0.9,
                position_slots_used: 1,
                slots_remaining: 4
            },
            max_daily_loss: 500
        },
        markets: {
            "BTC-PERP": {
                symbol: "BTC-PERP",
                price: args.currentPrice,
                spread_bps: 1,
                orderbook: {
                    book_pressure: args.bookPressure ?? 0.2,
                    bid_liquidity_usd: 100000,
                    ask_liquidity_usd: 100000
                },
                returns: { m5: 0, m15: 0, h1: 0 },
                vol_zscores: { vol_5m_vs_1h: 1, ret_5m_vs_1h: 1 },
                funding: { current_8h: 0 },
                open_interest: { current: 1000000 },
                sentiment: { score: 0, mentionsVsBaseline: 0, disagreement: 0, change2h: 0 },
                derived: {
                    costs: { fees_bps: 3.5, slippage_bps_est: 1, cost_bps: 4.5, cost_ok: true },
                    edge: { expected_move_bps: 40, edge_bps: 35, edge_ok: true },
                    technicals: { high_low: {}, bb_width_m5: 0.01 },
                    triggers: {
                        direction_m15: 1,
                        direction_h1: 1,
                        trend_aligned: args.trendAligned ?? true,
                        momentum_ok_long: true,
                        momentum_ok_short: false,
                        mr_ok_long: false,
                        mr_ok_short: false,
                        breakout_ok: false
                    },
                    liquidity: { min_depth_usd: 100000, depth_ok: true, tradeable: true },
                    normalized: { ret_sigma_5m_vs_1h: 1, vol_ratio_5m_vs_1h: 1 },
                    entry: { entry_ok: args.entryOk ?? true, edge_to_cost_mult: 5 },
                    risk: { eligible: args.riskEligible ?? true, eligible_playbooks: ["Momentum:long"], best_anchor_key: "atr_pct.m5", best_anchor_value: 0.01 }
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
            daily_loss_kill_switch_fraction: DEFAULT_AGENT_CONFIG.risk.daily_loss_kill_switch_fraction
        },
        allowed_actions: ["OPEN_POSITION", "REDUCE_POSITION", "CLOSE_POSITION", "HOLD_POSITION", "SKIP"],
        meta: { note: "test" },
        global_regime: { current: args.regime ?? "RISK_ON", score: 1, reason: "test" },
        presets: { agent: DEFAULT_AGENT_CONFIG, screening: {} as any }
    } as StateSnapshot;
}
