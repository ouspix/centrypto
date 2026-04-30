import { MarketAnalysisService, MarketMetrics, OrderBookMetrics } from "./MarketAnalysisService";
import { SentimentService } from "./SentimentService";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";
import { OrderBookManager } from "./OrderBookManager";
import { HyperliquidWS } from "@/lib/hyperliquid-ws";

type CacheEntry<T> = {
    expiresAt: number;
    value?: T;
    promise?: Promise<T>;
};

type RecentTickWindow = {
    ticks: Awaited<ReturnType<typeof marketDbMain.marketTick.findMany>>;
    referenceTime: Date | null;
    usedSnapshotFallback: boolean;
};

const QUERY_TTLS_MS = {
    recentTicks: 5_000,
    recentVolume: 15_000,
    metrics: 30_000,
    sentiment: 5 * 60_000,
    orderBook: 5_000
};

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
    private readonly isTestnet: boolean;
    private readonly queryCache = new Map<string, CacheEntry<unknown>>();

    constructor(isTestnet: boolean = true, options: { disableLive?: boolean } = {}) {
        this.marketAnalysisService = new MarketAnalysisService();
        this.sentimentService = new SentimentService();

        this.isTestnet = isTestnet;

        // Initialize WS and OrderBookManager
        // We default to Mainnet for now. Ideally, we should support switching or multiple instances.
        this.ws = new HyperliquidWS(this.isTestnet);
        this.orderBookManager = new OrderBookManager(this.ws);
        if (!options.disableLive) {
            this.ws.connect();
        }
    }

    public async getScreenedSymbols(
        _isTestnet: boolean | undefined,
        heldSymbols: string[] = [],
        config: AgentConfig = DEFAULT_AGENT_CONFIG,
        screenerConfig: ScreenerConfig = DEFAULT_SCREENER_CONFIG,
        signal?: AbortSignal
    ): Promise<ScreenedSymbol[]> {
        this.assertNotAborted(signal);
        // Enforce active network
        const isTestnet = this.isTestnet;
        const screenerCfg = screenerConfig;
        this.orderBookManager.setDepthBandsPct(screenerCfg.depthBandsPct);

        console.log(`🔍 Starting On-Demand Screening with topN=${screenerCfg.topN}`);
        const startTime = Date.now();

        const recentWindow = await this.getRecentTicks();
        const recentTicks = recentWindow.ticks;
        this.assertNotAborted(signal);

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
            console.warn("⚠️ No recent market ticks found in DB. Falling back to live fetch for a small default universe.");
            const fallbackSymbols = ["BTC", "ETH", "SOL", "LINK", "DOGE", "XRP"];
            const fallbackCandidates: ScreenedSymbol[] = [];

            for (const symbol of fallbackSymbols) {
                try {
                    const [metrics, sentiment, bookMetrics] = await Promise.all([
                        this.getMetrics(symbol, true),
                        this.getSentiment(symbol),
                        this.getBookMetricsWithFallback(symbol, screenerCfg.depthBandsPct)
                    ]);

                    const price = bookMetrics.mid || 0;
                    const candidate: ScreenedSymbol = {
                        symbol,
                        price,
                        volume24h: 0,
                        funding: 0,
                        openInterest: 0,
                        metrics,
                        bookMetrics,
                        sentiment,
                        isTestnet,
                        score: 0
                    };

                    const activityOk = !screenerCfg.layer3Enabled ||
                        this.filterByActivity([{ ...candidate, sentiment }], heldSymbols, screenerCfg).length > 0;
                    const liquidityOk = !screenerCfg.layer2Enabled ||
                        this.filterByLiquidity([{ ...candidate, bookMetrics }], heldSymbols, screenerCfg).length > 0;

                    if (activityOk && liquidityOk) {
                        fallbackCandidates.push(candidate);
                    }
                } catch (e) {
                    console.error(`Fallback fetch failed for ${symbol}`, e);
                }
            }

            return this.scoreAndRank(fallbackCandidates, heldSymbols, screenerCfg);
        }

        // --- Layer 1: Universe Control (Hard Gate) ---
        const universeCandidates = screenerCfg.layer1Enabled
            ? this.filterByUniverse(allTicks, heldSymbols, screenerCfg)
            : allTicks;
        console.log(`Layer 1 (Universe): ${universeCandidates.length} ${screenerCfg.layer1Enabled ? `passed minVolume24h (${screenerCfg.minVolume24h})` : "kept; gate disabled"}.`);
        this.assertNotAborted(signal);

        // --- Layer 2: Activity / "In-Play" (Hard Gate) ---
        // 2a. Calculate Recent Volume (Quote Volume in last X mins)
        const recentVolumeMap = screenerCfg.layer3Enabled
            ? await this.getRecentVolumeMap(screenerCfg.recentVolumeMinutes, recentWindow.referenceTime)
            : new Map<string, number>();
        this.assertNotAborted(signal);

        const activityCandidates: (EnrichedMarketData & { sentiment: any })[] = [];

        const batchSize = 10;
        for (let i = 0; i < universeCandidates.length; i += batchSize) {
            this.assertNotAborted(signal);
            const batch = universeCandidates.slice(i, i + batchSize);
            await Promise.all(batch.map(async (tick) => {
                this.assertNotAborted(signal);
                if (screenerCfg.layer3Enabled) {
                    // Check Recent Volume first (cheap)
                    const recentBaseVol = recentVolumeMap.get(tick.symbol) || 0;
                    const recentQuoteVol = recentBaseVol * tick.markPrice;

                    if (!heldSymbols.includes(tick.symbol) && recentQuoteVol < screenerCfg.minRecentVolume) {
                        return;
                    }
                }

                try {
                    const baselineTick = earliestTicksMap.get(tick.symbol) || tick;
                    const oiDelta5m = (tick.openInterest || 0) - (baselineTick.openInterest || 0);
                    const fundingDelta5m = (tick.fundingRate || 0) - (baselineTick.fundingRate || 0);

                    // Fetch Metrics & Sentiment
                    const [metrics, sentiment] = await Promise.all([
                        // Screening should not trigger live candle backfills; the collector owns hydration.
                        this.getMetrics(tick.symbol, false),
                        this.getSentiment(tick.symbol)
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
                    if (!screenerCfg.layer3Enabled || this.filterByActivity([candidate], heldSymbols, screenerCfg).length > 0) {
                        this.assertNotAborted(signal);
                        activityCandidates.push(candidate);
                    }

                } catch (e) {
                    if (this.isAbortError(e)) throw e;
                    console.error(`Failed to fetch metrics for ${tick.symbol}`, e);
                }
            }));
        }
        this.assertNotAborted(signal);
        console.log(`Layer 2 (Activity): ${activityCandidates.length} ${screenerCfg.layer3Enabled ? "passed recentVolume & realizedVol" : "kept; gate disabled"}.`);

        // --- Layer 3: Liquidity / Execution (Hard Gate) ---
        const symbolsToTrack = activityCandidates.map(c => c.symbol);
        this.orderBookManager.updateSubscriptions(symbolsToTrack);

        // 2. Wait for data (warmup)
        await this.sleep(2000, signal);
        this.assertNotAborted(signal);

        const liquidityCandidates: EnrichedMarketData[] = [];

        for (let i = 0; i < activityCandidates.length; i += batchSize) {
            this.assertNotAborted(signal);
            const batch = activityCandidates.slice(i, i + batchSize);
            await Promise.all(batch.map(async (candidate) => {
                this.assertNotAborted(signal);
                try {
                    const bookMetrics = await this.getBookMetricsWithFallback(
                        candidate.symbol,
                        screenerCfg.depthBandsPct
                    );
                    const enriched = { ...candidate, bookMetrics };

                    if (!screenerCfg.layer2Enabled || this.filterByLiquidity([enriched], heldSymbols, screenerCfg).length > 0) {
                        liquidityCandidates.push(enriched);
                    } else if (heldSymbols.includes(candidate.symbol)) {
                        // Keep held symbols even if they fail liquidity (though filterByLiquidity should handle this if passed heldSymbols)
                    }
                } catch (e) {
                    if (this.isAbortError(e)) throw e;
                    console.error(`Failed to get L2 metrics for ${candidate.symbol}`, e);
                    if (heldSymbols.includes(candidate.symbol)) {
                        liquidityCandidates.push(candidate);
                    }
                }
            }));
        }
        this.assertNotAborted(signal);
        console.log(`Layer 3 (Liquidity): ${liquidityCandidates.length} ${screenerCfg.layer2Enabled ? "passed spread & depth" : "kept with hydrated book metrics; gate disabled"}.`);

        // --- Layer 4: Quality Scoring (Ranking) ---
        const deduped = this.scoreAndRank(liquidityCandidates, heldSymbols, screenerCfg);

        console.log(`✅ Screening completed in ${Date.now() - startTime}ms. Returning ${deduped.length} unique symbols (topN=${screenerCfg.topN}).`);
        return deduped;
    }

    private cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
        const now = Date.now();
        const existing = this.queryCache.get(key) as CacheEntry<T> | undefined;

        if (existing) {
            if (existing.value !== undefined && existing.expiresAt > now) {
                return Promise.resolve(existing.value);
            }
            if (existing.promise) {
                return existing.promise;
            }
        }

        const promise = loader()
            .then(value => {
                this.queryCache.set(key, {
                    value,
                    expiresAt: Date.now() + ttlMs
                });
                return value;
            })
            .catch(error => {
                this.queryCache.delete(key);
                throw error;
            });

        this.queryCache.set(key, {
            promise,
            expiresAt: now + ttlMs
        });

        return promise;
    }

    private async getRecentTicks(): Promise<RecentTickWindow> {
        const db = this.isTestnet ? marketDbTest : marketDbMain;
        const key = `${this.networkKey()}:recentTicks`;

        return this.cached(key, QUERY_TTLS_MS.recentTicks, async () => {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const wallClockTicks = await db.marketTick.findMany({
                where: { ts: { gte: fiveMinutesAgo } },
                orderBy: { ts: 'desc' }
            });

            if (wallClockTicks.length > 0) {
                return {
                    ticks: wallClockTicks,
                    referenceTime: wallClockTicks[0].ts,
                    usedSnapshotFallback: false
                };
            }

            const latestTick = await db.marketTick.findFirst({
                orderBy: { ts: 'desc' }
            });

            if (!latestTick) {
                return {
                    ticks: [],
                    referenceTime: null,
                    usedSnapshotFallback: false
                };
            }

            const snapshotCutoff = new Date(latestTick.ts.getTime() - 5 * 60 * 1000);
            const snapshotTicks = await db.marketTick.findMany({
                where: {
                    ts: {
                        gte: snapshotCutoff,
                        lte: latestTick.ts
                    }
                },
                orderBy: { ts: 'desc' }
            });

            console.warn(`[Screener] No wall-clock-fresh ${this.networkKey()} ticks; using DB snapshot window ending ${latestTick.ts.toISOString()}.`);
            return {
                ticks: snapshotTicks,
                referenceTime: latestTick.ts,
                usedSnapshotFallback: true
            };
        });
    }

    private async getRecentVolumeMap(recentVolumeMinutes: number, referenceTime: Date | null) {
        const db = this.isTestnet ? marketDbTest : marketDbMain;
        const referenceMs = referenceTime?.getTime() ?? Date.now();
        const key = `${this.networkKey()}:recentVolume:${recentVolumeMinutes}:${referenceMs}`;

        return this.cached(key, QUERY_TTLS_MS.recentVolume, async () => {
            const reference = new Date(referenceMs);
            const recentWindowStart = new Date(reference.getTime() - recentVolumeMinutes * 60 * 1000);
            const recentVolumes = await db.marketCandle.groupBy({
                by: ['symbol'],
                where: {
                    openTime: {
                        gte: recentWindowStart,
                        lte: reference
                    }
                },
                _sum: {
                    volume: true
                }
            });

            const volumeMap = new Map<string, number>();
            for (const rv of recentVolumes) {
                volumeMap.set(rv.symbol, rv._sum.volume || 0);
            }
            return volumeMap;
        });
    }

    private getMetrics(symbol: string, allowFetch: boolean) {
        const key = `${this.networkKey()}:metrics:${symbol}:fetch:${allowFetch}`;
        return this.cached(key, QUERY_TTLS_MS.metrics, () =>
            this.marketAnalysisService.getMetricsForSymbol(symbol, this.isTestnet, allowFetch)
        );
    }

    private getSentiment(symbol: string) {
        const key = `sentiment:${symbol}`;
        return this.cached(key, QUERY_TTLS_MS.sentiment, () =>
            this.sentimentService.getSentimentForCoin(symbol)
        );
    }

    private networkKey() {
        return this.isTestnet ? "testnet" : "mainnet";
    }

    private assertNotAborted(signal?: AbortSignal) {
        if (!signal?.aborted) return;
        const error = new Error("Screening aborted");
        error.name = "AbortError";
        throw error;
    }

    private sleep(ms: number, signal?: AbortSignal) {
        return new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
                const error = new Error("Screening aborted");
                error.name = "AbortError";
                reject(error);
                return;
            }

            const timeout = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);

            const onAbort = () => {
                clearTimeout(timeout);
                const error = new Error("Screening aborted");
                error.name = "AbortError";
                reject(error);
            };

            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    private isAbortError(error: unknown) {
        return error instanceof Error && error.name === "AbortError";
    }

    private bookMetricsMissing(metrics: OrderBookMetrics | undefined): boolean {
        if (!metrics) return true;

        const bid = metrics.depth_usd?.bid_1pct ?? 0;
        const ask = metrics.depth_usd?.ask_1pct ?? 0;
        const hasPrices = (metrics.best_bid ?? 0) > 0 && (metrics.best_ask ?? 0) > 0;
        const hasDepth = bid > 0 && ask > 0;

        return !(hasPrices && hasDepth);
    }

    private async getBookMetricsWithFallback(
        symbol: string,
        depthBandsPct: string[]
    ): Promise<OrderBookMetrics> {
        const key = `${this.networkKey()}:book:${symbol}:${depthBandsPct.join(",")}`;
        return this.cached(key, QUERY_TTLS_MS.orderBook, () =>
            this.loadBookMetricsWithFallback(symbol, depthBandsPct)
        );
    }

    private async loadBookMetricsWithFallback(
        symbol: string,
        depthBandsPct: string[]
    ): Promise<OrderBookMetrics> {
        const baseMetrics = this.orderBookManager.getMetrics(symbol);
        if (!this.bookMetricsMissing(baseMetrics)) {
            return baseMetrics;
        }

        try {
            const fetched = await this.marketAnalysisService.getOrderBookMetrics(symbol, this.isTestnet, true, depthBandsPct);

            // Prefer fetched values when the WS cache is empty, but keep any non-zero fields we already have
            return {
                ...baseMetrics,
                ...fetched,
                depth_bands_usd: fetched.depth_bands_usd ?? baseMetrics.depth_bands_usd
            };
        } catch (err) {
            console.error(`[Screener] Failed to hydrate orderbook for ${symbol}`, err);
            return baseMetrics;
        }
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
        if (!config.layer4Enabled) {
            const unscored = candidates.map(candidate => ({
                ...candidate,
                score: 0,
                sentiment: candidate.sentiment
            }));
            return this.limitAndDedupe(unscored, heldSymbols, config.topN);
        }

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
            const expectedMoveBps = 10000 * Math.max(Math.abs(candidate.metrics.returns.m15), Math.abs(candidate.metrics.returns.h1));
            const estimatedCostBps = 3.5 + candidate.bookMetrics.spread_bps;
            const edgeToCost = estimatedCostBps > 0 ? Math.max(0, (expectedMoveBps - estimatedCostBps) / estimatedCostBps) : 0;
            const costToEdgePenalty = (weights.cost_to_edge_penalty ?? 0) * (1 / Math.max(edgeToCost, 0.1));

            const totalScore = volScore + moveScore + trendAlign - spreadPenalty - illiquidityPenalty - costToEdgePenalty;

            scored.push({
                ...candidate,
                score: totalScore,
                sentiment: candidate.sentiment
            });
        }

        scored.sort((a, b) => b.score - a.score);

        return this.limitAndDedupe(scored, heldSymbols, config.topN);
    }

    private limitAndDedupe(scored: ScreenedSymbol[], heldSymbols: string[], topN: number): ScreenedSymbol[] {
        const topCandidates = scored.slice(0, topN);
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
