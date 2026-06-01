import { MarketAnalysisService, MarketMetrics, OrderBookMetrics } from "./MarketAnalysisService";
import { SentimentService } from "./SentimentService";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";
import { computeExecutionCostBps } from "@/lib/trading/execution-cost";
import { OrderBookManager } from "./OrderBookManager";
import { HyperliquidWS, getSharedHyperliquidWS } from "@/lib/hyperliquid-ws";

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
    recentQuoteVolume?: number | null;
    metrics: MarketMetrics;
    bookMetrics: OrderBookMetrics;
    sentiment: any;
    isTestnet: boolean;
};

export type DiscoveryReason =
    | "QUALITY_TOP"
    | "HOT_MOVER"
    | "VOLUME_SPIKE"
    | "RANGE_EXPANSION"
    | "HELD_POSITION"
    | "FORCE_INCLUDED";

export type ExecutionBlockReason =
    | "SPREAD_GATE"
    | "DEPTH_GATE"
    | "COST_GATE"
    | "RECENT_VOLUME_GATE"
    | "REALIZED_VOL_GATE"
    | "VOLUME24H_GATE";

export type DiscoveryMetrics = {
    absMoveBps_m15: number | null;
    absMoveBps_h1: number | null;
    absMoveBps_h4: number | null;
    maxAbsMoveBps: number | null;
    recentQuoteVolume: number | null;
    relativeVolumeRatio: number | null;
    rangeExpansionRatio: number | null;
    realizedVolM5: number | null;
    volRatio5mVs1h: number | null;
    retSigma5mVs1h: number | null;
};

export type ExecutionDiagnostics = {
    tradeable: boolean;
    blockReasons: ExecutionBlockReason[];
    spreadBps: number | null;
    depthUsd: number | null;
    costBps: number | null;
};

export type ScreenedSymbol = EnrichedMarketData & {
    score: number;
    qualityScore: number;
    sentiment: any;
    discoveryReasons: DiscoveryReason[];
    discoveryMetrics: DiscoveryMetrics;
    execution: ExecutionDiagnostics;
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

        // Backtests and comparison scripts use disableLive and should not attach listeners
        // to the shared application websocket.
        this.ws = options.disableLive
            ? new HyperliquidWS(this.isTestnet)
            : getSharedHyperliquidWS(this.isTestnet);
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
            if (process.env.NODE_ENV === "production") {
                console.warn("No recent market ticks found in DB; collector is not ready.");
                return [];
            }
            console.warn("⚠️ No recent market ticks found in DB. Falling back to live fetch for a small default universe.");
            const fallbackSymbols = ["BTC", "ETH", "SOL", "LINK", "DOGE", "XRP"];
            const fallbackCandidates: EnrichedMarketData[] = [];

            for (const symbol of fallbackSymbols) {
                try {
                    const [metrics, sentiment, bookMetrics] = await Promise.all([
                        this.getMetrics(symbol, true),
                        this.getSentiment(symbol),
                        this.getBookMetricsWithFallback(symbol, screenerCfg.depthBandsPct)
                    ]);

                    const price = bookMetrics.mid || 0;
                    const candidate: EnrichedMarketData = {
                        symbol,
                        price,
                        volume24h: 0,
                        funding: 0,
                        openInterest: 0,
                        recentQuoteVolume: null,
                        metrics,
                        bookMetrics,
                        sentiment,
                        isTestnet
                    };
                    fallbackCandidates.push(candidate);
                } catch (e) {
                    console.error(`Fallback fetch failed for ${symbol}`, e);
                }
            }

            return this.discoverAndRank(fallbackCandidates, heldSymbols, screenerCfg, config);
        }

        const recentVolumeMap = screenerCfg.layer3Enabled
            ? await this.getRecentVolumeMap(screenerCfg.recentVolumeMinutes, recentWindow.referenceTime)
            : new Map<string, number>();
        this.assertNotAborted(signal);

        const enrichedCandidates: (EnrichedMarketData & { sentiment: any })[] = [];

        const batchSize = 10;
        for (let i = 0; i < allTicks.length; i += batchSize) {
            this.assertNotAborted(signal);
            const batch = allTicks.slice(i, i + batchSize);
            await Promise.all(batch.map(async (tick) => {
                this.assertNotAborted(signal);
                try {
                    const recentBaseVol = recentVolumeMap.get(tick.symbol) || 0;
                    const recentQuoteVol = screenerCfg.layer3Enabled ? recentBaseVol * tick.markPrice : null;
                    const baselineTick = earliestTicksMap.get(tick.symbol) || tick;
                    const oiDelta5m = (tick.openInterest || 0) - (baselineTick.openInterest || 0);
                    const fundingDelta5m = (tick.fundingRate || 0) - (baselineTick.fundingRate || 0);

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
                        recentQuoteVolume: recentQuoteVol,
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

                    this.assertNotAborted(signal);
                    enrichedCandidates.push(candidate);

                } catch (e) {
                    if (this.isAbortError(e)) throw e;
                    console.error(`Failed to fetch metrics for ${tick.symbol}`, e);
                }
            }));
        }
        this.assertNotAborted(signal);
        console.log(`Discovery enrichment: ${enrichedCandidates.length} symbols with tick/metric data.`);

        const symbolsToTrack = enrichedCandidates.map(c => c.symbol);
        this.orderBookManager.updateSubscriptions(symbolsToTrack);

        await this.sleep(2000, signal);
        this.assertNotAborted(signal);

        const candidatesWithBooks: EnrichedMarketData[] = [];

        for (let i = 0; i < enrichedCandidates.length; i += batchSize) {
            this.assertNotAborted(signal);
            const batch = enrichedCandidates.slice(i, i + batchSize);
            await Promise.all(batch.map(async (candidate) => {
                this.assertNotAborted(signal);
                try {
                    const bookMetrics = await this.getBookMetricsWithFallback(
                        candidate.symbol,
                        screenerCfg.depthBandsPct
                    );
                    candidatesWithBooks.push({ ...candidate, bookMetrics });
                } catch (e) {
                    if (this.isAbortError(e)) throw e;
                    console.error(`Failed to get L2 metrics for ${candidate.symbol}`, e);
                    candidatesWithBooks.push(candidate);
                }
            }));
        }
        this.assertNotAborted(signal);

        const deduped = this.discoverAndRank(candidatesWithBooks, heldSymbols, screenerCfg, config);
        const executable = deduped.filter(symbol => symbol.execution.tradeable).length;

        console.log(`✅ Discovery completed in ${Date.now() - startTime}ms. Returning ${deduped.length} discovered symbols (${executable} execution-tradeable, topN=${screenerCfg.topN}).`);
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
        const heldSet = new Set(heldSymbols.map(normalizeBaseSymbol));
        return candidates.filter(d => {
            if (heldSet.has(normalizeBaseSymbol(d.symbol))) return true;
            return (d.volume24h ?? 0) >= config.minVolume24h;
        });
    }

    public filterByActivity(candidates: (EnrichedMarketData & { sentiment: any })[], heldSymbols: string[], config: ScreenerConfig): (EnrichedMarketData & { sentiment: any })[] {
        const heldSet = new Set(heldSymbols.map(normalizeBaseSymbol));
        return candidates.filter(c => {
            if (heldSet.has(normalizeBaseSymbol(c.symbol))) return true;
            // Note: Recent Volume check is done before creating candidate in getScreenedSymbols for efficiency,
            // but strictly speaking should be here. We assume candidates passed to this might need checking if we were testing pure logic.
            // But here we only check realized vol as that's what's available in 'metrics'.
            const realizedVol = c.metrics.realized_vol.m5;
            return realizedVol >= config.minRealizedVol;
        });
    }

    public filterByLiquidity(candidates: EnrichedMarketData[], heldSymbols: string[], config: ScreenerConfig): EnrichedMarketData[] {
        const heldSet = new Set(heldSymbols.map(normalizeBaseSymbol));
        return candidates.filter(c => {
            if (heldSet.has(normalizeBaseSymbol(c.symbol))) return true;

            if (c.bookMetrics.spread_bps > config.maxSpreadBps) return false;

            const minSideDepth = Math.min(c.bookMetrics.depth_usd.bid_1pct, c.bookMetrics.depth_usd.ask_1pct);
            if (minSideDepth < config.minDepthUsd) return false;

            if (config.maxCostBps) {
                const estimatedCost = this.computeScreenerCostBps(c, DEFAULT_AGENT_CONFIG);
                if (estimatedCost > config.maxCostBps) return false;
            }

            return true;
        });
    }

    public scoreAndRank(
        candidates: EnrichedMarketData[],
        heldSymbols: string[],
        config: ScreenerConfig,
        agentConfig: AgentConfig = DEFAULT_AGENT_CONFIG
    ): ScreenedSymbol[] {
        const scored = this.scoreCandidates(candidates, heldSymbols, config, agentConfig);
        return this.limitAndDedupe(scored, heldSymbols, config.topN);
    }

    public discoverAndRank(
        candidates: EnrichedMarketData[],
        heldSymbols: string[],
        config: ScreenerConfig,
        agentConfig: AgentConfig = DEFAULT_AGENT_CONFIG
    ): ScreenedSymbol[] {
        const scored = this.scoreCandidates(candidates, heldSymbols, config, agentConfig);
        const bySymbol = new Map(scored.map(candidate => [candidate.symbol, candidate]));
        const reasonsBySymbol = new Map<string, Set<DiscoveryReason>>();

        const addReason = (candidate: ScreenedSymbol | undefined, reason: DiscoveryReason) => {
            if (!candidate) return;
            const bucket = reasonsBySymbol.get(candidate.symbol) ?? new Set<DiscoveryReason>();
            bucket.add(reason);
            reasonsBySymbol.set(candidate.symbol, bucket);
        };

        const includeBlocked = config.includeExecutionBlockedForDiagnostics !== false;
        const allowedForDiagnostics = (candidate: ScreenedSymbol) => includeBlocked || candidate.execution.tradeable;
        const qualityTop = scored
            .filter(candidate => candidate.execution.tradeable)
            .slice(0, config.topN);
        qualityTop.forEach(candidate => addReason(candidate, "QUALITY_TOP"));

        const hotMoverTopN = config.hotMoverTopN ?? Math.min(12, config.discoveryMaxSymbols ?? config.topN);
        const hotMoverMinAbsMoveBps = config.hotMoverMinAbsMoveBps ?? 150;
        scored
            .filter(candidate => allowedForDiagnostics(candidate))
            .filter(candidate => (candidate.discoveryMetrics.maxAbsMoveBps ?? 0) >= hotMoverMinAbsMoveBps)
            .sort((a, b) => (b.discoveryMetrics.maxAbsMoveBps ?? 0) - (a.discoveryMetrics.maxAbsMoveBps ?? 0))
            .slice(0, hotMoverTopN)
            .forEach(candidate => addReason(candidate, "HOT_MOVER"));

        const volumeSpikeTopN = config.volumeSpikeTopN ?? Math.min(10, config.discoveryMaxSymbols ?? config.topN);
        scored
            .filter(candidate => allowedForDiagnostics(candidate))
            .filter(candidate => (candidate.discoveryMetrics.relativeVolumeRatio ?? 0) > 1)
            .sort((a, b) =>
                ((b.discoveryMetrics.relativeVolumeRatio ?? 0) - (a.discoveryMetrics.relativeVolumeRatio ?? 0)) ||
                ((b.discoveryMetrics.recentQuoteVolume ?? 0) - (a.discoveryMetrics.recentQuoteVolume ?? 0))
            )
            .slice(0, volumeSpikeTopN)
            .forEach(candidate => addReason(candidate, "VOLUME_SPIKE"));

        const rangeExpansionTopN = config.rangeExpansionTopN ?? Math.min(10, config.discoveryMaxSymbols ?? config.topN);
        scored
            .filter(candidate => allowedForDiagnostics(candidate))
            .filter(candidate => (candidate.discoveryMetrics.rangeExpansionRatio ?? 0) > 1)
            .sort((a, b) => (b.discoveryMetrics.rangeExpansionRatio ?? 0) - (a.discoveryMetrics.rangeExpansionRatio ?? 0))
            .slice(0, rangeExpansionTopN)
            .forEach(candidate => addReason(candidate, "RANGE_EXPANSION"));

        const held = new Set(heldSymbols.map(normalizeBaseSymbol));
        for (const candidate of scored) {
            if (held.has(normalizeBaseSymbol(candidate.symbol))) addReason(candidate, "HELD_POSITION");
        }

        const forceIncluded = new Set((config.forceIncludeSymbols ?? []).map(normalizeBaseSymbol));
        for (const symbol of forceIncluded) {
            addReason(bySymbol.get(symbol) ?? bySymbol.get(stripPerp(symbol)), "FORCE_INCLUDED");
        }
        for (const candidate of scored) {
            if (forceIncluded.has(normalizeBaseSymbol(candidate.symbol))) addReason(candidate, "FORCE_INCLUDED");
        }

        const discovered = scored
            .filter(candidate => reasonsBySymbol.has(candidate.symbol))
            .map(candidate => ({
                ...candidate,
                discoveryReasons: Array.from(reasonsBySymbol.get(candidate.symbol) ?? [])
            }))
            .sort(compareDiscoveredSymbols);

        return this.capDiscovery(discovered, config);
    }

    private scoreCandidates(
        candidates: EnrichedMarketData[],
        heldSymbols: string[],
        config: ScreenerConfig,
        agentConfig: AgentConfig
    ): ScreenedSymbol[] {
        const weights = config.quality_weights;

        const scored: ScreenedSymbol[] = [];

        for (const candidate of candidates) {
            const volScore = config.layer4Enabled ? weights.vol_score * Math.abs(candidate.metrics.vol_zscores.vol_5m_vs_1h) : 0;
            const moveScore = config.layer4Enabled ? weights.move_score * Math.abs(candidate.metrics.vol_zscores.ret_5m_vs_1h) : 0;

            const s5 = Math.sign(candidate.metrics.returns.m5);
            const s15 = Math.sign(candidate.metrics.returns.m15);
            const s60 = Math.sign(candidate.metrics.returns.h1);
            const trendAlign = config.layer4Enabled && (s5 === s15 && s15 === s60 && s5 !== 0) ? weights.trend_align : 0;

            const spreadPenalty = config.layer4Enabled ? weights.spread_penalty * (candidate.bookMetrics.spread_bps / 5) : 0;

            const minDepth = Math.min(candidate.bookMetrics.depth_usd.bid_1pct, candidate.bookMetrics.depth_usd.ask_1pct);
            const illiquidityPenalty = config.layer4Enabled ? weights.illiquidity_penalty * (config.minDepthUsd / (minDepth + 1)) : 0;
            const expectedMoveBps = 10000 * Math.max(Math.abs(candidate.metrics.returns.m15), Math.abs(candidate.metrics.returns.h1));
            const estimatedCostBps = this.computeScreenerCostBps(candidate, agentConfig);
            const edgeToCost = estimatedCostBps > 0 ? Math.max(0, (expectedMoveBps - estimatedCostBps) / estimatedCostBps) : 0;
            const costToEdgePenalty = config.layer4Enabled ? (weights.cost_to_edge_penalty ?? 0) * (1 / Math.max(edgeToCost, 0.1)) : 0;

            const totalScore = volScore + moveScore + trendAlign - spreadPenalty - illiquidityPenalty - costToEdgePenalty;
            const qualityScore = Number.isFinite(totalScore) ? totalScore : 0;

            scored.push({
                ...candidate,
                score: qualityScore,
                qualityScore,
                sentiment: candidate.sentiment,
                discoveryReasons: [],
                discoveryMetrics: this.buildDiscoveryMetrics(candidate),
                execution: this.buildExecutionDiagnostics(candidate, heldSymbols, config, agentConfig)
            });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored;
    }

    private buildDiscoveryMetrics(candidate: Pick<EnrichedMarketData, "metrics" | "recentQuoteVolume">): DiscoveryMetrics {
        const absMoveBps_m15 = toAbsBps(candidate.metrics.returns.m15);
        const absMoveBps_h1 = toAbsBps(candidate.metrics.returns.h1);
        const absMoveBps_h4 = toAbsBps(candidate.metrics.returns.h4);
        const moves = [absMoveBps_m15, absMoveBps_h1, absMoveBps_h4].filter((value): value is number => value !== null);
        const realizedVolM5 = finiteOrNull(candidate.metrics.realized_vol?.m5);
        const realizedVolH1 = finiteOrNull(candidate.metrics.realized_vol?.h1);
        const volRatio5mVs1h = finiteOrNull(candidate.metrics.vol_zscores?.vol_5m_vs_1h);
        const volExpansion = realizedVolM5 !== null && realizedVolH1 !== null && realizedVolH1 > 0
            ? realizedVolM5 / realizedVolH1
            : null;

        return {
            absMoveBps_m15,
            absMoveBps_h1,
            absMoveBps_h4,
            maxAbsMoveBps: moves.length ? Math.max(...moves) : null,
            recentQuoteVolume: finiteOrNull(candidate.recentQuoteVolume),
            relativeVolumeRatio: volRatio5mVs1h,
            rangeExpansionRatio: finiteOrNull(Math.max(volRatio5mVs1h ?? 0, volExpansion ?? 0)),
            realizedVolM5,
            volRatio5mVs1h,
            retSigma5mVs1h: finiteOrNull(candidate.metrics.vol_zscores?.ret_5m_vs_1h)
        };
    }

    private buildExecutionDiagnostics(
        candidate: EnrichedMarketData,
        _heldSymbols: string[],
        config: ScreenerConfig,
        agentConfig: AgentConfig
    ): ExecutionDiagnostics {
        const blockReasons: ExecutionBlockReason[] = [];
        const spreadBps = finiteOrNull(candidate.bookMetrics.spread_bps);
        const depthUsd = finiteOrNull(Math.min(candidate.bookMetrics.depth_usd.bid_1pct, candidate.bookMetrics.depth_usd.ask_1pct));
        const costBps = finiteOrNull(this.computeScreenerCostBps(candidate, agentConfig));
        const realizedVolM5 = finiteOrNull(candidate.metrics.realized_vol?.m5);
        const recentQuoteVolume = finiteOrNull(candidate.recentQuoteVolume);

        if (config.layer1Enabled && (candidate.volume24h ?? 0) < config.minVolume24h) {
            blockReasons.push("VOLUME24H_GATE");
        }
        if (config.layer3Enabled && recentQuoteVolume !== null && recentQuoteVolume < config.minRecentVolume) {
            blockReasons.push("RECENT_VOLUME_GATE");
        }
        if (config.layer3Enabled && (realizedVolM5 ?? 0) < config.minRealizedVol) {
            blockReasons.push("REALIZED_VOL_GATE");
        }
        if (config.layer2Enabled && (spreadBps ?? Infinity) > config.maxSpreadBps) {
            blockReasons.push("SPREAD_GATE");
        }
        if (config.layer2Enabled && (depthUsd ?? 0) < config.minDepthUsd) {
            blockReasons.push("DEPTH_GATE");
        }
        if (config.layer2Enabled && config.maxCostBps !== undefined && (costBps ?? Infinity) > config.maxCostBps) {
            blockReasons.push("COST_GATE");
        }

        return {
            tradeable: blockReasons.length === 0,
            blockReasons,
            spreadBps,
            depthUsd,
            costBps
        };
    }

    private computeScreenerCostBps(candidate: EnrichedMarketData, agentConfig: AgentConfig): number {
        const profile = candidate.isTestnet ? agentConfig.network_profiles.testnet : agentConfig.network_profiles.mainnet;
        return computeExecutionCostBps({
            spreadBps: candidate.bookMetrics.spread_bps,
            feesBps: profile.fees_bps,
            slippageModel: profile.slippage_model
        }).totalCostBps;
    }

    private capDiscovery(discovered: ScreenedSymbol[], config: ScreenerConfig): ScreenedSymbol[] {
        const max = config.discoveryMaxSymbols ?? config.topN;
        if (discovered.length <= max) return discovered;

        const protectedSymbols = new Set(
            discovered
                .filter(candidate =>
                    candidate.discoveryReasons.includes("HELD_POSITION") ||
                    candidate.discoveryReasons.includes("FORCE_INCLUDED") ||
                    (config.includeHotMoversEvenIfNotTopN !== false && candidate.discoveryReasons.includes("HOT_MOVER"))
                )
                .map(candidate => candidate.symbol)
        );
        const selected = discovered.filter(candidate => protectedSymbols.has(candidate.symbol));
        for (const candidate of discovered) {
            if (selected.length >= max) break;
            if (protectedSymbols.has(candidate.symbol)) continue;
            selected.push(candidate);
        }
        return selected;
    }

    private limitAndDedupe(scored: ScreenedSymbol[], heldSymbols: string[], topN: number): ScreenedSymbol[] {
        const topCandidates = scored.slice(0, topN);
        const heldSet = new Set(heldSymbols.map(normalizeBaseSymbol));

        for (const c of scored) {
            if (heldSet.has(normalizeBaseSymbol(c.symbol)) && !topCandidates.includes(c)) {
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

function compareDiscoveredSymbols(a: ScreenedSymbol, b: ScreenedSymbol): number {
    return discoveryPriority(b) - discoveryPriority(a) ||
        Number(b.execution.tradeable) - Number(a.execution.tradeable) ||
        (b.discoveryMetrics.maxAbsMoveBps ?? 0) - (a.discoveryMetrics.maxAbsMoveBps ?? 0) ||
        b.qualityScore - a.qualityScore ||
        a.symbol.localeCompare(b.symbol);
}

function discoveryPriority(candidate: ScreenedSymbol): number {
    let priority = 0;
    if (candidate.discoveryReasons.includes("QUALITY_TOP")) priority = Math.max(priority, 10);
    if (candidate.discoveryReasons.includes("RANGE_EXPANSION")) priority = Math.max(priority, 20);
    if (candidate.discoveryReasons.includes("VOLUME_SPIKE")) priority = Math.max(priority, 30);
    if (candidate.discoveryReasons.includes("HOT_MOVER")) priority = Math.max(priority, 40);
    if (candidate.discoveryReasons.includes("HELD_POSITION")) priority = Math.max(priority, 50);
    if (candidate.discoveryReasons.includes("FORCE_INCLUDED")) priority = Math.max(priority, 60);
    return priority;
}

function toAbsBps(value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.abs(value) * 10000;
}

function finiteOrNull(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeBaseSymbol(symbol: string): string {
    return stripPerp(symbol).toUpperCase();
}

function stripPerp(symbol: string): string {
    return symbol.replace(/-PERP$/i, "");
}
