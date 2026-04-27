import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_CONFIG } from '@/lib/agent-config';
import { OrchestratorService } from '@/services/OrchestratorService';

const mockBuildSnapshot = vi.fn();
const mockAssess = vi.fn();

vi.mock('@/services/SnapshotBuilder', () => ({
    SnapshotBuilder: vi.fn().mockImplementation(() => ({
        buildSnapshot: mockBuildSnapshot,
    })),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        marketStateSnapshot: {
            create: vi.fn().mockResolvedValue({ id: 88 }),
            update: vi.fn().mockResolvedValue({ id: 88 }),
        },
        llmQuery: { create: vi.fn().mockResolvedValue({ id: 'llm-2' }) },
        candidateJournal: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
        analysisJob: {
            create: vi.fn(),
            update: vi.fn(),
            findUnique: vi.fn(),
        },
    },
}));

vi.mock('@/lib/risk/RiskCheckModule', () => ({
    RiskCheckModule: vi.fn().mockImplementation(() => ({
        assess: mockAssess,
    })),
}));

vi.mock('@/lib/log/tradingLogger', () => ({
    TradingLogger: vi.fn().mockImplementation(() => ({
        logDecision: vi.fn().mockResolvedValue(undefined),
    })),
}));

vi.mock('@/lib/hyperliquid', () => ({
    placeOrder: vi.fn(),
    updateLeverage: vi.fn(),
}));

function snapshotWithCandidate() {
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
                slots_remaining: 3,
            },
        },
        markets: {
            'BTC-PERP': {
                symbol: 'BTC-PERP',
                assetIndex: 0,
                price: 50000,
                spread_bps: 1,
                orderbook: {
                    book_pressure: 0.55,
                    bid_liquidity_usd: 100000,
                    ask_liquidity_usd: 80000,
                },
                atr_pct: { m5: 0.01, h1: 0.02 },
                derived: {
                    rank: 1,
                    costs: { cost_bps: 2 },
                    edge: { edge_ok: true, edge_bps: 50 },
                    entry: { entry_ok: true, edge_to_cost_mult: 25, reasons_failed: [] },
                    liquidity: { tradeable: true, min_depth_usd: 80000 },
                    normalized: { vol_ratio_5m_vs_1h: 2.4, ret_sigma_5m_vs_1h: 2.1 },
                    triggers: { trend_aligned: true },
                    risk: {
                        eligible: true,
                        eligible_playbooks: ['Momentum:long'],
                        best_anchor_key: 'atr_pct.m5',
                        best_anchor_value: 0.01,
                        trigger_diagnostics: {
                            has_hard_trigger: true,
                            triggered_playbooks: ['Momentum:long'],
                            trigger_profile: 'test',
                            trigger_margin: { vol_ratio_margin: 0.9, book_pressure_margin: 0.25 },
                        },
                    },
                },
            },
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
            max_new_trades_allowed: 1,
        },
        allowed_actions: ['OPEN_POSITION', 'REDUCE_POSITION', 'CLOSE_POSITION', 'HOLD_POSITION', 'SKIP'],
        meta: { note: 'test' },
        global_regime: { current: 'RISK_ON', score: 1, reason: 'test' },
        presets: { agent: DEFAULT_AGENT_CONFIG, screening: {} },
    } as any;
}

describe('Trader agent orchestration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = vi.fn();
        mockBuildSnapshot.mockResolvedValue(snapshotWithCandidate());
        mockAssess.mockReturnValue({ approved: true, reason: 'Approved' });
    });

    it('returns a backend-enriched decision for a valid candidate open', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                response: JSON.stringify({
                    decisions: [{
                        scope: 'candidate',
                        action: 'OPEN_POSITION',
                        candidate_id: 'BTC-PERP:long:Momentum',
                        symbol: 'BTC-PERP',
                        target_side: 'long',
                        target_size_fraction_of_equity: 0.05,
                        playbook: 'Momentum:long',
                        confidence: 0.65,
                        reason_code: 'momentum_edge',
                        notes: 'Hard momentum trigger with acceptable size.',
                    }],
                }),
            }),
        });

        const result = await new OrchestratorService().analyzeMarket('0xUser', false, 'model-v1', true);

        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0].risk_plan).toEqual({
            stop_loss_pct: expect.any(Number),
            take_profit_pct_primary: expect.any(Number),
        });
        expect(result.decisions[0].audit?.validator_status).toBe('accepted');
        expect(mockAssess).toHaveBeenCalledOnce();
    });

    it('creates no trade when the LLM call fails', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: false,
            text: async () => 'LLM unavailable',
        });

        const result = await new OrchestratorService().analyzeMarket('0xUser', false, 'model-v1', true);

        expect(result.decisions).toEqual([]);
        expect(mockAssess).not.toHaveBeenCalled();
    });
});
