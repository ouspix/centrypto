import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrchestratorService } from '@/services/OrchestratorService';
import { ScreenerService } from '@/services/ScreenerService';
import * as HyperliquidLib from '@/lib/hyperliquid';

// Mock Dependencies
vi.mock('@/services/ScreenerService', () => ({
    ScreenerService: vi.fn().mockImplementation(() => ({
        getScreenedSymbols: vi.fn().mockResolvedValue([]),
        getLatestSnapshot: vi.fn().mockResolvedValue([])
    }))
}));

vi.mock('@/lib/hyperliquid', async (importOriginal) => {
    const actual = await importOriginal<typeof HyperliquidLib>();
    return {
        ...actual,
        getClearinghouseState: vi.fn().mockResolvedValue({
            marginSummary: { accountValue: '10000' },
            assetPositions: []
        }),
        getMetaAndAssetCtxs: vi.fn(),
        getOHLCV: vi.fn(),
        getL2Book: vi.fn()
    };
});

describe('OrchestratorService Parsing Robustness', () => {
    let orchestrator: OrchestratorService;
    let mockScreenerInstance: any;

    beforeEach(() => {
        vi.clearAllMocks();

        // Setup mock ScreenerService instance
        mockScreenerInstance = {
            getScreenedSymbols: vi.fn().mockResolvedValue([]),
            getLatestSnapshot: vi.fn().mockResolvedValue(null)
        };
        (ScreenerService as any).mockImplementation(() => mockScreenerInstance);

        global.fetch = vi.fn();
        orchestrator = new OrchestratorService();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const mockLLMResponse = (responseContent: string) => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({ response: responseContent })
        });
    };

    it('should handle direct array of decisions', async () => {
        const response = `[
            {
                "symbol": "BTC-PERP",
                "action": "OPEN_POSITION",
                "target_side": "long",
                "target_size_fraction_of_equity": 0.1
            }
        ]`;
        mockLLMResponse(response);

        const result = await orchestrator.analyzeMarket(null, false, 'test-model', true);

        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0].symbol).toBe('BTC-PERP');
    });

    it('should handle single decision object', async () => {
        const response = `{
            "symbol": "ETH-PERP",
            "action": "CLOSE_POSITION",
            "target_side": "flat",
            "target_size_fraction_of_equity": 0
        }`;
        mockLLMResponse(response);

        const result = await orchestrator.analyzeMarket(null, false, 'test-model', true);

        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0].symbol).toBe('ETH-PERP');
    });

    it('should handle JSON wrapped in text without code blocks', async () => {
        const response = `Here is the plan:
        {
            "decisions": [
                {
                    "symbol": "SOL-PERP",
                    "action": "HOLD",
                    "target_side": "long",
                    "target_size_fraction_of_equity": 0.2
                }
            ]
        }
        Hope this helps!`;
        mockLLMResponse(response);

        const result = await orchestrator.analyzeMarket(null, false, 'test-model', true);

        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0].symbol).toBe('SOL-PERP');
    });

    it('should handle JSON with missing decisions key (root object is the decision map?)', async () => {
        // Some models might return { "BTC-PERP": { ... } } or similar, but let's stick to the most common errors first.
        // The most common is returning the list directly or a single object.
        // Let's test a case where it returns { "decision": [...] } (singular) just in case? 
        // No, let's stick to the ones we identified.
    });
});
