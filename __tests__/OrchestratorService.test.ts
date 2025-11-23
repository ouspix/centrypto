import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrchestratorService } from '@/services/OrchestratorService';
import { ScreenerService } from '@/services/ScreenerService';
import * as HyperliquidLib from '@/lib/hyperliquid';

// Mock ScreenerService
vi.mock('@/services/ScreenerService', () => {
    return {
        ScreenerService: vi.fn().mockImplementation(() => ({
            getScreenedSymbols: vi.fn(),
            getLatestSnapshot: vi.fn()
        }))
    };
});

// Mock Hyperliquid lib
vi.mock('@/lib/hyperliquid', async (importOriginal) => {
    const actual = await importOriginal<typeof HyperliquidLib>();
    return {
        ...actual,
        getClearinghouseState: vi.fn(),
        getMetaAndAssetCtxs: vi.fn(), // Mock if needed by other parts
        getOHLCV: vi.fn(),
        getL2Book: vi.fn()
    };
});

describe('OrchestratorService Integration', () => {
    let orchestrator: OrchestratorService;
    let mockScreenerInstance: any;

    beforeEach(() => {
        vi.clearAllMocks();

        // Setup mock ScreenerService instance
        mockScreenerInstance = {
            getScreenedSymbols: vi.fn(),
            getLatestSnapshot: vi.fn().mockResolvedValue(null)
        };
        (ScreenerService as any).mockImplementation(() => mockScreenerInstance);

        // Mock global fetch for Ollama
        global.fetch = vi.fn();

        orchestrator = new OrchestratorService();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should pass screened values AND existing positions to LLM and return decisions for entire portfolio', async () => {
        // 1. Setup Mock Data
        const mockScreenedSymbols = [
            {
                symbol: 'BTC',
                price: 50000,
                metrics: {
                    returns: { m1: 0.01, m5: 0.02, m15: 0.03, h1: 0.04, h4: 0.05 },
                    realized_vol: { m1: 0.01, m5: 0.01, m15: 0.01, h1: 0.01, h4: 0.01 },
                    vol_zscores: { vol_5m_vs_1h: 2.5, ret_5m_vs_1h: 1.5 },
                    regime_tags: ['high_vol']
                },
                bookMetrics: {
                    spread_bps: 2,
                    depth_usd: { bid_1pct: 100000, ask_1pct: 100000 },
                    imbalance: 1.2
                },
                funding: 0.0001,
                openInterest: 1000000,
                sentiment: { score: 0.8 }
            },
            {
                symbol: 'ETH',
                price: 3000,
                metrics: {
                    returns: { m1: -0.01, m5: -0.02, m15: -0.03, h1: -0.04, h4: -0.05 },
                    realized_vol: { m1: 0.02, m5: 0.02, m15: 0.02, h1: 0.02, h4: 0.02 },
                    vol_zscores: { vol_5m_vs_1h: 1.0, ret_5m_vs_1h: -1.5 },
                    regime_tags: []
                },
                bookMetrics: {
                    spread_bps: 3,
                    depth_usd: { bid_1pct: 50000, ask_1pct: 50000 },
                    imbalance: 0.8
                },
                funding: 0.0002,
                openInterest: 500000,
                sentiment: { score: -0.2 }
            },
            {
                symbol: 'SOL',
                price: 155,
                metrics: {
                    returns: { m1: 0.005, m5: 0.01, m15: 0.01, h1: 0.02, h4: 0.03 },
                    realized_vol: { m1: 0.015, m5: 0.015, m15: 0.015, h1: 0.015, h4: 0.015 },
                    vol_zscores: { vol_5m_vs_1h: 1.2, ret_5m_vs_1h: 0.8 },
                    regime_tags: []
                },
                bookMetrics: {
                    spread_bps: 4,
                    depth_usd: { bid_1pct: 20000, ask_1pct: 20000 },
                    imbalance: 1.0
                },
                funding: 0.0003,
                openInterest: 200000,
                sentiment: { score: 0.5 }
            }
        ];

        mockScreenerInstance.getScreenedSymbols.mockResolvedValue(mockScreenedSymbols);

        // Mock Existing Position (SOL)
        (HyperliquidLib.getClearinghouseState as any).mockResolvedValue({
            marginSummary: { accountValue: '10000' },
            assetPositions: [
                {
                    position: {
                        coin: 'SOL',
                        szi: '10.0', // Size
                        entryPx: '150.0',
                        unrealizedPnl: '50.0',
                        leverage: { value: '5' }
                    }
                }
            ]
        });

        // Mock LLM Response covering both new opportunities and existing positions
        const mockLLMResponse = {
            decisions: [
                {
                    symbol: 'BTC',
                    action: 'OPEN_POSITION',
                    target_side: 'long',
                    target_size_fraction_of_equity: 0.1,
                    confidence: 0.9,
                    reason_code: 'high_vol_breakout',
                    notes: 'BTC showing high volatility and positive momentum.'
                },
                {
                    symbol: 'ETH',
                    action: 'DO_NOTHING',
                    target_side: 'flat',
                    target_size_fraction_of_equity: 0,
                    confidence: 0.5,
                    reason_code: 'neutral',
                    notes: 'ETH is chopping.'
                },
                {
                    symbol: 'SOL',
                    action: 'HOLD', // Decision for existing position
                    target_side: 'long',
                    target_size_fraction_of_equity: 0.15,
                    confidence: 0.8,
                    reason_code: 'trend_continuation',
                    notes: 'Holding SOL long as trend is still intact.'
                }
            ]
        };

        (global.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                response: JSON.stringify(mockLLMResponse)
            })
        });

        // 2. Execute
        const result = await orchestrator.analyzeMarket('0xUserAddress', false, 'test-model', true);

        // 3. Verify
        // Check if Screener was called
        expect(mockScreenerInstance.getScreenedSymbols).toHaveBeenCalled();

        // Check if LLM was called with correct prompt containing screened values AND existing positions
        // Verify Result Prompt (Concatenation of System + User)
        expect(result.prompt).toContain('ROLE: Crypto Volatility Scalper AI'); // System Prompt start
        expect(result.prompt).toContain('MARKET SNAPSHOT:'); // User Prompt start
        expect(result.prompt).toContain('BTC');
        expect(result.prompt).toContain('150'); // Entry Price

        // Check if result matches LLM decision for ALL symbols
        expect(result.decisions).toHaveLength(3);

        const btcDecision = result.decisions.find(d => d.symbol === 'BTC');
        expect(btcDecision).toBeDefined();
        expect(btcDecision?.action).toBe('OPEN_POSITION');

        const ethDecision = result.decisions.find(d => d.symbol === 'ETH');
        expect(ethDecision).toBeDefined();
        expect(ethDecision?.action).toBe('DO_NOTHING');

        const solDecision = result.decisions.find(d => d.symbol === 'SOL');
        expect(solDecision).toBeDefined();
        expect(solDecision?.action).toBe('HOLD');
    });
});
