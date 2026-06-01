import { describe, expect, it } from "vitest";
import { MarketStructureService } from "@/services/MarketStructureService";
import { MarketEntry } from "@/types/snapshot";

describe("MarketStructureService", () => {
    it("classifies a 20% pump as an upward impulse", () => {
        const structure = new MarketStructureService().compute(market({
            symbol: "FARTCOIN-PERP",
            returns: { m5: 0.02, m15: 0.08, h1: 0.20, h4: 0.18 },
            retSigma: 3,
            volRatio: 2.2
        }));

        expect(structure.absMoveBps.h1).toBe(2000);
        expect(structure.impulse.direction).toBe("up");
        expect(structure.impulse.impulseBps).toBe(2000);
        expect(structure.volume.volumeSpike).toBe(true);
    });

    it("keeps flat symbols structurally quiet unless participation says otherwise", () => {
        const structure = new MarketStructureService().compute(market({
            symbol: "BTC-PERP",
            returns: { m5: 0, m15: 0.0001, h1: 0.0002, h4: 0.0002 },
            retSigma: 0.1,
            volRatio: 0.9
        }));

        expect(structure.impulse.direction).toBe("none");
        expect(structure.volume.volumeSpike).toBe(false);
        expect(structure.range.rangeExpansionRatio).toBeLessThan(1.5);
    });
});

function market(input: {
    symbol: string;
    returns: { m5: number; m15: number; h1: number; h4: number };
    retSigma: number;
    volRatio: number;
}): MarketEntry {
    return {
        symbol: input.symbol,
        price: 1,
        spread_bps: 2,
        orderbook: {
            book_pressure: 0.35,
            bid_liquidity_usd: 100_000,
            ask_liquidity_usd: 100_000
        },
        returns: input.returns,
        vol_zscores: { vol_5m_vs_1h: input.volRatio, ret_5m_vs_1h: input.retSigma },
        realized_vol: { m1: 0.001, m5: 0.002, m15: 0.002, h1: 0.003, h4: 0.003 },
        funding: { current_8h: 0, delta_5m: 0 },
        open_interest: { current: 1_000_000, delta_5m: 10_000 },
        sentiment: { score: 0, mentionsVsBaseline: 0, disagreement: 0, change2h: 0 }
    };
}
