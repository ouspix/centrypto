import { MarketAnalysisService, MarketMetrics, OrderBookMetrics } from "./MarketAnalysisService";
import { SentimentService } from "./SentimentService";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";

export type EnrichedMarketData = {
    symbol: string;
    price: number;
    volume24h: number;
    funding: number;
    openInterest: number;
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

    constructor() {
        this.marketAnalysisService = new MarketAnalysisService();
        this.sentimentService = new SentimentService();
    }

    public async getScreenedSymbols(
        isTestnet: boolean,
        heldSymbols: string[] = [],
        config: AgentConfig = DEFAULT_AGENT_CONFIG,
        screenerConfig: ScreenerConfig = DEFAULT_SCREENER_CONFIG
    ): Promise<ScreenedSymbol[]> {
        const screenerCfg = screenerConfig;
        const gatesCfg = config.gates;

        console.log(`🔍 Starting On-Demand Screening with topN=${screenerCfg.topN}`);
        const startTime = Date.now();

        // 1. Fetch Latest Ticks from DB (Layer 1 Filter Candidate Source)
        const db = isTestnet ? marketDbTest : marketDbMain;

        // Get the latest tick for each symbol. 
        // Since we don't have a "latest" view, we query ticks from the last 5 minutes and dedupe.
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const recentTicks = await db.marketTick.findMany({
            where: { ts: { gte: fiveMinutesAgo } },
            orderBy: { ts: 'desc' }
        });

        // Dedupe to get latest per symbol
        const latestTicksMap = new Map<string, typeof recentTicks[0]>();
        for (const tick of recentTicks) {
            if (!latestTicksMap.has(tick.symbol)) {
                latestTicksMap.set(tick.symbol, tick);
            }
        }
        const allTicks = Array.from(latestTicksMap.values());

        if (allTicks.length === 0) {
            console.warn("⚠️ No recent market ticks found in DB. Screening cannot proceed. Ensure collector is running.");
            return [];
        }
        console.log(`Loaded ${allTicks.length} symbols from recent DB ticks.`);

        // 2. Apply Filters In-Memory

        // Layer 1: Volume
        const layer1 = allTicks.filter(d => (d.volume24h ?? 0) >= screenerCfg.minVolume24h);
        console.log(`Layer 1: ${layer1.length} passed volume filter (threshold: $${(screenerCfg.minVolume24h / 1_000_000).toFixed(1)}M).`);

        // Layer 2: Hard Filters (Spread, Depth)
        // Enrich Layer 1 Survivors (Fetch Metrics, Book, Sentiment)
        const enrichedLayer1: EnrichedMarketData[] = [];

        // Process in batches to avoid rate limits
        const batchSize = 10;
        for (let i = 0; i < layer1.length; i += batchSize) {
            const batch = layer1.slice(i, i + batchSize);
            await Promise.all(batch.map(async (tick) => {
                try {
                    const [metrics, bookMetrics, sentiment] = await Promise.all([
                        this.marketAnalysisService.getMetricsForSymbol(tick.symbol, isTestnet, true),
                        this.marketAnalysisService.getOrderBookMetrics(tick.symbol, isTestnet, true),
                        this.sentimentService.getSentimentForCoin(tick.symbol)
                    ]);

                    enrichedLayer1.push({
                        symbol: tick.symbol,
                        price: tick.markPrice,
                        volume24h: tick.volume24h || 0,
                        funding: tick.fundingRate || 0,
                        openInterest: tick.openInterest || 0,
                        metrics,
                        bookMetrics,
                        sentiment,
                        isTestnet
                    });
                } catch (e) {
                    console.error(`Failed to enrich ${tick.symbol}`, e);
                }
            }));
        }

        // Layer 2: Hard Filters (Spread, Depth)
        const layer2 = enrichedLayer1.filter(d => {
            if (heldSymbols.includes(d.symbol)) return true; // Always keep held
            return d.bookMetrics.spread_bps <= screenerCfg.maxSpreadBps &&
                (d.bookMetrics.depth_usd.bid_1pct >= screenerCfg.minDepthUsd || d.bookMetrics.depth_usd.ask_1pct >= screenerCfg.minDepthUsd);
        });
        console.log(`Layer 2: ${layer2.length} passed hard filters.`);

        // Layer 3: Action Filters (Intraday Volatility & Movement)
        let layer3 = layer2.filter(d => {
            if (heldSymbols.includes(d.symbol)) return true;

            // Primary check: Is it volatile relative to itself?
            const isVolatile = d.metrics.vol_zscores.vol_5m_vs_1h > screenerCfg.minVolZscore;

            // Secondary check: Is it moving?
            const isMoving = Math.abs(d.metrics.vol_zscores.ret_5m_vs_1h) > screenerCfg.minRetZscore;

            // Absolute volatility check (don't trade dead assets even if z-score is high)
            // Hardcoded fallback for now as it wasn't in the config explicitly, but could be added.
            // Using a safe default or deriving from config if needed.
            const minRealizedVol = 0.0005;
            const hasMinVol = d.metrics.realized_vol.m5 > minRealizedVol;

            return (isVolatile || isMoving) && hasMinVol;
        });

        // FALLBACK: If too few candidates, relax filters
        if (layer3.length < 3) {
            console.log("⚠️ Layer 3 filtered too many symbols. Relaxing filters...");
            layer3 = layer2.filter(d => {
                if (heldSymbols.includes(d.symbol)) return true;
                return d.metrics.realized_vol.m5 > 0.00025; // Relaxed vol threshold
            });
            console.log(`⚠️ Relaxed Layer 3: ${layer3.length} symbols passed.`);
        }

        console.log(`Layer 3: ${layer3.length} passed action filters.`);

        // Layer 4: Scoring & Ranking
        const scored = [];
        const weights = screenerCfg.quality_weights;

        for (const candidate of layer3) {
            // Scoring: Prioritize Intraday Volatility Z-Score
            const volScore = weights.vol_score * Math.abs(candidate.metrics.vol_zscores.vol_5m_vs_1h);
            const moveScore = weights.move_score * Math.abs(candidate.metrics.vol_zscores.ret_5m_vs_1h);

            // Trend Alignment Bonus
            const s5 = Math.sign(candidate.metrics.returns.m5);
            const s15 = Math.sign(candidate.metrics.returns.m15);
            const s60 = Math.sign(candidate.metrics.returns.h1);
            const trendAlign = (s5 === s15 && s15 === s60 && s5 !== 0) ? weights.trend_align : 0;

            // Penalties
            // Dynamic Spread Threshold: Scale acceptable spread with volatility.
            const dynamicSpreadThreshold = 3 + (candidate.metrics.realized_vol.m5 * 2000);
            const spreadPenalty = weights.spread_penalty * Math.max(0, candidate.bookMetrics.spread_bps - dynamicSpreadThreshold) / 5;

            const minDepth = Math.min(candidate.bookMetrics.depth_usd.bid_1pct, candidate.bookMetrics.depth_usd.ask_1pct);
            const illiquidityPenalty = weights.illiquidity_penalty * Math.max(0, (screenerCfg.minDepthUsd / minDepth) - 1);

            const totalScore = volScore + moveScore + trendAlign - spreadPenalty - illiquidityPenalty;

            scored.push({
                ...candidate,
                score: totalScore,
                sentiment: candidate.sentiment // Already fetched
            });
        }

        // Sort
        scored.sort((a, b) => b.score - a.score);

        // Top N + Held
        const topCandidates = scored.slice(0, screenerCfg.topN);
        const heldSet = new Set(heldSymbols);
        let heldAdded = 0;
        for (const c of scored) {
            if (heldSet.has(c.symbol) && !topCandidates.includes(c)) {
                topCandidates.push(c);
                heldAdded++;
            }
        }

        // If still < 3, grab from layer2 (hard filters only) to ensure we have something
        if (topCandidates.length < 3 && layer2.length > topCandidates.length) {
            console.log("⚠️ Still too few candidates. Filling with Layer 2 symbols...");
            for (const c of layer2) {
                if (topCandidates.length >= 3) break;
                if (!topCandidates.find(tc => tc.symbol === c.symbol)) {
                    topCandidates.push({ ...c, score: 0, sentiment: { symbol: c.symbol, score: 0, disagreement: 0, mentions: 0, mentions_vs_baseline: 0, change_2h: 0, source_mix: {}, tags: [], sentiment_confidence: 0, notes: "Fallback" } });
                }
            }
        }

        // Deduplicate by symbol
        const deduped: ScreenedSymbol[] = [];
        const seen = new Set<string>();
        for (const c of topCandidates) {
            if (seen.has(c.symbol)) continue;
            seen.add(c.symbol);
            deduped.push(c);
        }

        console.log(`✅ Screening completed in ${Date.now() - startTime}ms. Returning ${deduped.length} unique symbols (topN=${screenerCfg.topN} + ${heldAdded} held).`);
        return deduped;
    }
}
