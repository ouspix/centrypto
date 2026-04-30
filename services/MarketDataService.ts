import { getMetaAndAssetCtxs } from "@/lib/hyperliquid-info";
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

    // Legacy methods removed. Use MarketCollectorService and MarketAnalysisService directly.
}
