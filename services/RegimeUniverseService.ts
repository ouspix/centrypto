import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { MarketEntry } from "@/types/snapshot";
import { MarketAnalysisService } from "./MarketAnalysisService";

const REGIME_DEPTH_BANDS = ["0.10", "1.00"];

const REGIME_UNIVERSE = {
    majors: {
        symbols: ["BTC-PERP", "ETH-PERP"],
        weights: {
            "BTC-PERP": 3.0,
            "ETH-PERP": 2.5
        } as Record<string, number>
    },
    core: {
        symbols: ["SOL-PERP", "BNB-PERP", "XRP-PERP", "DOGE-PERP"],
        weights: {
            "SOL-PERP": 1.5,
            "BNB-PERP": 1.0,
            "XRP-PERP": 1.0,
            "DOGE-PERP": 1.0
        } as Record<string, number>
    },
    liquidAlts: {
        maxSymbols: 40,
        weight: 0.5,
        filters: {
            minDepth10BpsUsd: 25_000,
            minVolume24hUsd: 2_000_000,
            maxSpreadBps: 20
        }
    },
    exclusions: {
        minDepth10BpsUsd: 15_000,
        maxSpreadBps: 25,
        maxVolRatio5mVs1h: 8
    }
};

type RecentTick = Awaited<ReturnType<typeof marketDbMain.marketTick.findMany>>[number];

type RegimeCandidate = {
    symbol: string;
    volume24h: number;
    markPrice: number;
    fundingRate: number;
    openInterest: number;
    group: "major" | "core" | "alt";
    weight: number;
};

export class RegimeUniverseService {
    constructor(private readonly marketAnalysisService = new MarketAnalysisService()) {}

    public async buildRegimeMarkets(isTestnet: boolean): Promise<Record<string, MarketEntry>> {
        const ticks = await this.getLatestTicks(isTestnet);
        const candidates = this.selectCandidates(ticks);
        const markets: Record<string, MarketEntry> = {};

        for (const candidate of candidates) {
            const market = await this.buildMarket(candidate, isTestnet);
            if (!market) continue;
            markets[market.symbol] = market;
        }

        return markets;
    }

    private async getLatestTicks(isTestnet: boolean): Promise<RecentTick[]> {
        const db = isTestnet ? marketDbTest : marketDbMain;
        const latestTick = await db.marketTick.findFirst({ orderBy: { ts: "desc" } });
        if (!latestTick) return [];

        const cutoff = new Date(latestTick.ts.getTime() - 5 * 60 * 1000);
        const ticks = await db.marketTick.findMany({
            where: {
                ts: {
                    gte: cutoff,
                    lte: latestTick.ts
                }
            },
            orderBy: { ts: "desc" }
        });

        const latestBySymbol = new Map<string, RecentTick>();
        for (const tick of ticks) {
            if (!latestBySymbol.has(tick.symbol)) {
                latestBySymbol.set(tick.symbol, tick);
            }
        }

        return Array.from(latestBySymbol.values());
    }

    private selectCandidates(ticks: RecentTick[]): RegimeCandidate[] {
        const byPerpSymbol = new Map(ticks.map(tick => [this.toPerpSymbol(tick.symbol), tick]));
        const candidates: RegimeCandidate[] = [];
        const included = new Set<string>();

        for (const symbol of REGIME_UNIVERSE.majors.symbols) {
            const candidate = this.fromTick(byPerpSymbol.get(symbol), "major", REGIME_UNIVERSE.majors.weights[symbol]);
            if (candidate) {
                candidates.push(candidate);
                included.add(symbol);
            }
        }

        for (const symbol of REGIME_UNIVERSE.core.symbols) {
            const candidate = this.fromTick(byPerpSymbol.get(symbol), "core", REGIME_UNIVERSE.core.weights[symbol]);
            if (candidate) {
                candidates.push(candidate);
                included.add(symbol);
            }
        }

        const altCandidates = ticks
            .map(tick => this.fromTick(tick, "alt", REGIME_UNIVERSE.liquidAlts.weight))
            .filter((candidate): candidate is RegimeCandidate => {
                if (!candidate) return false;
                return !included.has(candidate.symbol) &&
                    candidate.volume24h >= REGIME_UNIVERSE.liquidAlts.filters.minVolume24hUsd;
            })
            .sort((a, b) => b.volume24h - a.volume24h)
            .slice(0, REGIME_UNIVERSE.liquidAlts.maxSymbols);

        return [...candidates, ...altCandidates];
    }

    private fromTick(
        tick: RecentTick | undefined,
        group: RegimeCandidate["group"],
        weight: number
    ): RegimeCandidate | null {
        if (!tick || !Number.isFinite(tick.markPrice) || tick.markPrice <= 0) return null;

        return {
            symbol: this.toPerpSymbol(tick.symbol),
            volume24h: tick.volume24h ?? 0,
            markPrice: tick.markPrice,
            fundingRate: tick.fundingRate ?? 0,
            openInterest: tick.openInterest ?? 0,
            group,
            weight
        };
    }

    private async buildMarket(candidate: RegimeCandidate, isTestnet: boolean): Promise<MarketEntry | null> {
        const baseSymbol = this.toBaseSymbol(candidate.symbol);
        const [metrics, bookMetrics] = await Promise.all([
            this.marketAnalysisService.getMetricsForSymbol(baseSymbol, isTestnet, false),
            this.marketAnalysisService.getOrderBookMetrics(baseSymbol, isTestnet, true, REGIME_DEPTH_BANDS)
        ]);

        const depth10BpsUsd = this.minDepthForBand(bookMetrics.depth_bands_usd, "0.10");
        const spreadBps = bookMetrics.spread_bps;
        const volRatio = metrics.vol_zscores.vol_5m_vs_1h;

        if (!this.hasUsableData(metrics.returns.m15, metrics.returns.h1, volRatio)) return null;
        if (volRatio > REGIME_UNIVERSE.exclusions.maxVolRatio5mVs1h) return null;
        if (spreadBps > REGIME_UNIVERSE.exclusions.maxSpreadBps) return null;
        if (depth10BpsUsd < REGIME_UNIVERSE.exclusions.minDepth10BpsUsd) return null;

        if (candidate.group === "alt") {
            if (candidate.volume24h < REGIME_UNIVERSE.liquidAlts.filters.minVolume24hUsd) return null;
            if (spreadBps > REGIME_UNIVERSE.liquidAlts.filters.maxSpreadBps) return null;
            if (depth10BpsUsd < REGIME_UNIVERSE.liquidAlts.filters.minDepth10BpsUsd) return null;
        }

        const bidDepth = bookMetrics.depth_bands_usd?.bid["1.00"] ?? bookMetrics.depth_usd.bid_1pct;
        const askDepth = bookMetrics.depth_bands_usd?.ask["1.00"] ?? bookMetrics.depth_usd.ask_1pct;

        return {
            symbol: candidate.symbol,
            price: candidate.markPrice,
            spread_bps: spreadBps,
            orderbook: {
                best_bid: bookMetrics.best_bid || 0,
                best_ask: bookMetrics.best_ask || 0,
                mid: bookMetrics.mid || candidate.markPrice,
                book_pressure: bookMetrics.book_pressure,
                bid_liquidity_usd: bidDepth,
                ask_liquidity_usd: askDepth,
                depth_bands_usd: bookMetrics.depth_bands_usd
            },
            returns: {
                m5: metrics.returns.m5,
                m15: metrics.returns.m15,
                h1: metrics.returns.h1,
                h4: metrics.returns.h4
            },
            realized_vol: metrics.realized_vol,
            volume_zscores: metrics.volume_zscores,
            atr_pct: metrics.atr_pct,
            vol_zscores: metrics.vol_zscores,
            funding: {
                current_8h: candidate.fundingRate
            },
            open_interest: {
                current: candidate.openInterest
            },
            sentiment: {
                score: 0,
                mentionsVsBaseline: 0,
                disagreement: 0,
                change2h: 0
            },
            regime_tags: metrics.regime_tags,
            high_low: metrics.high_low,
            bbands: metrics.bbands,
            volume24h: candidate.volume24h,
            regime: {
                group: candidate.group,
                weight: candidate.weight
            },
            data_source: "regime_universe"
        };
    }

    private hasUsableData(...values: number[]): boolean {
        return values.every(value => Number.isFinite(value));
    }

    private minDepthForBand(
        depthBands: { bid: Record<string, number>; ask: Record<string, number> } | undefined,
        band: string
    ): number {
        const bid = depthBands?.bid?.[band] ?? 0;
        const ask = depthBands?.ask?.[band] ?? 0;
        return Math.min(bid, ask);
    }

    private toPerpSymbol(symbol: string): string {
        return symbol.endsWith("-PERP") ? symbol : `${symbol}-PERP`;
    }

    private toBaseSymbol(symbol: string): string {
        return symbol.replace(/-PERP$/, "");
    }
}
