import { MarketEntry } from "@/types/snapshot";
import { ScreenedSymbol } from "./ScreenerService";

export class MarketSnapshotAssembler {
    public buildFromScreenedSymbols(
        screenedSymbols: ScreenedSymbol[],
        assetIndexMap: Map<string, number>
    ): { markets: Record<string, MarketEntry>; duplicateMarkets: string[] } {
        const markets: Record<string, MarketEntry> = {};
        const duplicateMarkets: string[] = [];

        for (const symbolData of screenedSymbols) {
            const { symbol, price, metrics, bookMetrics, funding, openInterest, sentiment } = symbolData;
            const marketKey = `${symbol}-PERP`;

            if (markets[marketKey]) {
                duplicateMarkets.push(marketKey);
                continue;
            }

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
                    current_8h: funding,
                    delta_5m: symbolData.fundingDelta5m
                },
                open_interest: {
                    current: openInterest,
                    delta_5m: symbolData.openInterestDelta5m
                },
                sentiment: {
                    score: sentiment.score,
                    mentionsVsBaseline: sentiment.mentions_vs_baseline,
                    disagreement: sentiment.disagreement,
                    change2h: sentiment.change_2h
                },
                regime_tags: metrics.regime_tags,
                high_low: metrics.high_low,
                bbands: metrics.bbands,
                assetIndex: assetIndexMap.get(symbol)
            };
        }

        return { markets, duplicateMarkets };
    }
}
