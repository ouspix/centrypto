import { describe, expect, it } from "vitest";
import { RegimeService } from "@/services/RegimeService";
import { MarketEntry } from "@/types/snapshot";

function market(ret15m: number, volZ: number, depth = 100_000): MarketEntry {
    return {
        symbol: "",
        price: 100,
        spread_bps: 1,
        orderbook: {
            book_pressure: 0,
            bid_liquidity_usd: depth,
            ask_liquidity_usd: depth
        },
        returns: {
            m5: ret15m / 3,
            m15: ret15m,
            h1: ret15m
        },
        vol_zscores: {
            vol_5m_vs_1h: volZ,
            ret_5m_vs_1h: 0
        },
        funding: { current_8h: 0 },
        open_interest: { current: 0 },
        sentiment: {
            score: 0,
            mentionsVsBaseline: 0,
            disagreement: 0,
            change2h: 0
        }
    };
}

function regimeGroup(symbol: string): MarketEntry["regime"] {
    if (symbol === "BTC-PERP") return { group: "major", weight: 3 };
    if (symbol === "ETH-PERP") return { group: "major", weight: 2.5 };
    if (["SOL-PERP", "BNB-PERP", "XRP-PERP", "DOGE-PERP"].includes(symbol)) return { group: "core", weight: 1.5 };
    return { group: "alt", weight: 0.5 };
}

function withSymbols(entries: Record<string, MarketEntry>) {
    return Object.fromEntries(
        Object.entries(entries).map(([symbol, entry]) => [symbol, { ...entry, symbol, regime: regimeGroup(symbol) }])
    );
}

describe("RegimeService", () => {
    it("returns CHOP when no valid market data is available", () => {
        const result = new RegimeService().infer({});

        expect(result.current).toBe("CHOP");
        expect(result.score).toBe(0);
        expect(result.reason).toContain("no valid market data");
    });

    it("does not call broad alt strength RISK_ON when BTC and ETH do not confirm", () => {
        const result = new RegimeService({ confirmationsRequired: 1, minValidSymbols: 5 }).infer(withSymbols({
            "BTC-PERP": market(0, 1.4),
            "ETH-PERP": market(-0.0001, 1.4),
            "SOL-PERP": market(0.006, 1.6),
            "HYPE-PERP": market(0.008, 1.8),
            "ZRO-PERP": market(0.007, 1.7)
        }));

        expect(result.current).toBe("CHOP");
        expect(result.reason).toContain("mixed signals");
    });

    it("requires consecutive confirmation before switching into RISK_ON", () => {
        const service = new RegimeService({ confirmationsRequired: 2, minValidSymbols: 4 });
        const markets = withSymbols({
            "BTC-PERP": market(0.004, 1.4),
            "ETH-PERP": market(0.005, 1.3),
            "SOL-PERP": market(0.006, 1.5),
            "HYPE-PERP": market(0.007, 1.7)
        });

        const first = service.infer(markets);
        const second = service.infer(markets);

        expect(first.current).toBe("CHOP");
        expect(first.reason).toContain("pending RISK_ON confirmation 1/2");
        expect(second.current).toBe("RISK_ON");
    });

    it("switches immediately to RISK_OFF on broad high-activity downside shock", () => {
        const result = new RegimeService({ minValidSymbols: 4 }).infer(withSymbols({
            "BTC-PERP": market(-0.008, 1.8),
            "ETH-PERP": market(-0.007, 1.7),
            "SOL-PERP": market(-0.006, 1.5),
            "HYPE-PERP": market(-0.009, 1.9)
        }));

        expect(result.current).toBe("RISK_OFF");
        expect(result.reason).toContain("downside");
    });
});
