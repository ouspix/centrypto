import { getClearinghouseState, getMetaAndAssetCtxs, getOHLCV } from "@/lib/hyperliquid";
import { SentimentService, SentimentSnapshot } from "./SentimentService";
import { MarketAnalysisService } from "./MarketAnalysisService";

// Types matching the prompt's JSON structure
export type StateSnapshot = {
    timestamp: number;
    account: {
        equity_usd: number;
        daily_realized_pnl: number;
        max_daily_loss: number;
        open_positions: Position[];
    };
    markets: Record<string, MarketData>;
    constraints: {
        max_leverage: number;
        max_position_pct_equity_per_symbol: number;
        max_total_exposure_pct_equity: number;
        min_trade_notional_usd: number;
        kill_switch: boolean;
    };
    allowed_actions: string[];
    meta: {
        note: string;
    };
};

type Position = {
    symbol: string;
    side: "long" | "short";
    size_usd: number;
    entry_price: number;
    unrealized_pnl: number;
    leverage: number;
};

type MarketData = {
    price: number;
    spread_bps: number;
    depth_usd: {
        bid_1pct: number;
        ask_1pct: number;
    };
    imbalance: number; // Added imbalance
    returns: {
        m1: number;
        m5: number;
        m15: number;
        h1: number;
        h4: number;
    };
    realized_vol: {
        m1: number;
        m5: number;
        m15: number;
        h1: number;
        h4: number;
    };
    vol_zscores: {
        vol_5m_vs_1h: number;
        ret_5m_vs_1h: number;
    };
    funding: {
        current_8h: number;
        prev_8h: number;
    };
    open_interest: {
        current: number;
        change_1h: number;
        change_24h: number;
    };
    sentiment: SentimentSnapshot;
    regime_tags: string[];
};

export class SnapshotBuilder {
    private sentimentService: SentimentService;
    private marketAnalysisService: MarketAnalysisService;

    constructor() {
        this.sentimentService = new SentimentService();
        this.marketAnalysisService = new MarketAnalysisService();
    }

    public async buildSnapshot(userAddress: string | null, isTestnet: boolean): Promise<StateSnapshot> {
        const timestamp = Math.floor(Date.now() / 1000);

        // 1. Fetch Account Data
        let accountData = {
            equity_usd: 10000.0, // Default/Mock
            daily_realized_pnl: 0.0,
            max_daily_loss: 500.0,
            open_positions: [] as Position[]
        };

        if (userAddress) {
            const clearinghouseState = await getClearinghouseState(userAddress, isTestnet);
            if (clearinghouseState) {
                const marginSummary = clearinghouseState.marginSummary;
                const positions = clearinghouseState.assetPositions;

                accountData.equity_usd = parseFloat(marginSummary.accountValue);
                // Note: daily_realized_pnl is not directly in clearinghouseState, needs tracking. 
                // For now, we'll default to 0 or try to estimate if possible, but usually requires dedicated tracking.

                accountData.open_positions = positions
                    .filter((p: any) => parseFloat(p.position.szi) !== 0)
                    .map((p: any) => {
                        const size = parseFloat(p.position.szi);
                        const entryPrice = parseFloat(p.position.entryPx);
                        const side = size > 0 ? "long" : "short";
                        const unrealizedPnl = parseFloat(p.position.unrealizedPnl);
                        const leverage = parseFloat(p.position.leverage.value);

                        return {
                            symbol: p.position.coin || "UNKNOWN",
                            side,
                            size_usd: Math.abs(size) * entryPrice,
                            entry_price: entryPrice,
                            unrealized_pnl: unrealizedPnl,
                            leverage: leverage // Placeholder, refine later
                        };
                    });
            }
        }

        // 2. Fetch Market Data (Meta & Asset Contexts)
        console.log("📊 Fetching market data from Hyperliquid...");
        const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);
        const markets: Record<string, MarketData> = {};

        if (metaAndCtxs) {
            const { universe, assetCtxs } = metaAndCtxs;
            console.log(`✅ Fetched ${universe.length} assets from Hyperliquid`);

            // Process top assets (e.g., BTC, ETH, SOL)
            // We need to map asset index to symbol from 'universe'

            for (let i = 0; i < universe.length; i++) {
                const assetMeta = universe[i];
                const ctx = assetCtxs[i];
                const symbol = assetMeta.name; // e.g., "BTC"

                // Filter for major coins to save time/tokens
                if (!["BTC", "ETH", "SOL", "ARB"].includes(symbol)) continue;

                console.log(`📈 Processing ${symbol}...`);

                const price = parseFloat(ctx.markPx);
                const funding = parseFloat(ctx.funding);
                const openInterest = parseFloat(ctx.openInterest);

                // Fetch Market Analysis (Returns & Volatility & Z-Scores)
                const metrics = await this.marketAnalysisService.getMetricsForSymbol(symbol, isTestnet);

                // Fetch Order Book Metrics (Spread, Depth)
                const bookMetrics = await this.marketAnalysisService.getOrderBookMetrics(symbol, isTestnet);

                // Fetch Sentiment
                const sentiment = await this.sentimentService.getSentimentForCoin(symbol);

                markets[`${symbol}-PERP`] = {
                    price,
                    spread_bps: bookMetrics.spread_bps,
                    depth_usd: bookMetrics.depth_usd,
                    imbalance: bookMetrics.imbalance,
                    returns: metrics.returns,
                    realized_vol: metrics.realized_vol,
                    vol_zscores: metrics.vol_zscores,
                    funding: {
                        current_8h: funding,
                        prev_8h: funding // Mock
                    },
                    open_interest: {
                        current: openInterest * price, // Convert to USD
                        change_1h: 0,
                        change_24h: 0
                    },
                    sentiment,
                    regime_tags: metrics.regime_tags
                };

                console.log(`✅ Added ${symbol}-PERP to markets (price: $${price})`);

            }

            console.log(`📊 Total markets added: ${Object.keys(markets).length}`);
        } else {
            console.error("❌ Failed to fetch market data from Hyperliquid");
        }

        return {
            timestamp,
            account: accountData,
            markets,
            constraints: {
                max_leverage: 5.0,
                max_position_pct_equity_per_symbol: 0.25,
                max_total_exposure_pct_equity: 0.7,
                min_trade_notional_usd: 10.0,
                kill_switch: false
            },
            allowed_actions: [
                "OPEN_POSITION",
                "CLOSE_POSITION",
                "REDUCE_POSITION",
                "ADJUST_STOPS",
                "DO_NOTHING"
            ],
            meta: {
                note: "Generated by SnapshotBuilder"
            }
        };
    }
}
