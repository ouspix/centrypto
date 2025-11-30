import { MarketAnalysisService } from "./MarketAnalysisService";
import { SentimentService } from "./SentimentService";
import { MarketEntry, Position } from "@/types/snapshot";

export class HeldPositionMarketResolver {
    private marketAnalysisService: MarketAnalysisService;
    private sentimentService: SentimentService;

    constructor(marketAnalysisService: MarketAnalysisService, sentimentService: SentimentService) {
        this.marketAnalysisService = marketAnalysisService;
        this.sentimentService = sentimentService;
    }

    public async backfillPositions(
        positions: Position[],
        markets: Record<string, MarketEntry>,
        assetCtxMap: Map<string, any>,
        assetIndexMap: Map<string, number>,
        isTestnet: boolean
    ): Promise<{ fallbackMarkets: string[]; missingMarkets: string[] }> {
        const fallbackMarkets: string[] = [];
        const missingMarkets: string[] = [];

        for (const position of positions) {
            const baseSymbol = position.symbol.replace(/-PERP$/, "");
            const marketKey = `${baseSymbol}-PERP`;

            if (markets[marketKey]) continue;

            const ctx = assetCtxMap.get(baseSymbol);
            const price = ctx ? parseFloat(ctx.markPx) : position.entry_price ?? 0;
            const funding = ctx ? parseFloat(ctx.funding) : 0;
            const openInterest = ctx ? parseFloat(ctx.openInterest) * price : 0;

            try {
                const [metrics, bookMetrics, sentiment] = await Promise.all([
                    this.marketAnalysisService.getMetricsForSymbol(baseSymbol, isTestnet),
                    this.marketAnalysisService.getOrderBookMetrics(baseSymbol, isTestnet),
                    this.sentimentService.getSentimentForCoin(baseSymbol)
                ]);

                const bid = bookMetrics.depth_usd.bid_1pct || 0;
                const ask = bookMetrics.depth_usd.ask_1pct || 0;
                const denom = bid + ask;
                const bookPressure = denom > 0 ? (2 * (bid / denom)) - 1 : 0;

                markets[marketKey] = {
                    symbol: marketKey,
                    price,
                    spread_bps: bookMetrics.spread_bps,
                    orderbook: {
                        book_pressure: parseFloat(bookPressure.toFixed(2)),
                        bid_liquidity_usd: bid,
                        ask_liquidity_usd: ask,
                        depth_bands_usd: bookMetrics.depth_bands_usd
                    },
                    returns: {
                        m5: metrics.returns.m5,
                        m15: metrics.returns.m15,
                        h1: metrics.returns.h1
                    },
                    realized_vol: metrics.realized_vol,
                    volume_zscores: metrics.volume_zscores,
                    atr_pct: metrics.atr_pct,
                    vol_zscores: metrics.vol_zscores,
                    funding: {
                        current_8h: funding
                    },
                    open_interest: {
                        current: openInterest
                    },
                    sentiment: {
                        score: sentiment.score,
                        mentionsVsBaseline: sentiment.mentions_vs_baseline,
                        disagreement: sentiment.disagreement,
                        change2h: sentiment.change_2h
                    },
                    regime_tags: metrics.regime_tags,
                    data_source: "fallback_on_demand",
                    assetIndex: assetIndexMap.get(baseSymbol)
                };

                fallbackMarkets.push(marketKey);
            } catch (err) {
                console.warn(`⚠️ Failed to fetch fallback market data for ${marketKey}. Marking as missing.`, err);
                markets[marketKey] = {
                    symbol: marketKey,
                    price,
                    spread_bps: 0,
                    orderbook: {
                        book_pressure: 0,
                        bid_liquidity_usd: 0,
                        ask_liquidity_usd: 0,
                        depth_bands_usd: { bid: {}, ask: {} }
                    },
                    returns: { m5: 0, m15: 0, h1: 0 },
                    vol_zscores: { vol_5m_vs_1h: 0, ret_5m_vs_1h: 0 },
                    realized_vol: { m1: 0, m5: 0, m15: 0, h1: 0, h4: 0 },
                    volume_zscores: { v1m_vs_1h: 0, v5m_vs_1h: 0, v15m_vs_1h: 0 },
                    atr_pct: { m5: 0, h1: 0 },
                    funding: { current_8h: funding },
                    open_interest: { current: openInterest },
                    sentiment: { score: 0, mentionsVsBaseline: 0, disagreement: 0, change2h: 0 },
                    regime_tags: [],
                    data_unavailable: true,
                    data_source: "missing"
                };
                missingMarkets.push(marketKey);
            }
        }

        return { fallbackMarkets, missingMarkets };
    }
}
