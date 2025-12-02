import { MarketAnalysisService, MarketMetrics, OrderBookMetrics } from "./MarketAnalysisService";
import { SentimentService } from "./SentimentService";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";
import { OrderBookManager } from "./OrderBookManager";
import { HyperliquidWS } from "@/lib/hyperliquid-ws";

export type EnrichedMarketData = {
    symbol: string;
    price: number;
    volume24h: number;
    funding: number;
    openInterest: number;
    openInterestDelta5m?: number;
    fundingDelta5m?: number;
    metrics: MarketMetrics;
    bookMetrics: OrderBookMetrics;
    sentiment: any;
    isTestnet: boolean;
};

export type ScreenedSymbol = EnrichedMarketData & {
    score: number;
    sentiment: any;
};

export class ScreenerService {
    private marketAnalysisService: MarketAnalysisService;
    private sentimentService: SentimentService;
    private orderBookManager: OrderBookManager;
    private ws: HyperliquidWS;

    constructor() {
        this.marketAnalysisService = new MarketAnalysisService();
        this.sentimentService = new SentimentService();

        // Initialize WS and OrderBookManager
        // We default to Mainnet for now. Ideally, we should support switching or multiple instances.
        this.ws = new HyperliquidWS(false); // Mainnet
        this.orderBookManager = new OrderBookManager(this.ws);
        this.ws.connect();
    }

    public async getScreenedSymbols(
        isTestnet: boolean,
        heldSymbols: string[] = [],
        config: AgentConfig = DEFAULT_AGENT_CONFIG,
        screenerConfig: ScreenerConfig = DEFAULT_SCREENER_CONFIG
    ): Promise<ScreenedSymbol[]> {
        const screenerCfg = screenerConfig;
        this.orderBookManager.setDepthBandsPct(screenerCfg.depthBandsPct);

        console.log(`🔍 Starting On-Demand Screening with topN=${screenerCfg.topN}`);
        const startTime = Date.now();

        // 1. Fetch Latest Ticks from DB (Candidate Source)
        const db = isTestnet ? marketDbTest : marketDbMain;

        // Get the latest tick for each symbol from the last 5 minutes
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const recentTicks = await db.marketTick.findMany({
            where: { ts: { gte: fiveMinutesAgo } },
            orderBy: { ts: 'desc' }
        });

        // Dedupe to get latest per symbol
        const latestTicksMap = new Map<string, typeof recentTicks[0]>();
        const earliestTicksMap = new Map<string, typeof recentTicks[0]>();
        for (const tick of recentTicks) {
            if (!latestTicksMap.has(tick.symbol)) {
                latestTicksMap.set(tick.symbol, tick);
            }
            earliestTicksMap.set(tick.symbol, tick);
        }
        const allTicks = Array.from(latestTicksMap.values());

        if (allTicks.length === 0) {
            console.warn("⚠️ No recent market ticks found in DB. Screening cannot proceed. Ensure collector is running.");
            return [];
        }

        // --- Layer 1: Universe Control (Hard Gate) ---
        const universeCandidates = this.filterByUniverse(allTicks, heldSymbols, screenerCfg);
        console.log(`Layer 1 (Universe): ${universeCandidates.length} passed minVolume24h (${screenerCfg.minVolume24h}).`);

        // --- Layer 2: Activity / "In-Play" (Hard Gate) ---
        // 2a. Calculate Recent Volume (Quote Volume in last X mins)
        const recentWindowStart = new Date(Date.now() - screenerCfg.recentVolumeMinutes * 60 * 1000);
        const recentVolumes = await db.marketCandle.groupBy({
            by: ['symbol'],
            where: {
                openTime: { gte: recentWindowStart }
            },
            _sum: {
                volume: true
            }
        });

        const recentVolumeMap = new Map<string, number>();
        for (const rv of recentVolumes) {
            recentVolumeMap.set(rv.symbol, rv._sum.volume || 0);
        }

        const activityCandidates: (EnrichedMarketData & { sentiment: any })[] = [];

        for (const tick of universeCandidates) {
            // Check Recent Volume first (cheap)
            const recentBaseVol = recentVolumeMap.get(tick.symbol) || 0;
            const recentQuoteVol = recentBaseVol * tick.markPrice;

            if (!heldSymbols.includes(tick.symbol) && recentQuoteVol < screenerCfg.minRecentVolume) {
                continue;
            }

            try {
                const baselineTick = earliestTicksMap.get(tick.symbol) || tick;
                const oiDelta5m = (tick.openInterest || 0) - (baselineTick.openInterest || 0);
                const fundingDelta5m = (tick.fundingRate || 0) - (baselineTick.fundingRate || 0);

                // Fetch Metrics & Sentiment
                const [metrics, sentiment] = await Promise.all([
                    this.marketAnalysisService.getMetricsForSymbol(tick.symbol, isTestnet, false),
                    this.sentimentService.getSentimentForCoin(tick.symbol)
                ]);

                const candidate = {
                    symbol: tick.symbol,
                    price: tick.markPrice,
                    volume24h: tick.volume24h || 0,
                    funding: tick.fundingRate || 0,
                    openInterest: tick.openInterest || 0,
                    openInterestDelta5m: oiDelta5m,
                    fundingDelta5m: fundingDelta5m,
                    metrics,
                    bookMetrics: { // Placeholder, filled in Layer 3
                        best_bid: 0,
                        best_ask: 0,
                        mid: 0,
                        spread_bps: 0,
                        depth_usd: { bid_1pct: 0, ask_1pct: 0 },
                        imbalance: 0,
                        book_pressure: 0,
                        cost_bps: 0,
                        depth_bands_usd: { bid: {}, ask: {} }
                    },
                    sentiment,
                    isTestnet
                };

                // Check Realized Volatility (Hard Gate)
                if (this.filterByActivity([candidate], heldSymbols, screenerCfg).length > 0) {
                    activityCandidates.push(candidate);
                }

            } catch (e) {
                console.error(`Failed to fetch metrics for ${tick.symbol}`, e);
            }
        }
        console.log(`Layer 2 (Activity): ${activityCandidates.length} passed recentVolume & realizedVol.`);

        // --- Layer 3: Liquidity / Execution (Hard Gate) ---
        const symbolsToTrack = activityCandidates.map(c => c.symbol);
        this.orderBookManager.updateSubscriptions(symbolsToTrack);

        // 2. Wait for data (warmup)
        await new Promise(resolve => setTimeout(resolve, 2000));

        const liquidityCandidates: EnrichedMarketData[] = [];

        for (const candidate of activityCandidates) {
            try {
                const bookMetrics = this.orderBookManager.getMetrics(candidate.symbol);
                const enriched = { ...candidate, bookMetrics };

                if (this.filterByLiquidity([enriched], heldSymbols, screenerCfg).length > 0) {
                    liquidityCandidates.push(enriched);
                } else if (heldSymbols.includes(candidate.symbol)) {
                    // Keep held symbols even if they fail liquidity (though filterByLiquidity should handle this if passed heldSymbols)
                    // My filterByLiquidity implementation below handles heldSymbols.
                    // But wait, if I pass [enriched] to filterByLiquidity, it returns [] if it fails.
                    // So I should just trust the filter.
                    // However, if fetching bookMetrics failed, we might want to keep it if held.
                    // The catch block handles failure.
                }
            } catch (e) {
                console.error(`Failed to get L2 metrics for ${candidate.symbol}`, e);
                if (heldSymbols.includes(candidate.symbol)) {
                    liquidityCandidates.push(candidate);
                }
            }
        }
        console.log(`Layer 3 (Liquidity): ${liquidityCandidates.length} passed spread & depth.`);

        // --- Layer 4: Quality Scoring (Ranking) ---
        const deduped = this.scoreAndRank(liquidityCandidates, heldSymbols, screenerCfg);

        console.log(`✅ Screening completed in ${Date.now() - startTime}ms. Returning ${deduped.length} unique symbols (topN=${screenerCfg.topN}).`);
        return deduped;
    }

    public filterByUniverse(candidates: any[], heldSymbols: string[], config: ScreenerConfig): any[] {
        return candidates.filter(d => {
            if (heldSymbols.includes(d.symbol)) return true;
            return (d.volume24h ?? 0) >= config.minVolume24h;
        });
    }

    public filterByActivity(candidates: (EnrichedMarketData & { sentiment: any })[], heldSymbols: string[], config: ScreenerConfig): (EnrichedMarketData & { sentiment: any })[] {
        return candidates.filter(c => {
            if (heldSymbols.includes(c.symbol)) return true;
            // Note: Recent Volume check is done before creating candidate in getScreenedSymbols for efficiency,
            // but strictly speaking should be here. We assume candidates passed to this might need checking if we were testing pure logic.
            // But here we only check realized vol as that's what's available in 'metrics'.
            const realizedVol = c.metrics.realized_vol.m5;
            return realizedVol >= config.minRealizedVol;
        });
    }

    public filterByLiquidity(candidates: EnrichedMarketData[], heldSymbols: string[], config: ScreenerConfig): EnrichedMarketData[] {
        return candidates.filter(c => {
            if (heldSymbols.includes(c.symbol)) return true;

            if (c.bookMetrics.spread_bps > config.maxSpreadBps) return false;

            const minSideDepth = Math.min(c.bookMetrics.depth_usd.bid_1pct, c.bookMetrics.depth_usd.ask_1pct);
            if (minSideDepth < config.minDepthUsd) return false;

            if (config.maxCostBps) {
                const estimatedCost = 3.5 + c.bookMetrics.spread_bps;
                if (estimatedCost > config.maxCostBps) return false;
            }

            return true;
        });
    }

    public scoreAndRank(candidates: EnrichedMarketData[], heldSymbols: string[], config: ScreenerConfig): ScreenedSymbol[] {
        const scored: ScreenedSymbol[] = [];
        const weights = config.quality_weights;

        for (const candidate of candidates) {
            const volScore = weights.vol_score * Math.abs(candidate.metrics.vol_zscores.vol_5m_vs_1h);
            const moveScore = weights.move_score * Math.abs(candidate.metrics.vol_zscores.ret_5m_vs_1h);

            const s5 = Math.sign(candidate.metrics.returns.m5);
            const s15 = Math.sign(candidate.metrics.returns.m15);
            const s60 = Math.sign(candidate.metrics.returns.h1);
            const trendAlign = (s5 === s15 && s15 === s60 && s5 !== 0) ? weights.trend_align : 0;

            const spreadPenalty = weights.spread_penalty * (candidate.bookMetrics.spread_bps / 5);

            const minDepth = Math.min(candidate.bookMetrics.depth_usd.bid_1pct, candidate.bookMetrics.depth_usd.ask_1pct);
            const illiquidityPenalty = weights.illiquidity_penalty * (config.minDepthUsd / (minDepth + 1));

            const totalScore = volScore + moveScore + trendAlign - spreadPenalty - illiquidityPenalty;

            scored.push({
                ...candidate,
                score: totalScore,
                sentiment: candidate.sentiment
            });
        }

        scored.sort((a, b) => b.score - a.score);

        const topCandidates = scored.slice(0, config.topN);
        const heldSet = new Set(heldSymbols);

        for (const c of scored) {
            if (heldSet.has(c.symbol) && !topCandidates.includes(c)) {
                topCandidates.push(c);
            }
        }

        const deduped: ScreenedSymbol[] = [];
        const seen = new Set<string>();
        for (const c of topCandidates) {
            if (seen.has(c.symbol)) continue;
            seen.add(c.symbol);
            deduped.push(c);
        }

        return deduped;
    }
}
