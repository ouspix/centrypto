import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorService } from '@/services/OrchestratorService';

// Mock dependencies
vi.mock('@/services/SnapshotBuilder', () => ({
    SnapshotBuilder: vi.fn().mockImplementation(() => ({
        buildSnapshot: vi.fn().mockResolvedValue({
            account: { equity: 10000 },
            markets: { 'BTC-PERP': { price: 50000 } }
        })
    }))
}));

vi.mock('@/lib/risk/RiskCheckModule', () => ({
    RiskCheckModule: vi.fn().mockImplementation(() => ({
        assess: vi.fn().mockReturnValue({
            approved: true,
            modifiedOrder: { asset: 0, isBuy: true, limitPx: 50000, sz: 0.1, reduceOnly: false },
            reason: "Approved"
        })
    }))
}));

vi.mock('@/lib/hyperliquidExecution', () => ({
    ExecutionEngine: vi.fn().mockImplementation(() => ({
        placeOrder: vi.fn().mockResolvedValue({ status: 'ok', response: { type: 'order', data: { status: 'ok', oid: 123 } } })
    }))
}));

vi.mock('@/lib/log/tradingLogger', () => ({
    TradingLogger: vi.fn().mockImplementation(() => ({
        logDecision: vi.fn().mockResolvedValue(undefined)
    }))
}));

// Mock global fetch
global.fetch = vi.fn();

describe('OrchestratorService', () => {
    let orchestrator: OrchestratorService;

    beforeEach(() => {
        vi.clearAllMocks();
        orchestrator = new OrchestratorService();
    });

    it('should analyze market and return decision', async () => {
        // Mock Ollama response
        const mockDecision = {
            action: "OPEN_POSITION",
            symbol: "BTC-PERP",
            side: "long",
            size_fraction_of_equity: 0.1,
            risk_plan: { stop_loss_pct: 0.02, take_profit_pct_primary: 0.05 },
            playbook: "trend_follow",
            confidence: 0.9,
            reason_code: "trend_follow",
            notes: "Bullish trend"
        };

        (global.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({ response: JSON.stringify(mockDecision) })
        });

        const result = await orchestrator.analyzeMarket("0xUser", true, "model-v1", true);

        expect(result).toBeDefined();
        expect(result.decision).toEqual(mockDecision);
        expect(result.riskAssessment.approved).toBe(true);
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/generate'),
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('OPEN_POSITION') // Check if prompt contains instructions
            })
        );
    });

    it('should handle LLM failure with fallback', async () => {
        // Mock Ollama failure
        (global.fetch as any).mockResolvedValue({
            ok: false
        });

        const result = await orchestrator.analyzeMarket("0xUser", false, "model-v1", true);

        expect(result.decision.action).toBe("DO_NOTHING");
        expect(result.decision.reason_code).toBe("error_fallback");
    });
});
