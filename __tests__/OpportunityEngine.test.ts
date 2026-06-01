import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { OpportunityEngine } from "@/lib/trader/OpportunityEngine";
import { MarketEntry } from "@/types/snapshot";

describe("OpportunityEngine", () => {
    it("does not promote execution-blocked opportunities to candidates", () => {
        const opportunity = new OpportunityEngine().evaluateMarket(market({
            symbol: "FARTCOIN-PERP",
            spreadBps: 30,
            depthUsd: 12_000,
            executionTradeable: false,
            blockReasons: ["SPREAD_GATE", "DEPTH_GATE"]
        }), DEFAULT_AGENT_CONFIG);

        expect(opportunity.status).toBe("EXECUTION_BLOCKED");
        expect(opportunity.executionTradeable).toBe(false);
        expect(opportunity.executionBlockReasons).toEqual(["SPREAD_GATE", "DEPTH_GATE"]);
        expect(opportunity.bestSetup?.score).toBeGreaterThanOrEqual(70);
    });

    it("promotes strong executable setups to candidates", () => {
        const opportunity = new OpportunityEngine().evaluateMarket(market({
            symbol: "FARTCOIN-PERP",
            spreadBps: 4,
            depthUsd: 100_000,
            executionTradeable: true,
            blockReasons: []
        }), DEFAULT_AGENT_CONFIG);

        expect(opportunity.status).toBe("CANDIDATE");
        expect(opportunity.bestSetup?.side).toBe("long");
        expect(opportunity.inPlayScore).toBeGreaterThanOrEqual(DEFAULT_AGENT_CONFIG.opportunity!.minInPlayScore);
    });
});

function market(input: {
    symbol: string;
    spreadBps: number;
    depthUsd: number;
    executionTradeable: boolean;
    blockReasons: string[];
}): MarketEntry {
    return {
        symbol: input.symbol,
        price: 1,
        spread_bps: input.spreadBps,
        orderbook: {
            book_pressure: 0.45,
            bid_liquidity_usd: input.depthUsd,
            ask_liquidity_usd: input.depthUsd
        },
        returns: { m5: 0.02, m15: 0.08, h1: 0.20, h4: 0.18 },
        vol_zscores: { vol_5m_vs_1h: 2.2, ret_5m_vs_1h: 3 },
        realized_vol: { m1: 0.001, m5: 0.002, m15: 0.002, h1: 0.001, h4: 0.001 },
        funding: { current_8h: 0, delta_5m: 0 },
        open_interest: { current: 1_000_000, delta_5m: 10_000 },
        sentiment: { score: 0, mentionsVsBaseline: 0, disagreement: 0, change2h: 0 },
        discovery: {
            reasons: ["HOT_MOVER"],
            metrics: {
                absMoveBps_m15: 800,
                absMoveBps_h1: 2000,
                absMoveBps_h4: 1800,
                maxAbsMoveBps: 2000,
                recentQuoteVolume: 100_000,
                relativeVolumeRatio: 2.2,
                rangeExpansionRatio: 2.2,
                realizedVolM5: 0.002,
                volRatio5mVs1h: 2.2,
                retSigma5mVs1h: 3
            }
        },
        execution: {
            tradeable: input.executionTradeable,
            blockReasons: input.blockReasons as any,
            spreadBps: input.spreadBps,
            depthUsd: input.depthUsd,
            costBps: input.spreadBps + 3.5 + Math.max(1, input.spreadBps * 0.5)
        }
    };
}
