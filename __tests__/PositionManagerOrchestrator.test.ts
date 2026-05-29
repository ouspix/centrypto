import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import type { ManagedLifecycleState, ManagedOpenOrder } from "@/lib/trader/position-management-types";

const mockBuildSnapshot = vi.fn();
const mockAssess = vi.fn();
const mockReviewService = vi.hoisted(() => ({
    startRun: vi.fn(),
    finishRun: vi.fn(),
    snapshotPositions: vi.fn(),
    getManagedLifecycleStates: vi.fn(),
    persistPositionManagementResult: vi.fn(),
    persistDecisions: vi.fn(),
    updateDecisionSubmittedOrderPlan: vi.fn(),
    createOrderAttempts: vi.fn(),
    updateRunAgentWalletFromDecision: vi.fn(),
    updateRunAgentWallet: vi.fn(),
    updateOrderAttemptsFromResponse: vi.fn(),
    syncFills: vi.fn(),
    getAttemptFillSummary: vi.fn(),
    buildBracketOrderAttemptDrafts: vi.fn(),
    createPositionManagerDecision: vi.fn(),
    upsertPositionStateAfterEntryFill: vi.fn(),
    buildOrderAttemptDrafts: vi.fn()
}));
const mockOrderService = vi.hoisted(() => ({
    getOpenOrders: vi.fn(),
    cancelOcoSiblingOrders: vi.fn(),
    cancelOrders: vi.fn()
}));

vi.mock("@/services/SnapshotBuilder", () => ({
    SnapshotBuilder: vi.fn().mockImplementation(() => ({
        buildSnapshot: mockBuildSnapshot
    }))
}));

vi.mock("@/services/AutoTraderReviewService", () => ({
    AutoTraderReviewService: {
        getInstance: () => mockReviewService
    }
}));

vi.mock("@/services/AutoTraderOrderManagementService", () => ({
    AutoTraderOrderManagementService: {
        getInstance: () => mockOrderService
    }
}));

vi.mock("@/lib/risk/RiskCheckModule", () => ({
    RiskCheckModule: vi.fn().mockImplementation(() => ({
        assess: mockAssess
    }))
}));

vi.mock("@/lib/db", () => ({
    prisma: {
        marketStateSnapshot: {
            create: vi.fn().mockResolvedValue({ id: 91 }),
            update: vi.fn().mockResolvedValue({ id: 91 })
        },
        llmQuery: {
            create: vi.fn().mockResolvedValue({ id: "llm-1" })
        },
        candidateJournal: {
            createMany: vi.fn().mockResolvedValue({ count: 1 })
        }
    }
}));

vi.mock("@/lib/log/tradingLogger", () => ({
    TradingLogger: vi.fn().mockImplementation(() => ({
        logDecision: vi.fn().mockResolvedValue(undefined)
    }))
}));

vi.mock("@/lib/hyperliquid-api-wallet", () => ({
    HyperliquidApiWalletError: class HyperliquidApiWalletError extends Error {},
    getUserHyperliquidApiWalletCredential: vi.fn(),
    markHyperliquidApiWalletUsed: vi.fn()
}));

vi.mock("@/lib/hyperliquid-execution", () => ({
    nextExchangeNonce: vi.fn(() => 1770000000000),
    placeOrderWithPrivateKey: vi.fn(),
    placeTriggerOrdersWithPrivateKey: vi.fn(),
    updateLeverageWithPrivateKey: vi.fn()
}));

vi.mock("@/lib/risk/execution-safety", () => ({
    assertWalletExecutionAllowed: vi.fn()
}));

import { OrchestratorService } from "@/services/OrchestratorService";

describe("PositionManager orchestrator integration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockBuildSnapshot.mockResolvedValue(snapshotWithGreenToRedPosition());
        mockReviewService.snapshotPositions.mockResolvedValue(new Map());
        mockReviewService.persistDecisions.mockImplementation(({ backendDecisions }) => Promise.resolve(backendDecisions.map(() => null)));
        mockReviewService.getManagedLifecycleStates.mockResolvedValue([managedGreenToRedLifecycle()]);
        mockReviewService.persistPositionManagementResult.mockResolvedValue(undefined);
        mockOrderService.getOpenOrders.mockResolvedValue([protectedStop()]);
        mockAssess.mockReturnValue({
            approved: true,
            reason: "Close approved",
            modifiedOrder: { symbol: "ETH-PERP", side: "sell", sizeUsd: 1000 }
        });
        global.fetch = vi.fn();
    });

    it("runs deterministic manager actions without calling the LLM when the position is locked", async () => {
        const result = await new OrchestratorService().analyzeMarket("0xUser", false, "test-model", true);

        expect(global.fetch).not.toHaveBeenCalled();
        expect(result.llmStatus?.reason_code).toBe("POSITION_MANAGER_ONLY");
        expect(result.decisions[0].action).toBe("CLOSE_POSITION");
        expect(result.decisions[0].reason_code).toBe("OPEN_WAS_GREEN_NOW_RED");
        expect(mockAssess).toHaveBeenCalledWith(
            expect.objectContaining({ action: "CLOSE_POSITION", symbol: "ETH-PERP" }),
            expect.anything(),
            expect.anything()
        );
        expect(mockReviewService.persistPositionManagementResult).toHaveBeenCalledWith(expect.objectContaining({
            result: expect.objectContaining({
                portfolioFlags: expect.objectContaining({ blockNewEntries: true })
            })
        }));
    });
});

function managedGreenToRedLifecycle(): ManagedLifecycleState {
    return {
        lifecycleId: "life-eth",
        symbol: "ETH-PERP",
        side: "long",
        openedAt: new Date("2026-05-25T21:50:00Z"),
        ageMinutes: 15,
        entryPrice: 3000,
        currentPrice: 2990,
        sizeUsd: 1000,
        sizeCoin: 0.334,
        exposureFraction: 0.1,
        currentUnrealizedPnlUsd: -3.34,
        grossCurrentBps: -33.3333,
        estimatedFeeBps: 4.5,
        netCurrentBps: -38.3333,
        mfeBps: 35,
        maeBps: -40,
        givebackPct: 100,
        peakUnrealizedPnlUsd: 3.5,
        drawdownFromPeakUsd: 6.84,
        playbook: "Momentum:long",
        basePlaybook: "Momentum",
        entryReasonCode: null,
        entryConfidence: null,
        regimeAtEntry: "RISK_ON",
        currentRegime: "RISK_ON",
        marketTags: [],
        marketSignal: {
            edgeOk: true,
            entryOk: true,
            riskEligible: true,
            bookPressure: 0.2,
            bookPressureAlignment: "supportive",
            trendAligned: true,
            volRatio5mVs1h: 1,
            retSigma5mVs1h: 1,
            reasonsFailed: []
        },
        priorManagementState: null
    };
}

function protectedStop(): ManagedOpenOrder {
    return {
        symbol: "ETH-PERP",
        side: "sell",
        positionSide: "long",
        orderRole: "STOP_LOSS",
        oid: "stop-1",
        reduceOnly: true,
        px: null,
        triggerPx: 3001,
        sizeCoin: 0.334,
        sizeUsd: 1000,
        status: "RESTING"
    };
}

function snapshotWithGreenToRedPosition() {
    return {
        timestamp: 1777231828,
        account: {
            equity_usd: 10000,
            daily_realized_pnl: 0,
            daily_total_pnl_usd: 0,
            max_daily_loss: 300,
            current_positions: [{
                symbol: "ETH-PERP",
                side: "long",
                size_usd: 1000,
                size_coin: 0.334,
                fraction_of_equity: 0.1,
                entry_price: 3000,
                unrealized_pnl: -3.34,
                leverage: 1,
                position_age_min: 15,
                playbook_when_opened: "Momentum:long"
            }],
            derived_portfolio: {
                total_exposure_fraction: 0.1,
                remaining_capacity: 0.4,
                position_slots_used: 1,
                slots_remaining: 2
            }
        },
        markets: {
            "ETH-PERP": {
                symbol: "ETH-PERP",
                assetIndex: 1,
                price: 2990,
                spread_bps: 1,
                orderbook: {
                    book_pressure: 0.2,
                    bid_liquidity_usd: 70000,
                    ask_liquidity_usd: 60000
                },
                atr_pct: { m5: 0.01, h1: 0.02 },
                returns: { m5: 0, m15: 0, h1: 0 },
                vol_zscores: { vol_5m_vs_1h: 1, ret_5m_vs_1h: 1 },
                funding: { current_8h: 0 },
                open_interest: { current: 1000000 },
                sentiment: { score: 0, mentionsVsBaseline: 0, disagreement: 0, change2h: 0 },
                derived: {
                    rank: 2,
                    costs: { fees_bps: 3.5, slippage_bps_est: 1, cost_bps: 4.5, cost_ok: true },
                    edge: { edge_ok: true, edge_bps: 30, expected_move_bps: 40 },
                    entry: { entry_ok: true, edge_to_cost_mult: 15, reasons_failed: [] },
                    liquidity: { tradeable: true, min_depth_usd: 60000, depth_ok: true },
                    normalized: { vol_ratio_5m_vs_1h: 1, ret_sigma_5m_vs_1h: 1 },
                    triggers: { trend_aligned: true },
                    risk: {
                        eligible: true,
                        eligible_playbooks: [],
                        best_anchor_key: "atr_pct.m5",
                        best_anchor_value: 0.01
                    }
                }
            }
        },
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
        meta: { note: "test" },
        global_regime: { current: "RISK_ON", score: 1, reason: "test" },
        presets: { agent: DEFAULT_AGENT_CONFIG, screening: {} }
    } as any;
}
