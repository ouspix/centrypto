import { getClearinghouseState, getMetaAndAssetCtxs, getOHLCV } from "@/lib/hyperliquid";
import { SentimentService, SentimentSnapshot } from "./SentimentService";
import { MarketAnalysisService } from "./MarketAnalysisService";
import { ScreenerService } from "./ScreenerService";

// Types matching the prompt's JSON structure
export type StateSnapshot = {
    timestamp: number;
    account: {
        equity_usd: number;
        daily_realized_pnl: number;
        max_daily_loss: number;
        current_positions: Position[];
    };
    markets: Record<string, any>; // Relaxed type for flexibility with trimmed data
    constraints: {
        max_position_pct_equity_per_symbol: number;
        max_total_exposure_pct_equity: number;
        min_trade_notional_usd: number;
        kill_switch: boolean;
    };
    allowed_actions: string[];
    meta: {
        note: string;
        fallback_markets?: string[];
        missing_markets?: string[];
        duplicate_markets?: string[];
    };
};

type Position = {
    symbol: string;
    side: "long" | "short";
    size_usd: number;
    fraction_of_equity: number;
    entry_price: number;
    unrealized_pnl: number;
    leverage: number;
};

export class SnapshotBuilder {
    private sentimentService: SentimentService;
    private marketAnalysisService: MarketAnalysisService;
    private screenerService: ScreenerService;

    constructor() {
        this.sentimentService = new SentimentService();
        this.marketAnalysisService = new MarketAnalysisService();
        this.screenerService = new ScreenerService();
    }

    public async buildSnapshot(
        userAddress: string | null,
        isTestnet: boolean,
        screeningConfig?: any
    ): Promise<StateSnapshot> {
        const timestamp = Math.floor(Date.now() / 1000);
        const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);
        const assetCtxMap = new Map<string, any>();
        if (metaAndCtxs) {
            metaAndCtxs.universe.forEach((asset: any, idx: number) => {
                assetCtxMap.set(asset.name, metaAndCtxs.assetCtxs[idx]);
            });
        }

        // 1. Fetch Account Data
        let accountData: any = {
            equity_usd: 10000.0, // Default/Mock
            daily_realized_pnl: 0.0,
            max_daily_loss: 500.0,
            current_positions: []
        };

        const heldSymbols: string[] = [];

        if (userAddress) {
            console.log(`🔍 Fetching clearinghouse state for ${userAddress}...`);
            const clearinghouseState = await getClearinghouseState(userAddress, isTestnet);
            if (clearinghouseState) {
                const marginSummary = clearinghouseState.marginSummary;
                const positions = clearinghouseState.assetPositions;

                accountData.equity_usd = parseFloat(marginSummary.accountValue);
                // Note: daily_realized_pnl is not directly in clearinghouseState, needs tracking. 
                // For now, we'll default to 0 or try to estimate if possible.

                accountData.current_positions = positions
                    .filter((p: any) => parseFloat(p.position.szi) !== 0)
                    .map((p: any) => {
                        const size = parseFloat(p.position.szi);
                        const entryPrice = parseFloat(p.position.entryPx);
                        const side = size > 0 ? "long" : "short";
                        const unrealizedPnl = parseFloat(p.position.unrealizedPnl);
                        const leverage = parseFloat(p.position.leverage.value);
                        const symbol = p.position.coin || "UNKNOWN";
                        const sizeUsd = Math.abs(size) * entryPrice;

                        heldSymbols.push(symbol);

                        return {
                            symbol: `${symbol}-PERP`, // Ensure consistency with market keys
                            side,
                            size_usd: sizeUsd,
                            fraction_of_equity: accountData.equity_usd > 0 ? sizeUsd / accountData.equity_usd : 0,
                            entry_price: entryPrice,
                            unrealized_pnl: unrealizedPnl,
                            leverage: leverage
                        };
                    });
                console.log(`✅ Found ${accountData.current_positions.length} open positions:`, accountData.current_positions.map((p: any) => p.symbol).join(", "));
            } else {
                console.warn("⚠️ Failed to fetch clearinghouse state or it was null.");
            }
        } else {
            console.log("ℹ️ No user address provided, skipping account data fetch.");
        }

        // 2. Fetch Screened Market Data
        console.log("📊 Fetching Screened Market Data...");

        // ScreenerService now uses cached MarketStateSnapshot internally for fast on-demand screening
        const screenedSymbols = await this.screenerService.getScreenedSymbols(isTestnet, heldSymbols, screeningConfig);
        console.log(`✅ Loaded ${screenedSymbols.length} symbols from screener.`);
        const markets: Record<string, any> = {};
        const fallbackMarkets: string[] = [];
        const missingMarkets: string[] = [];
        const duplicateMarkets: string[] = [];

        for (const symbolData of screenedSymbols) {
            const { symbol, price, metrics, bookMetrics, funding, openInterest, sentiment } = symbolData;
            const marketKey = `${symbol}-PERP`;

            // Deduplicate in case screener returns duplicates; keep first occurrence
            if (markets[marketKey]) {
                duplicateMarkets.push(marketKey);
                continue;
            }

            // Calculate Book Pressure
            const bid = bookMetrics.depth_usd.bid_1pct || 0;
            const ask = bookMetrics.depth_usd.ask_1pct || 0;
            const denom = bid + ask;
            let bookPressure = 0;
            if (denom > 0) {
                const raw = bid / denom; // 0..1
                bookPressure = 2 * raw - 1; // -1..1
            }

            markets[marketKey] = {
                price,
                spread_bps: bookMetrics.spread_bps,
                orderbook: {
                    book_pressure: parseFloat(bookPressure.toFixed(2)),
                    bid_liquidity_usd: bid,
                    ask_liquidity_usd: ask
                },
                returns: {
                    m5: metrics.returns.m5,
                    m15: metrics.returns.m15,
                    h1: metrics.returns.h1
                },
                vol_zscores: metrics.vol_zscores,
                funding: {
                    current_8h: funding
                },
                open_interest: {
                    current: openInterest
                },
                sentiment: {
                    score: sentiment.score,
                    tags: sentiment.tags,
                    source_mix: sentiment.source_mix
                },
                regime_tags: metrics.regime_tags
            };
        }

        // 3. Ensure every held position has market data; fetch on-demand fallback if missing
        for (const position of accountData.current_positions) {
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
                    price,
                    spread_bps: bookMetrics.spread_bps,
                    orderbook: {
                        book_pressure: parseFloat(bookPressure.toFixed(2)),
                        bid_liquidity_usd: bid,
                        ask_liquidity_usd: ask
                    },
                    returns: {
                        m5: metrics.returns.m5,
                        m15: metrics.returns.m15,
                        h1: metrics.returns.h1
                    },
                    vol_zscores: metrics.vol_zscores,
                    funding: {
                        current_8h: funding
                    },
                    open_interest: {
                        current: openInterest
                    },
                    sentiment: {
                        score: sentiment.score,
                        tags: sentiment.tags,
                        source_mix: sentiment.source_mix
                    },
                    regime_tags: metrics.regime_tags,
                    data_source: "fallback_on_demand"
                };

                fallbackMarkets.push(marketKey);
            } catch (err) {
                console.warn(`⚠️ Failed to fetch fallback market data for ${marketKey}. Marking as missing.`, err);
                markets[marketKey] = {
                    price,
                    spread_bps: 0,
                    orderbook: {
                        book_pressure: 0,
                        bid_liquidity_usd: 0,
                        ask_liquidity_usd: 0
                    },
                    returns: { m5: 0, m15: 0, h1: 0 },
                    vol_zscores: { vol_5m_vs_1h: 0, ret_5m_vs_1h: 0 },
                    funding: { current_8h: funding },
                    open_interest: { current: openInterest },
                    sentiment: { score: 0, tags: [], source_mix: {} },
                    regime_tags: [],
                    data_unavailable: true,
                    data_source: "missing"
                };
                missingMarkets.push(marketKey);
            }
        }

        console.log(`📊 Total markets included in snapshot: ${Object.keys(markets).length}`);

        return {
            timestamp,
            account: accountData,
            markets,
            constraints: {
                max_position_pct_equity_per_symbol: 0.2,
                max_total_exposure_pct_equity: 1.0,
                min_trade_notional_usd: 10.0,
                kill_switch: false
            },
            allowed_actions: [
                "OPEN_POSITION",
                "INCREASE_POSITION",
                "REDUCE_POSITION",
                "CLOSE_POSITION",
                "HOLD_POSITION"
            ],
            meta: {
                note: "Generated by SnapshotBuilder with Screener",
                fallback_markets: fallbackMarkets,
                missing_markets: missingMarkets,
                duplicate_markets: duplicateMarkets
            }
        };
    }
}
