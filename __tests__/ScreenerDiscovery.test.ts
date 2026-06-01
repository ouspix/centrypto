import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { SCREENER_PRESETS } from "@/lib/screener-config";
import { EnrichedMarketData, ScreenerService } from "@/services/ScreenerService";

describe("Screener discovery buckets", () => {
    it("includes a hot mover outside quality topN", () => {
        const screener = new ScreenerService(true, { disableLive: true });
        const config = {
            ...SCREENER_PRESETS["Discovery Balanced"],
            topN: 1,
            discoveryMaxSymbols: 4,
            hotMoverMinAbsMoveBps: 150,
            minRecentVolume: 0,
            minRealizedVol: 0,
            minVolume24h: 0
        };

        const discovered = screener.discoverAndRank([
            candidate("FLAT", { returns: { m5: 0, m15: 0.0001, h1: 0.0002, h4: 0.0002 }, volRatio: 5, retSigma: 5 }),
            candidate("FARTCOIN", { returns: { m5: 0.002, m15: 0.03, h1: 0.20, h4: 0.20 }, volRatio: 0.2, retSigma: 0.1, spreadBps: 12 })
        ], [], config, DEFAULT_AGENT_CONFIG);

        const flat = discovered.find(symbol => symbol.symbol === "FLAT");
        const hot = discovered.find(symbol => symbol.symbol === "FARTCOIN");

        expect(flat?.discoveryReasons).toContain("QUALITY_TOP");
        expect(hot?.discoveryReasons).toContain("HOT_MOVER");
        expect(hot?.discoveryMetrics.maxAbsMoveBps).toBe(2000);
    });

    it("keeps a bad-spread hot mover as diagnostic-only", () => {
        const screener = new ScreenerService(true, { disableLive: true });
        const config = {
            ...SCREENER_PRESETS["Discovery Balanced"],
            topN: 1,
            maxSpreadBps: 8,
            hotMoverMinAbsMoveBps: 150,
            includeExecutionBlockedForDiagnostics: true,
            minRecentVolume: 0,
            minRealizedVol: 0,
            minVolume24h: 0
        };

        const [hot] = screener.discoverAndRank([
            candidate("FARTCOIN", { returns: { m5: 0.01, m15: 0.12, h1: 0.20, h4: 0.20 }, spreadBps: 30 })
        ], [], config, DEFAULT_AGENT_CONFIG);

        expect(hot.discoveryReasons).toContain("HOT_MOVER");
        expect(hot.execution.tradeable).toBe(false);
        expect(hot.execution.blockReasons).toContain("SPREAD_GATE");
    });

    it("can still include a flat liquid symbol as quality top", () => {
        const screener = new ScreenerService(true, { disableLive: true });
        const config = {
            ...SCREENER_PRESETS["Discovery Balanced"],
            topN: 1,
            minRecentVolume: 0,
            minRealizedVol: 0,
            minVolume24h: 0
        };

        const [flat] = screener.discoverAndRank([
            candidate("BTC", { returns: { m5: 0, m15: 0.0001, h1: 0.0002, h4: 0.0002 }, volRatio: 3, retSigma: 2 })
        ], [], config, DEFAULT_AGENT_CONFIG);

        expect(flat.symbol).toBe("BTC");
        expect(flat.discoveryReasons).toContain("QUALITY_TOP");
        expect(flat.execution.tradeable).toBe(true);
    });

    it("force-includes the selected chart symbol without granting execution", () => {
        const screener = new ScreenerService(true, { disableLive: true });
        const config = {
            ...SCREENER_PRESETS["Discovery Balanced"],
            topN: 1,
            maxSpreadBps: 8,
            minRecentVolume: 0,
            minRealizedVol: 0,
            minVolume24h: 0,
            forceIncludeSymbols: ["DOGE-PERP"]
        };

        const [forced] = screener.discoverAndRank([
            candidate("DOGE", { returns: { m5: 0, m15: 0, h1: 0, h4: 0 }, spreadBps: 25 })
        ], [], config, DEFAULT_AGENT_CONFIG);

        expect(forced.discoveryReasons).toContain("FORCE_INCLUDED");
        expect(forced.execution.tradeable).toBe(false);
        expect(forced.execution.blockReasons).toContain("SPREAD_GATE");
    });
});

function candidate(symbol: string, overrides: {
    returns: { m5: number; m15: number; h1: number; h4: number };
    spreadBps?: number;
    depthUsd?: number;
    volRatio?: number;
    retSigma?: number;
}): EnrichedMarketData {
    const depthUsd = overrides.depthUsd ?? 100_000;
    return {
        symbol,
        price: 1,
        volume24h: 10_000_000,
        funding: 0,
        openInterest: 1_000_000,
        recentQuoteVolume: 100_000,
        metrics: {
            returns: { m1: 0, ...overrides.returns },
            realized_vol: { m1: 0.001, m5: 0.002, m15: 0.002, h1: 0.001, h4: 0.001 },
            volume_zscores: { v1m_vs_1h: 0, v5m_vs_1h: 0, v15m_vs_1h: 0 },
            vol_zscores: {
                vol_5m_vs_1h: overrides.volRatio ?? 1,
                ret_5m_vs_1h: overrides.retSigma ?? 1
            },
            rsi: { m1: 50, m5: 50, m15: 50 },
            bbands: {
                m1: { upper: 0, middle: 0, lower: 0, width: 0 },
                m5: { upper: 0, middle: 0, lower: 0, width: 0 }
            },
            atr: { m5: 0, h1: 0 },
            atr_pct: { m5: 0.01, h1: 0.02 },
            macd: {
                m5: { macd: 0, signal: 0, histogram: 0 },
                h1: { macd: 0, signal: 0, histogram: 0 }
            },
            high_low: { is_new_high_1h: false, is_new_low_1h: false },
            regime_tags: []
        },
        bookMetrics: {
            best_bid: 0.999,
            best_ask: 1.001,
            mid: 1,
            spread_bps: overrides.spreadBps ?? 2,
            depth_usd: { bid_1pct: depthUsd, ask_1pct: depthUsd },
            imbalance: 0,
            book_pressure: 0.3,
            cost_bps: 0,
            depth_bands_usd: { bid: {}, ask: {} }
        },
        sentiment: { score: 0, mentions_vs_baseline: 0, disagreement: 0, change_2h: 0 },
        isTestnet: true
    };
}
