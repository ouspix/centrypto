import { MarketDataService, EnrichedMarketData } from "./MarketDataService";
import { SentimentService } from "./SentimentService";

export type ScreenedSymbol = EnrichedMarketData & {
    score: number;
    sentiment: any;
};

export type ScreeningConfig = {
    layer1Enabled: boolean;
    minVolume24h: number;
    layer2Enabled: boolean;
    maxSpreadBps: number;
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
    private marketDataService: MarketDataService;
    private sentimentService: SentimentService;

    constructor() {
        this.marketDataService = new MarketDataService();
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

        // 1. Fetch ALL Market Data from DB Snapshot
        const allData = await this.marketDataService.getLatestSnapshot(isTestnet);
        if (!allData || allData.length === 0) {
            console.warn("⚠️ No market data snapshot found. Screening cannot proceed.");
            return [];
        }
        console.log(`Loaded ${allData.length} symbols from MarketStateSnapshot.`);

        // 2. Apply Filters In-Memory

        // Layer 1: Volume
        const layer1 = cfg.layer1Enabled
            ? allData.filter(d => d.volume24h >= cfg.minVolume24h)
            : allData;
        console.log(`Layer 1: ${layer1.length} passed volume filter (threshold: $${(cfg.minVolume24h / 1_000_000).toFixed(1)}M, sample volumes: ${allData.slice(0, 3).map(d => `${d.symbol}=$${(d.volume24h / 1_000_000).toFixed(1)}M`).join(', ')}).`);

        // Layer 2: Hard Filters (Spread, Depth)
        const layer2 = cfg.layer2Enabled
            ? layer1.filter(d => {
                if (heldSymbols.includes(d.symbol)) return true; // Always keep held
                return d.bookMetrics.spread_bps <= cfg.maxSpreadBps &&
                    (d.bookMetrics.depth_usd.bid_1pct >= cfg.minDepthUsd || d.bookMetrics.depth_usd.ask_1pct >= cfg.minDepthUsd);
            })
            : layer1;
        console.log(`Layer 2: ${layer2.length} passed hard filters.`);

        // Layer 3: Action Filters
        let layer3 = cfg.layer3Enabled
            ? layer2.filter(d => {
                if (heldSymbols.includes(d.symbol)) return true;
                const volSpike = d.metrics.vol_zscores.vol_5m_vs_1h > cfg.minVolZscore;
                const moveSpike = Math.abs(d.metrics.vol_zscores.ret_5m_vs_1h) > cfg.minRetZscore;
                const minVol = d.metrics.realized_vol.m5 > cfg.minRealizedVol;
                const significantMove = Math.abs(d.metrics.returns.m5) > cfg.minRetM5 || Math.abs(d.metrics.returns.m15) > cfg.minRetM15;
                return volSpike || moveSpike || (minVol && significantMove);
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

            const volScore = 1.5 * Math.abs(candidate.metrics.vol_zscores.vol_5m_vs_1h);
            const moveScore = 1.0 * Math.abs(candidate.metrics.vol_zscores.ret_5m_vs_1h);

            const s5 = Math.sign(candidate.metrics.returns.m5);
            const s15 = Math.sign(candidate.metrics.returns.m15);
            const s60 = Math.sign(candidate.metrics.returns.h1);
            const trendAlign = (s5 === s15 && s15 === s60 && s5 !== 0) ? 0.5 : (s5 !== s15 || s15 !== s60 ? -0.5 : 0);

            const attentionScore = 0.3 * Math.log(1 + Math.max(0, (sentiment.mentions_vs_baseline || 1) - 1));
            const spreadPenalty = 0.5 * Math.max(0, candidate.bookMetrics.spread_bps - 5) / 10;
            const illiquidityPenalty = 0.3 * Math.max(0, (cfg.minDepthUsd / Math.min(candidate.bookMetrics.depth_usd.bid_1pct, candidate.bookMetrics.depth_usd.ask_1pct)) - 1);

            const totalScore = volScore + moveScore + trendAlign + attentionScore - spreadPenalty - illiquidityPenalty;

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
