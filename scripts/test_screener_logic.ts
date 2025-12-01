
import { ScreenerService, EnrichedMarketData } from "../services/ScreenerService";
import { DEFAULT_SCREENER_CONFIG, ScreenerConfig } from "../lib/screener-config";

// Mock Data Factory
function createMockCandidate(symbol: string, overrides: Partial<EnrichedMarketData> = {}): EnrichedMarketData {
    return {
        symbol,
        price: 100,
        volume24h: 10_000_000,
        funding: 0.0001,
        openInterest: 1_000_000,
        metrics: {
            realized_vol: { m1: 0.0005, m5: 0.001, m15: 0.002, h1: 0.005, h4: 0.01 },
            vol_zscores: { vol_5m_vs_1h: 1.0, ret_5m_vs_1h: 1.0 },
            returns: { m5: 0.01, m15: 0.02, h1: 0.05 },
            rsi: { m5: 50, m15: 55, h1: 60 }
        },
        bookMetrics: {
            spread_bps: 2,
            depth_usd: { bid_1pct: 100_000, ask_1pct: 100_000 },
            imbalance: 0,
            book_pressure: 0,
            cost_bps: 5,
            depth_bands_usd: { bid: {}, ask: {} }
        },
        sentiment: { score: 0 },
        isTestnet: false,
        ...overrides
    } as EnrichedMarketData;
}

async function runTests() {
    const service = new ScreenerService();
    const config = { ...DEFAULT_SCREENER_CONFIG };

    console.log("🧪 Starting Screener Logic Tests...");

    // Test 1: Universe Filter
    console.log("\nTest 1: Universe Filter (minVolume24h)");
    const c1 = createMockCandidate("BTC", { volume24h: 500_000 }); // Low vol
    const c2 = createMockCandidate("ETH", { volume24h: 5_000_000 }); // High vol
    config.minVolume24h = 1_000_000;
    const uResult = service.filterByUniverse([c1, c2], [], config);
    if (uResult.length === 1 && uResult[0].symbol === "ETH") {
        console.log("✅ PASS: Filtered low volume symbol");
    } else {
        console.error("❌ FAIL: Universe filter failed", uResult.map(c => c.symbol));
    }

    // Test 2: Activity Filter
    console.log("\nTest 2: Activity Filter (minRealizedVol)");
    const c3 = createMockCandidate("SOL", { metrics: { ...createMockCandidate("SOL").metrics, realized_vol: { m1: 0, m5: 0.0001, m15: 0, h1: 0, h4: 0 } } }); // Low vol
    const c4 = createMockCandidate("AVAX", { metrics: { ...createMockCandidate("AVAX").metrics, realized_vol: { m1: 0, m5: 0.002, m15: 0, h1: 0, h4: 0 } } }); // High vol
    config.minRealizedVol = 0.0005;
    const aResult = service.filterByActivity([c3, c4], [], config);
    if (aResult.length === 1 && aResult[0].symbol === "AVAX") {
        console.log("✅ PASS: Filtered low realized vol symbol");
    } else {
        console.error("❌ FAIL: Activity filter failed", aResult.map(c => c.symbol));
    }

    // Test 3: Liquidity Filter
    console.log("\nTest 3: Liquidity Filter (maxSpreadBps, minDepthUsd)");
    const c5 = createMockCandidate("DOGE", { bookMetrics: { ...createMockCandidate("DOGE").bookMetrics, spread_bps: 100 } }); // High spread
    const c6 = createMockCandidate("SHIB", { bookMetrics: { ...createMockCandidate("SHIB").bookMetrics, depth_usd: { bid_1pct: 1000, ask_1pct: 1000 } } }); // Low depth
    const c7 = createMockCandidate("MATIC", { bookMetrics: { ...createMockCandidate("MATIC").bookMetrics, spread_bps: 10, depth_usd: { bid_1pct: 50000, ask_1pct: 50000 } } }); // Good
    config.maxSpreadBps = 50;
    config.minDepthUsd = 10000;
    const lResult = service.filterByLiquidity([c5, c6, c7], [], config);
    if (lResult.length === 1 && lResult[0].symbol === "MATIC") {
        console.log("✅ PASS: Filtered illiquid symbols");
    } else {
        console.error("❌ FAIL: Liquidity filter failed", lResult.map(c => c.symbol));
    }

    // Test 4: Quality Scoring
    console.log("\nTest 4: Quality Scoring");
    const c8 = createMockCandidate("A", { metrics: { ...createMockCandidate("A").metrics, vol_zscores: { vol_5m_vs_1h: 2.0, ret_5m_vs_1h: 0 } } }); // High Vol Score
    const c9 = createMockCandidate("B", { metrics: { ...createMockCandidate("B").metrics, vol_zscores: { vol_5m_vs_1h: 0.5, ret_5m_vs_1h: 0 } } }); // Low Vol Score
    config.quality_weights = { vol_score: 1.0, move_score: 0, trend_align: 0, spread_penalty: 0, illiquidity_penalty: 0 };
    config.topN = 2;
    const sResult = service.scoreAndRank([c8, c9], [], config);
    if (sResult[0].symbol === "A" && sResult[0].score > sResult[1].score) {
        console.log("✅ PASS: Scored and ranked correctly");
    } else {
        console.error("❌ FAIL: Scoring failed", sResult.map(c => `${c.symbol}:${c.score}`));
    }

    console.log("\nTests Completed.");
    process.exit(0);
}

runTests().catch(console.error);
