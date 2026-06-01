import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { SCREENER_PRESETS } from "@/lib/screener-config";
import { computeExecutionCostBps } from "@/lib/trading/execution-cost";
import { MarketDerivedMetricsService } from "@/services/MarketDerivedMetricsService";
import { EnrichedMarketData, ScreenerService } from "@/services/ScreenerService";
import { MarketEntry } from "@/types/snapshot";

describe("execution cost", () => {
    it("computes fees plus spread plus modeled slippage", () => {
        const cost = computeExecutionCostBps({
            spreadBps: 10,
            feesBps: 3.5,
            slippageModel: { min_bps: 1, spread_mult: 0.5 }
        });

        expect(cost).toEqual({
            feesBps: 3.5,
            slippageBps: 5,
            totalCostBps: 18.5
        });
    });

    it("uses the same cost formula in screener diagnostics and derived metrics", () => {
        const config = DEFAULT_AGENT_CONFIG;
        const screener = new ScreenerService(true, { disableLive: true });
        const candidate = enrichedCandidate({
            symbol: "FARTCOIN",
            spreadBps: 10,
            depthUsd: 100_000,
            returns: { m5: 0.01, m15: 0.03, h1: 0.04, h4: 0.05 }
        });

        const [screened] = screener.discoverAndRank(
            [candidate],
            [],
            {
                ...SCREENER_PRESETS["Discovery Balanced"],
                topN: 1,
                minRecentVolume: 0,
                minVolume24h: 0,
                minRealizedVol: 0
            },
            config
        );

        const markets: Record<string, MarketEntry> = {
            "FARTCOIN-PERP": marketEntry({
                symbol: "FARTCOIN-PERP",
                spreadBps: 10,
                depthUsd: 100_000,
                returns: { m5: 0.01, m15: 0.03, h1: 0.04, h4: 0.05 }
            })
        };
        new MarketDerivedMetricsService().applyDerivedMetrics(markets, config, "RISK_ON", true);

        expect(screened.execution.costBps).toBe(markets["FARTCOIN-PERP"].derived?.costs.cost_bps);
        expect(screened.execution.costBps).toBe(18.5);
    });
});

function enrichedCandidate(input: {
    symbol: string;
    spreadBps: number;
    depthUsd: number;
    returns: { m5: number; m15: number; h1: number; h4: number };
}): EnrichedMarketData {
    return {
        symbol: input.symbol,
        price: 1,
        volume24h: 10_000_000,
        funding: 0,
        openInterest: 1_000_000,
        recentQuoteVolume: 100_000,
        metrics: {
            returns: { m1: 0, ...input.returns },
            realized_vol: { m1: 0.001, m5: 0.002, m15: 0.002, h1: 0.001, h4: 0.001 },
            volume_zscores: { v1m_vs_1h: 0, v5m_vs_1h: 0, v15m_vs_1h: 0 },
            vol_zscores: { vol_5m_vs_1h: 2, ret_5m_vs_1h: 2 },
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
            spread_bps: input.spreadBps,
            depth_usd: { bid_1pct: input.depthUsd, ask_1pct: input.depthUsd },
            imbalance: 0,
            book_pressure: 0.3,
            cost_bps: 0,
            depth_bands_usd: { bid: {}, ask: {} }
        },
        sentiment: { score: 0, mentions_vs_baseline: 0, disagreement: 0, change_2h: 0 },
        isTestnet: true
    };
}

function marketEntry(input: {
    symbol: string;
    spreadBps: number;
    depthUsd: number;
    returns: { m5: number; m15: number; h1: number; h4: number };
}): MarketEntry {
    return {
        symbol: input.symbol,
        price: 1,
        spread_bps: input.spreadBps,
        orderbook: {
            book_pressure: 0.3,
            bid_liquidity_usd: input.depthUsd,
            ask_liquidity_usd: input.depthUsd
        },
        returns: input.returns,
        vol_zscores: { vol_5m_vs_1h: 2, ret_5m_vs_1h: 2 },
        realized_vol: { m1: 0.001, m5: 0.002, m15: 0.002, h1: 0.001, h4: 0.001 },
        atr_pct: { m5: 0.01, h1: 0.02 },
        funding: { current_8h: 0 },
        open_interest: { current: 1_000_000 },
        sentiment: { score: 0, mentionsVsBaseline: 0, disagreement: 0, change2h: 0 }
    };
}
