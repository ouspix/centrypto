import { getMetaAndAssetCtxs } from "@/lib/hyperliquid";
import { MarketAnalysisService, MarketMetrics, OrderBookMetrics } from "./MarketAnalysisService";
import { SentimentService, SentimentSnapshot } from "./SentimentService";
import { prisma } from "@/lib/db";

export type EnrichedMarketData = {
    symbol: string;
    price: number;
    volume24h: number;
    funding: number;
    openInterest: number;
    metrics: MarketMetrics;
    bookMetrics: OrderBookMetrics;
    sentiment: SentimentSnapshot;
    isTestnet: boolean; // Track which network this data is from
};

export class MarketDataService {
    private marketAnalysis: MarketAnalysisService;
    private sentimentService: SentimentService;

    constructor() {
        this.marketAnalysis = new MarketAnalysisService();
        this.sentimentService = new SentimentService();
    }

    public async collectAllMarketData(isTestnet: boolean): Promise<EnrichedMarketData[]> {
        console.log("📊 Collecting ALL Market Data...");
        const startTime = Date.now();

        // 1. Get Universe
        const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);
        if (!metaAndCtxs) return [];

        const { universe, assetCtxs } = metaAndCtxs;
        const results: EnrichedMarketData[] = [];

        // 2. Process all symbols (batching if needed, but sequential for safety first)
        // Limit to top 100 by volume to avoid hitting rate limits too hard if universe is huge
        // Or just process all if rate limits allow. Hyperliquid is fast.
        // Let's sort by volume first and take top 100 to be safe for now.

        const candidates = [];
        for (let i = 0; i < universe.length; i++) {
            const asset = universe[i];
            const ctx = assetCtxs[i];
            candidates.push({
                symbol: asset.name,
                price: parseFloat(ctx.markPx),
                volume24h: parseFloat(ctx.dayNtlVlm),
                funding: parseFloat(ctx.funding),
                openInterest: parseFloat(ctx.openInterest) * parseFloat(ctx.markPx)
            });
        }

        const topCandidates = candidates.sort((a, b) => b.volume24h - a.volume24h).slice(0, 120); // Top 120

        console.log(`Processing ${topCandidates.length} symbols...`);

        // Process in batches of 10 to avoid rate limits but speed up
        const batchSize = 10;
        for (let i = 0; i < topCandidates.length; i += batchSize) {
            const batch = topCandidates.slice(i, i + batchSize);
            await Promise.all(batch.map(async (candidate) => {
                try {
                    // Fetch Metrics, Book, and Sentiment in parallel
                    const [metrics, bookMetrics, sentiment] = await Promise.all([
                        this.marketAnalysis.getMetricsForSymbol(candidate.symbol, isTestnet, true),
                        this.marketAnalysis.getOrderBookMetrics(candidate.symbol, isTestnet, true),
                        this.sentimentService.getSentimentForCoin(candidate.symbol)
                    ]);

                    results.push({
                        ...candidate,
                        metrics,
                        bookMetrics,
                        sentiment,
                        isTestnet
                    });
                } catch (err) {
                    console.error(`Failed to collect data for ${candidate.symbol}`, err);
                }
            }));
            // Small delay between batches if needed? Hyperliquid is fast.
            // await new Promise(r => setTimeout(r, 100));
        }

        console.log(`✅ Collected data for ${results.length} symbols in ${Date.now() - startTime}ms`);
        return results;
    }

    public async saveSnapshot(data: EnrichedMarketData[]): Promise<void> {
        try {
            await prisma.marketStateSnapshot.create({
                data: {
                    data: JSON.stringify(data)
                }
            });
            console.log(`💾 Saved MarketStateSnapshot with ${data.length} records.`);
        } catch (error) {
            console.error("❌ Failed to save MarketStateSnapshot:", error);
        }
    }

    public async getLatestSnapshot(isTestnet: boolean): Promise<EnrichedMarketData[] | null> {
        try {
            const snapshot = await prisma.marketStateSnapshot.findFirst({
                orderBy: { createdAt: 'desc' }
            });

            if (!snapshot) return null;

            const allData = JSON.parse(snapshot.data) as EnrichedMarketData[];

            // Filter by network
            const networkData = allData.filter(d => d.isTestnet === isTestnet);

            if (networkData.length === 0) {
                console.warn(`⚠️ No data for ${isTestnet ? 'testnet' : 'mainnet'} in snapshot.`);
                return null;
            }

            return networkData;
        } catch (error) {
            console.error("❌ Failed to fetch MarketStateSnapshot:", error);
            return null;
        }
    }
}
