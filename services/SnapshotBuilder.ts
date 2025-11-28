import { getClearinghouseState, getMetaAndAssetCtxs, getOHLCV } from "@/lib/hyperliquid";
import { SentimentService, SentimentSnapshot } from "./SentimentService";
import { MarketAnalysisService } from "./MarketAnalysisService";
import { ScreenerService } from "./ScreenerService";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";

// Types matching the prompt's JSON structure
export type StateSnapshot = {
    timestamp: number;
    account: {
        equity_usd: number;
        daily_realized_pnl: number;
        max_daily_loss: number;
        current_positions: Position[];
        derived_portfolio: {
            total_exposure_fraction: number;
            remaining_capacity: number;
            position_slots_used: number;
            slots_remaining: number;
        };
    };
    markets: Record<string, any>; // Enriched with derived fields
    constraints: {
        max_position_pct_equity_per_symbol: number;
        max_total_exposure_pct_equity: number;
        min_trade_notional_usd: number;
        kill_switch: boolean;
        no_flip_same_tick: boolean;
    };
    allowed_actions: string[];
    meta: {
        note: string;
        fallback_markets?: string[];
        missing_markets?: string[];
        duplicate_markets?: string[];
    };
    global_regime: {
        current: "RISK_ON" | "RISK_OFF" | "CHOP";
        score: number; // -1 (risk-off) to 1 (risk-on)
        reason: string;
    };
};

type Position = {
    symbol: string;
    side: "long" | "short";
    size_usd: number;
    size_coin: number;
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
        config: AgentConfig = DEFAULT_AGENT_CONFIG,
        screenerConfig: ScreenerConfig = DEFAULT_SCREENER_CONFIG
    ): Promise<StateSnapshot> {
        const timestamp = Math.floor(Date.now() / 1000);
        const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);
        const assetCtxMap = new Map<string, any>();
        const assetIndexMap = new Map<string, number>();
        if (metaAndCtxs) {
            metaAndCtxs.universe.forEach((asset: any, idx: number) => {
                assetCtxMap.set(asset.name, metaAndCtxs.assetCtxs[idx]);
                assetIndexMap.set(asset.name, idx);
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

                const equity = parseFloat(marginSummary.accountValue);
                accountData.equity_usd = isNaN(equity) ? 0 : equity;
                // Note: daily_realized_pnl is not directly in clearinghouseState, needs tracking. 
                // For now, we'll default to 0 or try to estimate if possible.

                accountData.current_positions = positions
                    .filter((p: any) => parseFloat(p.position.szi) !== 0)
                    .map((p: any) => {
                        const size = parseFloat(p.position.szi) || 0;
                        const entryPrice = parseFloat(p.position.entryPx) || 0;
                        const side = size > 0 ? "long" : "short";
                        const unrealizedPnl = parseFloat(p.position.unrealizedPnl) || 0;
                        const leverage = parseFloat(p.position.leverage.value) || 0;
                        const symbol = p.position.coin || "UNKNOWN";
                        const sizeUsd = Math.abs(size) * entryPrice;

                        heldSymbols.push(symbol);

                        return {
                            symbol: `${symbol}-PERP`, // Ensure consistency with market keys
                            side,
                            size_usd: sizeUsd,
                            size_coin: Math.abs(size),
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

        // 1b. Calculate Portfolio Derived Metrics
        const maxTotalExposure = config.risk.max_total_exposure_fraction;
        const maxSlots = config.risk.max_positions;
        const totalExposure = accountData.current_positions.reduce((sum: number, p: any) => sum + p.fraction_of_equity, 0);

        accountData.derived_portfolio = {
            total_exposure_fraction: parseFloat(totalExposure.toFixed(4)),
            remaining_capacity: parseFloat((maxTotalExposure - totalExposure).toFixed(4)),
            position_slots_used: accountData.current_positions.length,
            slots_remaining: Math.max(0, maxSlots - accountData.current_positions.length)
        };

        // 2. Fetch Screened Market Data
        console.log("📊 Fetching Screened Market Data...");

        // ScreenerService now uses cached MarketStateSnapshot internally for fast on-demand screening
        const screenedSymbols = await this.screenerService.getScreenedSymbols(isTestnet, heldSymbols, config, screenerConfig);
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
                symbol: marketKey,
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
                    mentionsVsBaseline: sentiment.mentions_vs_baseline,
                    disagreement: sentiment.disagreement,
                    change2h: sentiment.change_2h
                },
                regime_tags: metrics.regime_tags,
                high_low: metrics.high_low,
                bbands: metrics.bbands,
                assetIndex: assetIndexMap.get(symbol) // Add assetIndex
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
                    symbol: marketKey,
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
                        ask_liquidity_usd: 0
                    },
                    returns: { m5: 0, m15: 0, h1: 0 },
                    vol_zscores: { vol_5m_vs_1h: 0, ret_5m_vs_1h: 0 },
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

        console.log(`📊 Total markets included in snapshot: ${Object.keys(markets).length}`);

        // 4. Determine Global Regime
        // We need BTC and ETH metrics. If they are in 'markets', use them. If not, we might need to fetch them.
        // For simplicity, we'll infer from the screened markets (breadth) and specifically look for BTC/ETH if present.

        let upCount = 0;
        let downCount = 0;
        let volSum = 0;
        const marketKeys = Object.keys(markets);

        for (const key of marketKeys) {
            const m = markets[key];
            if (m.returns.m15 > 0.002) upCount++; // > 0.2% up
            if (m.returns.m15 < -0.002) downCount++; // > 0.2% down
            volSum += m.vol_zscores.vol_5m_vs_1h;
        }

        const breadth = marketKeys.length > 0 ? (upCount - downCount) / marketKeys.length : 0;
        const avgVolZ = marketKeys.length > 0 ? volSum / marketKeys.length : 0;

        let regime: "RISK_ON" | "RISK_OFF" | "CHOP" = "CHOP";
        let regimeReason = "Mixed signals or low volatility";

        if (avgVolZ > 1.0) {
            if (breadth > 0.3) {
                regime = "RISK_ON";
                regimeReason = "High volatility + Positive breadth";
            } else if (breadth < -0.3) {
                regime = "RISK_OFF";
                regimeReason = "High volatility + Negative breadth";
            }
        } else {
            // Low vol
            if (Math.abs(breadth) > 0.6) {
                // Strong trend but low vol? Rare, but possible slow grind.
                regime = breadth > 0 ? "RISK_ON" : "RISK_OFF";
                regimeReason = "Low volatility but strong directional breadth";
            }
        }

        // 5. Inject Derived Fields into Markets (Post-Regime Calculation)
        // We need the regime to determine cost thresholds
        const costBpsMax = config.gates.cost_bps_max_by_regime[regime];
        const networkProfile = isTestnet ? config.network_profiles.testnet : config.network_profiles.mainnet;
        const feesBps = networkProfile.fees_bps;
        const slippageModel = networkProfile.slippage_model;

        for (const key of Object.keys(markets)) {
            const m = markets[key];

            // --- 1. Costs ---
            const slippageEst = Math.max(slippageModel.min_bps, m.spread_bps * slippageModel.spread_mult);
            const costBps = m.spread_bps + feesBps + slippageEst;

            // Check for override
            const symbolBase = key.replace("-PERP", "");
            const overrideMax = config.gates.per_symbol_cost_override?.[symbolBase];
            const effectiveCostMax = overrideMax !== undefined ? overrideMax : costBpsMax;

            const costOk = costBps <= effectiveCostMax;

            // --- 2. Expected Edge ---
            // Option A: Vol-scaled move (ATR based)
            // ATR is in price units. Convert to bps: (ATR / Price) * 10000
            let expectedMoveBps = 0;
            // Note: We removed raw metrics.atr from the market object, so we can't use it here unless we kept it temporarily.
            // But we kept 'returns' and 'vol_zscores'.
            // Fallback to returns-based expected move.
            expectedMoveBps = 10000 * Math.max(Math.abs(m.returns.m15), Math.abs(m.returns.h1));

            const edgeBps = expectedMoveBps - costBps;
            const edgeMult = config.gates.edge_to_cost_mult_by_regime[regime];
            const edgeOk = edgeBps >= (edgeMult * costBps) && edgeBps > 10;

            // --- 3. Triggers & Normalization ---
            const dirM15 = Math.sign(m.returns.m15);
            const dirH1 = Math.sign(m.returns.h1);

            // Relaxed Trend Alignment for Testnet
            const strictTrend = (dirM15 === dirH1) && (dirM15 !== 0);
            const trendAligned = strictTrend || (isTestnet && dirM15 !== 0);

            const retSigma = m.vol_zscores.ret_5m_vs_1h; // Alias
            const volRatio = m.vol_zscores.vol_5m_vs_1h; // Alias

            const bp = m.orderbook.book_pressure;

            // Momentum
            const momOkLong = trendAligned && (dirH1 === 1 || (isTestnet && dirM15 === 1)) && bp >= config.triggers.momentum.book_pressure_min && volRatio >= config.triggers.momentum.vol_ratio_min;
            const momOkShort = trendAligned && (dirH1 === -1 || (isTestnet && dirM15 === -1)) && bp <= -config.triggers.momentum.book_pressure_min && volRatio >= config.triggers.momentum.vol_ratio_min;

            // Mean Reversion (Fixed: Removed contradictory returns check)
            const mrOkLong = retSigma <= -config.triggers.mean_reversion.ret_sigma_threshold && bp >= config.triggers.mean_reversion.book_pressure_min;
            const mrOkShort = retSigma >= config.triggers.mean_reversion.ret_sigma_threshold && bp <= -config.triggers.mean_reversion.book_pressure_min;

            // Breakout (Simplified)
            // We don't have range data easily, so using vol compression proxy if available or skipping
            // For now, using vol spike as primary breakout signal
            const volSpike = volRatio >= config.triggers.breakout.vol_ratio_min;
            const breakoutOk = volSpike && Math.abs(bp) >= config.triggers.breakout.book_pressure_min;

            // --- 4. Liquidity ---
            const minDepth = Math.min(m.orderbook.bid_liquidity_usd, m.orderbook.ask_liquidity_usd);
            const depthOk = minDepth >= config.gates.depth_usd_min;
            const tradeable = depthOk && costOk;

            // Inject
            m.derived = {
                costs: {
                    fees_bps: feesBps,
                    slippage_bps_est: parseFloat(slippageEst.toFixed(1)),
                    cost_bps: parseFloat(costBps.toFixed(1)),
                    cost_ok: costOk
                },
                edge: {
                    expected_move_bps: parseFloat(expectedMoveBps.toFixed(1)),
                    edge_bps: parseFloat(edgeBps.toFixed(1)),
                    edge_ok: edgeOk
                },
                technicals: {
                    high_low: m.high_low || { is_new_high_1h: false, is_new_low_1h: false },
                    bb_width_m5: m.bbands?.m5?.width || 0
                },
                triggers: {
                    direction_m15: dirM15,
                    direction_h1: dirH1,
                    trend_aligned: trendAligned,
                    momentum_ok_long: momOkLong,
                    momentum_ok_short: momOkShort,
                    mr_ok_long: mrOkLong,
                    mr_ok_short: mrOkShort,
                    breakout_ok: breakoutOk
                },
                liquidity: {
                    min_depth_usd: minDepth,
                    depth_ok: depthOk,
                    tradeable: tradeable
                },
                normalized: {
                    ret_sigma_5m_vs_1h: retSigma,
                    vol_ratio_5m_vs_1h: volRatio
                }
            };
        }

        return {
            timestamp,
            account: accountData,
            markets,
            constraints: {
                max_position_pct_equity_per_symbol: config.risk.max_position_fraction_per_symbol,
                max_total_exposure_pct_equity: config.risk.max_total_exposure_fraction,
                min_trade_notional_usd: config.risk.min_trade_notional_usd,
                kill_switch: false,
                no_flip_same_tick: config.risk.no_flip_same_tick
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
            },
            global_regime: {
                current: regime,
                score: breadth,
                reason: regimeReason
            }
        };
    }
}
