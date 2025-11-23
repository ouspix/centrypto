
import { OrchestratorService } from "./services/OrchestratorService";
import { MarketAnalysisService } from "./services/MarketAnalysisService";

async function testPromptGeneration() {
    console.log("🧪 Testing AI Advisor Prompt Generation...");

    const orchestrator = new OrchestratorService();
    const marketAnalysis = new MarketAnalysisService();

    // Mock data or use real if available (assuming dev environment has DB access)
    // For this test, we'll rely on the service's internal logic which might fetch from DB/API.
    // If that fails, we might need to mock dependencies, but let's try a live run first if possible
    // or just check the prompt construction if we can access it.

    // Since analyzeMarket calls buildSnapshot which calls getMetricsForSymbol,
    // running analyzeMarket should trigger our new code.

    try {
        console.log("running analyzeMarket...");
        const result = await orchestrator.analyzeMarket(
            "MOCK_USER", // Use Mock User to inject positions
            false, // Auto-trading off
            "deepseek-r1:14b", // Model
            true, // Testnet
            {} // Config
        );

        console.log("✅ analyzeMarket returned successfully.");

        // 1. Schema Verification
        const snapshot = result.snapshot;
        const positions = snapshot.account.current_positions;

        if (positions.length > 0) {
            if (typeof positions[0].fraction_of_equity === 'number') {
                console.log("✅ Schema Check: fraction_of_equity exists.");
            } else {
                console.error("❌ Schema Check: fraction_of_equity MISSING.");
            }
        }

        const marketKeys = Object.keys(snapshot.markets);
        if (marketKeys.length > 0) {
            const firstMarket = snapshot.markets[marketKeys[0]];
            if (firstMarket.orderbook && typeof firstMarket.orderbook.book_pressure === 'number') {
                const bp = firstMarket.orderbook.book_pressure;
                if (bp >= -1 && bp <= 1) {
                    console.log(`✅ Schema Check: book_pressure exists and valid (${bp}).`);
                } else {
                    console.error(`❌ Schema Check: book_pressure out of range (${bp}).`);
                }
            } else {
                console.error("❌ Schema Check: book_pressure MISSING.");
            }
        }

        // 2. Coverage Verification
        const decisionSymbols = result.decisions.map(d => d.symbol);
        const missingCoverage = positions.filter(p => !decisionSymbols.includes(p.symbol));

        if (missingCoverage.length === 0) {
            console.log("✅ Logic Check: All current positions covered.");
        } else {
            console.error("❌ Logic Check: Missing decisions for:", missingCoverage.map(p => p.symbol));
        }

        console.log("📝 Prompt Preview (System Prompt section):");
        const systemPromptEnd = result.prompt.indexOf("MARKET SNAPSHOT");
        console.log(result.prompt.substring(0, systemPromptEnd));

        console.log("📊 Decisions:");
        console.log(JSON.stringify(result.decisions, null, 2));

        if (result.rawOutput) {
            console.log("📦 Raw Output found.");
        }

    } catch (error) {
        console.error("❌ Test Failed:", error);
    }
}

testPromptGeneration();
