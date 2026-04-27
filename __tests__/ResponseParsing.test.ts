import { describe, expect, it } from 'vitest';
import { parseTraderResponse } from '@/lib/llm/LlmResponseParser';

describe('Trader response parsing robustness', () => {
    it('handles direct arrays of trader decisions', () => {
        const response = `[
            {
                "scope": "candidate",
                "action": "OPEN_POSITION",
                "candidate_id": "BTC-PERP:long:Momentum",
                "symbol": "BTC-PERP",
                "target_side": "long",
                "target_size_fraction_of_equity": 0.05,
                "playbook": "Momentum:long",
                "confidence": 0.64,
                "reason_code": "momentum_edge",
                "notes": "Hard trigger with modest size."
            }
        ]`;

        const result = parseTraderResponse(response);

        expect(result).toHaveLength(1);
        expect(result[0].candidate_id).toBe('BTC-PERP:long:Momentum');
    });

    it('handles a single trader decision object', () => {
        const response = `{
            "scope": "position",
            "action": "CLOSE_POSITION",
            "candidate_id": null,
            "symbol": "ETH-PERP",
            "target_side": "flat",
            "target_size_fraction_of_equity": 0,
            "playbook": null,
            "confidence": 0.72,
            "reason_code": "risk_reduction",
            "notes": "Edge failed and close is allowed."
        }`;

        const result = parseTraderResponse(response);

        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe('ETH-PERP');
        expect(result[0].scope).toBe('position');
    });

    it('extracts JSON wrapped in extra text', () => {
        const response = `Here is the plan:
        {
            "decisions": [
                {
                    "scope": "position",
                    "action": "HOLD_POSITION",
                    "candidate_id": null,
                    "symbol": "SOL-PERP",
                    "target_side": "long",
                    "target_size_fraction_of_equity": 0.2,
                    "playbook": null,
                    "confidence": 0.58,
                    "reason_code": "position_management",
                    "notes": "Signals remain supportive."
                }
            ]
        }`;

        const result = parseTraderResponse(response);

        expect(result).toHaveLength(1);
        expect(result[0].action).toBe('HOLD_POSITION');
    });
});
