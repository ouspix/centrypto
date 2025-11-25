import { MarketAnalysisService, MarketMetrics, OrderBookMetrics } from "./MarketAnalysisService";
import { SentimentService } from "./SentimentService";
import { marketDbMain, marketDbTest } from "@/lib/market-db";

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

export type ScreeningConfig = {
    layer1Enabled: boolean;
    minVolume24h: number;
    layer2Enabled: boolean;
    maxSpreadBps: number;
    dynamicSpreadEnabled: boolean;
    minDepthUsd: number;
    layer3Enabled: boolean;
    minVolZscore: number;
    minRetZscore: number;
    minRealizedVol: number;
    minRetM5: number;
    minRetM15: number;
    layer4Enabled: boolean;
    topN: number;
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
        config?: ScreeningConfig
    ): Promise<ScreenedSymbol[]> {
        // Merge provided config with defaults
        const defaultConfig: ScreeningConfig = {
            layer1Enabled: true,
            minVolume24h: 1_000_000,
            layer2Enabled: true,
            maxSpreadBps: 50,
            dynamicSpreadEnabled: true,
            minDepthUsd: 10_000,
            layer3Enabled: true,
            minVolZscore: 0.5,
            minRetZscore: 0.5,
            minRealizedVol: 0.0005,
            minRetM5: 0.0001,
            minRetM15: 0.0001,
            layer4Enabled: true,
            topN: 20
        };

        const cfg: ScreeningConfig = { ...defaultConfig, ...config };

        console.log(`🔍 Starting On-Demand Screening with topN=${cfg.topN}, config provided:`, !!config);
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
        // Layer 1: Volume
        // We filter based on the tick's volume24h
        const layer1 = cfg.layer1Enabled
            ? allTicks.filter(d => (d.volume24h ?? 0) >= cfg.minVolume24h)
            : allTicks;
        console.log(`Layer 1: ${layer1.length} passed volume filter (threshold: $${(cfg.minVolume24h / 1_000_000).toFixed(1)}M).`);

        // Layer 2: Hard Filters (Spread, Depth)
        // Enrich Layer 1 Survivors (Fetch Metrics, Book, Sentiment)
        // This is more expensive, so we only do it for survivors.
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
        const layer2 = cfg.layer2Enabled
            ? enrichedLayer1.filter(d => {
                if (heldSymbols.includes(d.symbol)) return true; // Always keep held
                return d.bookMetrics.spread_bps <= cfg.maxSpreadBps &&
                    (d.bookMetrics.depth_usd.bid_1pct >= cfg.minDepthUsd || d.bookMetrics.depth_usd.ask_1pct >= cfg.minDepthUsd);
            })
            : enrichedLayer1;
        console.log(`Layer 2: ${layer2.length} passed hard filters.`);

        // Layer 3: Action Filters (Intraday Volatility & Movement)
        // We want symbols that are "in play" - moving or volatile.
        let layer3 = cfg.layer3Enabled
            ? layer2.filter(d => {
                if (heldSymbols.includes(d.symbol)) return true;

                // Primary check: Is it volatile relative to itself?
                const isVolatile = d.metrics.vol_zscores.vol_5m_vs_1h > cfg.minVolZscore;

                // Secondary check: Is it moving?
                const isMoving = Math.abs(d.metrics.vol_zscores.ret_5m_vs_1h) > cfg.minRetZscore;

                // Absolute volatility check (don't trade dead assets even if z-score is high)
                const hasMinVol = d.metrics.realized_vol.m5 > cfg.minRealizedVol;

                return (isVolatile || isMoving) && hasMinVol;
            })
            : layer2;

        // FALLBACK: If too few candidates, relax filters
        if (layer3.length < 3 && cfg.layer3Enabled) {
            console.log("⚠️ Layer 3 filtered too many symbols. Relaxing filters...");
            // Relaxed logic: just check for minimum volatility, ignore z-scores
            layer3 = layer2.filter(d => {
                if (heldSymbols.includes(d.symbol)) return true;
                return d.metrics.realized_vol.m5 > (cfg.minRealizedVol * 0.5); // 50% lower vol threshold
            });
            console.log(`⚠️ Relaxed Layer 3: ${layer3.length} symbols passed.`);
        }

        console.log(`Layer 3: ${layer3.length} passed action filters.`);

        // Layer 4: Scoring & Ranking
        const scored = [];
        for (const candidate of layer3) {
            // Fetch sentiment (cached in DB ideally, but service handles it)
            const sentiment = await this.sentimentService.getSentimentForCoin(candidate.symbol);

            // Scoring: Prioritize Intraday Volatility Z-Score
            // This defines "In Play"
            const volScore = 2.0 * Math.abs(candidate.metrics.vol_zscores.vol_5m_vs_1h);
            const moveScore = 1.0 * Math.abs(candidate.metrics.vol_zscores.ret_5m_vs_1h);

            // Trend Alignment Bonus
            const s5 = Math.sign(candidate.metrics.returns.m5);
            const s15 = Math.sign(candidate.metrics.returns.m15);
            const s60 = Math.sign(candidate.metrics.returns.h1);
            const trendAlign = (s5 === s15 && s15 === s60 && s5 !== 0) ? 0.5 : 0;

            // Penalties
            // Dynamic Spread Threshold: Scale acceptable spread with volatility.
            // If vol is high, we tolerate wider spreads.
            // Base = 3bps. Add buffer based on realized_vol (m5).
            // Example: Vol 0.005 (0.5%) -> +10bps. Vol 0.001 (0.1%) -> +2bps.
            const dynamicSpreadThreshold = cfg.dynamicSpreadEnabled
                ? 3 + (candidate.metrics.realized_vol.m5 * 2000)
                : 3;
            const spreadPenalty = 1.0 * Math.max(0, candidate.bookMetrics.spread_bps - dynamicSpreadThreshold) / 5;
            const illiquidityPenalty = 0.5 * Math.max(0, (cfg.minDepthUsd / Math.min(candidate.bookMetrics.depth_usd.bid_1pct, candidate.bookMetrics.depth_usd.ask_1pct)) - 1);

            const totalScore = volScore + moveScore + trendAlign - spreadPenalty - illiquidityPenalty;

            scored.push({
                ...candidate,
                score: totalScore,
                sentiment
            });
        }

        // Sort
        scored.sort((a, b) => b.score - a.score);

        // Top N + Held
        const topCandidates = scored.slice(0, cfg.topN);
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
                    // Need to score them or just add with default score
                    // Re-using score logic would be better but for fallback just add
                    topCandidates.push({ ...c, score: 0, sentiment: { symbol: c.symbol, score: 0, disagreement: 0, mentions: 0, mentions_vs_baseline: 0, change_2h: 0, source_mix: {}, tags: [], sentiment_confidence: 0, notes: "Fallback" } });
                }
            }
        }

        // Deduplicate by symbol to avoid duplicate market entries downstream
        const deduped: ScreenedSymbol[] = [];
        const seen = new Set<string>();
        for (const c of topCandidates) {
            if (seen.has(c.symbol)) continue;
            seen.add(c.symbol);
            deduped.push(c);
        }

        console.log(`✅ Screening completed in ${Date.now() - startTime}ms. Returning ${deduped.length} unique symbols (topN=${cfg.topN} + ${heldAdded} held, deduped from ${topCandidates.length}).`);
        return deduped;
    }
}
