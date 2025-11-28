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
        // 1a. Calculate Recent Volume (Quote Volume in last X mins)
        const recentWindowStart = new Date(Date.now() - screenerCfg.recentVolumeMinutes * 60 * 1000);
        console.log(`Debug: recentWindowStart=${recentWindowStart.toISOString()} (${recentWindowStart.getTime()})`);

        // Aggregate volume from candles for each symbol
        // Note: MarketCandle volume is typically Base Volume. We need Quote Volume (Base Vol * Price).
        // Since we don't have a direct quote volume field, we'll sum base volume and multiply by current price.
        // This is an approximation but sufficient for screening.
        const recentVolumes = await db.marketCandle.groupBy({
            by: ['symbol'],
            where: {
                openTime: { gte: recentWindowStart }
            },
            _sum: {
                volume: true
            }
        });
        console.log(`Debug: recentVolumes found for ${recentVolumes.length} symbols.`);

        // Debug specific symbol
        const ada = recentVolumes.find(r => r.symbol === 'ADA');
        if (ada) {
            console.log(`Debug: ADA volume sum: ${ada._sum.volume}`);
        } else {
            console.log("Debug: ADA not found in recentVolumes.");
        }

        // Verify DB connection and data
        const count = await db.marketCandle.count();
        console.log(`Debug: Total candles in DB: ${count}`);

        // Debug raw candles
        const rawCandles = await db.marketCandle.findMany({
            where: { symbol: 'ADA', openTime: { gte: recentWindowStart } },
            take: 5
        });
        console.log(`Debug: Raw ADA candles: ${JSON.stringify(rawCandles)}`);

        if (recentVolumes.length > 0) {
            console.log(`Debug: Sample vol: ${recentVolumes[0].symbol}=${recentVolumes[0]._sum.volume}`);
        }

        const recentVolumeMap = new Map<string, number>();
        for (const rv of recentVolumes) {
            recentVolumeMap.set(rv.symbol, rv._sum.volume || 0);
        }

        // Layer 1: Volume
        const layer1 = screenerCfg.layer1Enabled ? allTicks.filter(d => {
            // Check 24h Volume
            if ((d.volume24h ?? 0) < screenerCfg.minVolume24h) return false;

            // Check Recent Activity
            const recentBaseVol = recentVolumeMap.get(d.symbol) || 0;
            const recentQuoteVol = recentBaseVol * d.markPrice;

            return recentQuoteVol >= screenerCfg.minRecentVolume;
        }) : allTicks;

        console.log(`Layer 1: ${layer1.length} passed volume filters.`);

        // STAGE 1: Fetch Metrics & Sentiment (Cheap/Cached)
        // We do this first to apply Volatility filters (Layer 3) BEFORE fetching expensive L2 Books
        const stage1Candidates: (EnrichedMarketData & { sentiment: any })[] = [];

        // Process sequentially to respect rate limits
        for (const tick of layer1) {
            try {
                const [metrics, sentiment] = await Promise.all([
                    this.marketAnalysisService.getMetricsForSymbol(tick.symbol, isTestnet, true),
                    this.sentimentService.getSentimentForCoin(tick.symbol)
                ]);

                stage1Candidates.push({
                    symbol: tick.symbol,
                    price: tick.markPrice,
                    volume24h: tick.volume24h || 0,
                    funding: tick.fundingRate || 0,
                    openInterest: tick.openInterest || 0,
                    metrics,
                    bookMetrics: { // Placeholder, filled later if passes L3
                        spread_bps: 0,
                        depth_usd: { bid_1pct: 0, ask_1pct: 0 },
                        imbalance: 0,
                        book_pressure: 0,
                        cost_bps: 0
                    },
                    sentiment,
                    isTestnet
                });
            } catch (e) {
                console.error(`Failed to fetch stage 1 data for ${tick.symbol}`, e);
            }
        }

        // Layer 3: Action Filters (Intraday Volatility & Movement)
        // Apply this EARLY to filter out dead assets before fetching L2 books
        let layer3 = stage1Candidates;
        if (screenerCfg.layer3Enabled) {
            layer3 = stage1Candidates.filter(d => {
                if (heldSymbols.includes(d.symbol)) return true;

                // Primary check: Is it volatile relative to itself?
                const isVolatile = d.metrics.vol_zscores.vol_5m_vs_1h > screenerCfg.minVolZscore;

                // Secondary check: Is it moving?
                const isMoving = Math.abs(d.metrics.vol_zscores.ret_5m_vs_1h) > screenerCfg.minRetZscore;

                // Absolute volatility check (don't trade dead assets even if z-score is high)
                const minRealizedVol = screenerCfg.minRealizedVol || 0.0005;
                const hasMinVol = d.metrics.realized_vol.m5 > minRealizedVol;

                return (isVolatile || isMoving) && hasMinVol;
            });
            console.log(`Layer 3: ${layer3.length} passed action filters.`);
        } else {
            console.log(`Layer 3: Skipped (disabled). Keeping ${layer3.length} candidates.`);
        }

        // FALLBACK: If too few candidates, relax filters
        if (layer3.length < 3) {
            console.log("⚠️ Layer 3 filtered too many symbols. Relaxing filters...");
            layer3 = stage1Candidates.filter(d => {
                if (heldSymbols.includes(d.symbol)) return true;
                return d.metrics.realized_vol.m5 > 0.00025; // Relaxed vol threshold
            });
            console.log(`⚠️ Relaxed Layer 3: ${layer3.length} symbols passed.`);
        }

        // STAGE 2: Fetch L2 Book Metrics (Expensive)
        // Only for survivors of Layer 3
        const stage2Candidates: EnrichedMarketData[] = [];

        for (const candidate of layer3) {
            try {
                const bookMetrics = await this.marketAnalysisService.getOrderBookMetrics(candidate.symbol, isTestnet, true);
                stage2Candidates.push({
                    ...candidate,
                    bookMetrics
                });
            } catch (e) {
                console.error(`Failed to fetch L2 book for ${candidate.symbol}`, e);
                // Keep candidate with empty metrics? Or drop? 
                // Let's keep it but it will likely fail L2 filters if they are strict
                stage2Candidates.push(candidate);
            }
        }

        // Layer 2: Hard Filters (Spread, Depth)
        let layer2 = stage2Candidates;
        if (screenerCfg.layer2Enabled) {
            layer2 = stage2Candidates.filter(d => {
                if (heldSymbols.includes(d.symbol)) return true; // Always keep held
                return d.bookMetrics.spread_bps <= screenerCfg.maxSpreadBps &&
                    (d.bookMetrics.depth_usd.bid_1pct >= screenerCfg.minDepthUsd || d.bookMetrics.depth_usd.ask_1pct >= screenerCfg.minDepthUsd);
            });
            console.log(`Layer 2: ${layer2.length} passed hard filters.`);
        } else {
            console.log(`Layer 2: Skipped (disabled). Keeping ${layer2.length} candidates.`);
        }

        // Layer 4: Scoring & Ranking
        const scored = [];
        const weights = screenerCfg.quality_weights;

        if (screenerCfg.layer4Enabled) {
            for (const candidate of layer2) {
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
        } else {
            // If Layer 4 disabled, just pass through with 0 score
            for (const candidate of layer2) {
                scored.push({
                    ...candidate,
                    score: 0,
                    sentiment: candidate.sentiment
                });
            }
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
        // Note: In this new pipeline, layer2 IS the set of survivors. 
        // If topCandidates is small, it means we didn't have many survivors or TopN is small.
        // We can't really "fill" from anywhere else unless we relax filters earlier.

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
