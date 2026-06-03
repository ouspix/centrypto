import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_CONFIG } from '@/lib/agent-config';
import { OrchestratorService } from '@/services/OrchestratorService';

const mockBuildSnapshot = vi.fn();
const mockAssess = vi.fn();
const mockPlaceOrder = vi.fn();
const mockPlaceOrderWithPrivateKey = vi.fn();
const mockPlaceTriggerOrdersWithPrivateKey = vi.fn();
const mockUpdateLeverageWithPrivateKey = vi.fn();
const mockAssertWalletExecutionAllowed = vi.fn();
const mockGetUserHyperliquidApiWalletCredential = vi.fn();
const mockMarkHyperliquidApiWalletUsed = vi.fn();
const analysisJobState = vi.hoisted(() => ({
    jobs: new Map<string, any>(),
    nextId: 1
}));

vi.mock('@/services/SnapshotBuilder', () => ({
    SnapshotBuilder: vi.fn().mockImplementation(() => ({
        buildSnapshot: mockBuildSnapshot,
    })),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        marketStateSnapshot: {
            create: vi.fn().mockResolvedValue({ id: 77 }),
            update: vi.fn().mockResolvedValue({ id: 77 }),
        },
        llmQuery: { create: vi.fn().mockResolvedValue({ id: 'llm-1' }) },
        candidateJournal: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
        analysisJob: {
            count: vi.fn(({ where }) => Promise.resolve(Array.from(analysisJobState.jobs.values()).filter(job => {
                if (where.userAddress !== undefined && job.userAddress !== where.userAddress) return false;
                if (where.status !== undefined && job.status !== where.status) return false;
                return true;
            }).length)),
            create: vi.fn(({ data }) => {
                const job = {
                    id: `job-${analysisJobState.nextId++}`,
                    createdAt: new Date(`2026-04-30T00:00:0${analysisJobState.nextId}Z`),
                    updatedAt: new Date("2026-04-30T00:00:00Z"),
                    completedAt: null,
                    result: null,
                    error: null,
                    ...data
                };
                analysisJobState.jobs.set(job.id, job);
                return Promise.resolve(job);
            }),
            update: vi.fn(({ where, data }) => {
                const job = analysisJobState.jobs.get(where.id);
                if (!job) return Promise.reject(new Error("job not found"));
                const updated = { ...job, ...data, updatedAt: new Date("2026-04-30T00:01:00Z") };
                analysisJobState.jobs.set(where.id, updated);
                return Promise.resolve(updated);
            }),
            findUnique: vi.fn(({ where }) => Promise.resolve(analysisJobState.jobs.get(where.id) ?? null)),
            findFirst: vi.fn(({ where }) => {
                const job = Array.from(analysisJobState.jobs.values())
                    .filter(item => {
                        if (where.userAddress !== undefined && item.userAddress !== where.userAddress) return false;
                        if (where.status !== undefined && item.status !== where.status) return false;
                        return true;
                    })
                    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
                return Promise.resolve(job);
            }),
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
    placeOrder: (...args: any[]) => mockPlaceOrder(...args),
    updateLeverage: vi.fn().mockResolvedValue({ status: 'ok' }),
}));

vi.mock('@/lib/hyperliquid-execution', () => ({
    nextExchangeNonce: vi.fn(() => 1770000000000),
    placeOrderWithPrivateKey: (...args: any[]) => mockPlaceOrderWithPrivateKey(...args),
    placeTriggerOrdersWithPrivateKey: (...args: any[]) => mockPlaceTriggerOrdersWithPrivateKey(...args),
    updateLeverageWithPrivateKey: (...args: any[]) => mockUpdateLeverageWithPrivateKey(...args),
}));

vi.mock('@/lib/risk/execution-safety', () => ({
    assertWalletExecutionAllowed: (...args: any[]) => mockAssertWalletExecutionAllowed(...args),
}));

vi.mock('@/lib/hyperliquid-api-wallet', () => ({
    HyperliquidApiWalletError: class HyperliquidApiWalletError extends Error {
        status: number;
        constructor(message: string, status = 400) {
            super(message);
            this.status = status;
        }
    },
    getUserHyperliquidApiWalletCredential: (...args: any[]) => mockGetUserHyperliquidApiWalletCredential(...args),
    markHyperliquidApiWalletUsed: (...args: any[]) => mockMarkHyperliquidApiWalletUsed(...args),
}));

function snapshotWithCandidateAndPosition() {
    return {
        timestamp: 1777231828,
        account: {
            equity_usd: 10000,
            daily_realized_pnl: 0,
            daily_total_pnl_usd: 0,
            max_daily_loss: 300,
            current_positions: [{
                symbol: 'ETH-PERP',
                side: 'long',
                size_usd: 1000,
                fraction_of_equity: 0.1,
                entry_price: 3000,
                unrealized_pnl: 25,
                leverage: 1,
            }],
            derived_portfolio: {
                total_exposure_fraction: 0.1,
                remaining_capacity: 0.4,
                position_slots_used: 1,
                slots_remaining: 2,
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
                        eligible_playbooks: ['Momentum:long', 'Breakout:long'],
                        best_anchor_key: 'atr_pct.m5',
                        best_anchor_value: 0.01,
                        trigger_diagnostics: {
                            has_hard_trigger: true,
                            triggered_playbooks: ['Momentum:long', 'Breakout:long'],
                            trigger_profile: 'test',
                            trigger_margin: { vol_ratio_margin: 0.9, book_pressure_margin: 0.25 },
                        },
                    },
                },
            },
            'ETH-PERP': {
                symbol: 'ETH-PERP',
                assetIndex: 1,
                price: 3000,
                spread_bps: 1,
                orderbook: {
                    book_pressure: 0.2,
                    bid_liquidity_usd: 70000,
                    ask_liquidity_usd: 60000,
                },
                atr_pct: { m5: 0.01, h1: 0.02 },
                derived: {
                    rank: 2,
                    costs: { cost_bps: 2 },
                    edge: { edge_ok: true, edge_bps: 30 },
                    entry: { entry_ok: true, edge_to_cost_mult: 15, reasons_failed: [] },
                    liquidity: { tradeable: true, min_depth_usd: 60000 },
                    normalized: { vol_ratio_5m_vs_1h: 1.3, ret_sigma_5m_vs_1h: 0.8 },
                    triggers: { trend_aligned: true },
                    risk: {
                        eligible: true,
                        eligible_playbooks: [],
                        best_anchor_key: 'atr_pct.m5',
                        best_anchor_value: 0.01,
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

function snapshotWithoutWork() {
    const snapshot = snapshotWithCandidateAndPosition();
    snapshot.account.current_positions = [];
    snapshot.account.derived_portfolio = {
        total_exposure_fraction: 0,
        remaining_capacity: 0.5,
        position_slots_used: 0,
        slots_remaining: 2,
    };

    for (const market of Object.values(snapshot.markets) as any[]) {
        market.derived.edge.edge_ok = false;
        market.derived.edge.edge_bps = 1;
        market.derived.entry = { entry_ok: false, edge_to_cost_mult: 0.5, reasons_failed: ['EDGE_GATE'] };
        market.derived.risk = {
            eligible: false,
            eligible_playbooks: [],
            best_anchor_key: null,
            best_anchor_value: null,
            trigger_diagnostics: {
                has_hard_trigger: false,
                triggered_playbooks: [],
                trigger_profile: 'test',
                trigger_margin: {},
            },
        };
    }

    return snapshot;
}

describe('OrchestratorService trader-only loop', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        analysisJobState.jobs.clear();
        analysisJobState.nextId = 1;
        mockBuildSnapshot.mockResolvedValue(snapshotWithCandidateAndPosition());
        mockAssess.mockReturnValue({ approved: true, reason: 'Approved' });
        mockAssertWalletExecutionAllowed.mockResolvedValue(undefined);
        mockGetUserHyperliquidApiWalletCredential.mockResolvedValue({ privateKey: '0xapi-key' });
        mockUpdateLeverageWithPrivateKey.mockResolvedValue({ status: 'ok' });
        mockPlaceOrderWithPrivateKey.mockResolvedValue({ status: 'ok', response: { data: { statuses: [{ oid: 123 }] } } });
        mockPlaceTriggerOrdersWithPrivateKey.mockResolvedValue({ status: 'ok', response: { data: { statuses: [{ resting: { oid: 456 } }, { resting: { oid: 457 } }] } } });
        mockMarkHyperliquidApiWalletUsed.mockResolvedValue(undefined);
        global.fetch = vi.fn();
    });

    it('sends TraderContext instead of raw market snapshots to the LLM', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                response: JSON.stringify({
                    decisions: [{
                        scope: 'candidate',
                        action: 'SKIP',
                        candidate_id: 'BTC-PERP:long:Momentum',
                        symbol: 'BTC-PERP',
                        target_side: 'flat',
                        target_size_fraction_of_equity: 0,
                        playbook: null,
                        confidence: 0.4,
                        reason_code: 'skip',
                        notes: 'Hard trigger exists but position exposure argues for skipping.',
                    }],
                }),
            }),
        });

        const result = await new OrchestratorService().analyzeMarket('0xUser', false, 'test-model', true);
        const requestBody = (global.fetch as any).mock.calls
            .map((call: any[]) => JSON.parse(call[1].body))
            .find((body: any) => typeof body.prompt === 'string');

        expect(requestBody.prompt).toContain('TRADER_CONTEXT');
        expect(requestBody.prompt).toContain('"eligible_candidates"');
        expect(requestBody.prompt).toContain('"existing_positions"');
        expect(requestBody.prompt).not.toContain('MARKET SNAPSHOT');
        expect(result.decisions[0].action).toBe('SKIP');
    });

    it('rejects invalid LLM output before risk assessment or execution', async () => {
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
                        target_size_fraction_of_equity: 99,
                        playbook: 'Momentum:long',
                        confidence: 0.9,
                        reason_code: 'momentum_edge',
                        notes: 'Oversized invalid decision.',
                    }],
                }),
            }),
        });

        const result = await new OrchestratorService().analyzeMarket('0xUser', true, 'test-model', true);

        expect(result.decisions).toEqual([]);
        expect(result.riskAssessments[0].approved).toBe(false);
        expect(result.riskAssessments[0].reason).toContain('size_exceeds_max');
        expect(mockAssess).not.toHaveBeenCalled();
        expect(mockPlaceOrder).not.toHaveBeenCalled();
    });

    it('returns skip diagnostics without calling the LLM when there is no trader work', async () => {
        mockBuildSnapshot.mockResolvedValue(snapshotWithoutWork());

        const result = await new OrchestratorService().analyzeMarket('0xUser', false, 'test-model', true);

        expect(global.fetch).not.toHaveBeenCalled();
        expect(result.decisions).toEqual([]);
        expect(result.llmStatus?.status).toBe('skipped');
        expect(result.llmStatus?.reason_code).toBe('NO_ELIGIBLE_CANDIDATES_NO_POSITIONS');
        expect(result.llmStatus?.diagnostics?.screened_market_count).toBe(2);
        expect(result.llmStatus?.diagnostics?.rejection_counts.EDGE_GATE).toBe(2);
        expect(result.rawOutput).toContain('EDGE_GATE');
    });

    it('passes the persisted Discovery Balanced screener config to SnapshotBuilder', async () => {
        mockBuildSnapshot.mockResolvedValue(snapshotWithoutWork());

        await new OrchestratorService().runAutonomousTraderCycle(
            '0xUser',
            'test-model',
            true,
            { screenerPresetName: 'Discovery Balanced' }
        );

        const screenerConfig = mockBuildSnapshot.mock.calls[0][3];
        expect(screenerConfig.discoveryMaxSymbols).toBe(40);
        expect(screenerConfig.hotMoverTopN).toBe(12);
        expect(screenerConfig.maxSpreadBps).toBe(15);
        expect(screenerConfig.minDepthUsd).toBe(20_000);
    });

    it.each([
        ['mainnet', false],
        ['testnet', true],
    ] as const)('routes auto-trading execution to %s network', async (_network, isTestnet) => {
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
                        target_size_fraction_of_equity: 0.005,
                        playbook: 'Momentum:long',
                        confidence: 0.9,
                        reason_code: 'momentum_edge',
                        notes: 'Hard trigger with approved risk.',
                    }],
                }),
            }),
        });
        mockAssess.mockReturnValue({
            approved: true,
            reason: 'Approved',
            modifiedOrder: { side: 'buy', sizeUsd: 500 }
        });

        await new OrchestratorService().analyzeMarket('0xUser', true, 'test-model', isTestnet);

        expect(mockAssess).toHaveBeenCalled();
        expect(mockAssertWalletExecutionAllowed).toHaveBeenCalledWith('0xUser', isTestnet);
        expect(mockUpdateLeverageWithPrivateKey.mock.calls[0][2]).toBe(isTestnet);
        expect(mockPlaceOrderWithPrivateKey.mock.calls[0][2]).toBe(isTestnet);
    });

    it('places brackets from actual entry fill average price and filled size', async () => {
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
                        target_size_fraction_of_equity: 0.005,
                        playbook: 'Momentum:long',
                        confidence: 0.9,
                        reason_code: 'momentum_edge',
                        notes: 'Hard trigger with approved risk.',
                    }],
                }),
            }),
        });
        mockAssess.mockReturnValue({
            approved: true,
            reason: 'Approved',
            modifiedOrder: { side: 'buy', sizeUsd: 500 }
        });
        mockPlaceOrderWithPrivateKey.mockResolvedValue({
            status: 'ok',
            response: {
                data: {
                    statuses: [{
                        filled: { oid: 123, avgPx: '50100', totalSz: '0.01' }
                    }]
                }
            }
        });

        await new OrchestratorService().analyzeMarket('0xUser', true, 'test-model', true);

        const entryOrder = mockPlaceOrderWithPrivateKey.mock.calls[0][1];
        expect(entryOrder.stopLossPrice).toBeUndefined();
        expect(entryOrder.takeProfitPrice).toBeUndefined();

        const triggerOrder = mockPlaceTriggerOrdersWithPrivateKey.mock.calls[0][1];
        expect(triggerOrder.sz).toBe(0.01);
        expect(triggerOrder.stopLossPrice).toBeCloseTo(50100 * (1 - 0.012));
        expect(triggerOrder.takeProfitPrice).toBeCloseTo(50100 * (1 + 0.024));
    });

    it('allows one running and one queued analysis job per wallet during bursts', async () => {
        const service = new OrchestratorService();
        (service as any).runAnalysisJob = vi.fn().mockResolvedValue(undefined);
        const userAddress = '0x1234567890abcdef1234567890abcdef12345678';

        const results = await Promise.allSettled([
            service.analyzeMarketWithJobTracking(userAddress, 'model-v1', true),
            service.analyzeMarketWithJobTracking(userAddress, 'model-v1', true),
            service.analyzeMarketWithJobTracking(userAddress, 'model-v1', true)
        ]);

        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
        expect(Array.from(analysisJobState.jobs.values()).map(job => job.status).sort()).toEqual(['pending', 'running']);
        expect((service as any).runAnalysisJob).toHaveBeenCalledTimes(1);
    });
});
