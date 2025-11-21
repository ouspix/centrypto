import { OrchestratorService } from '../services/OrchestratorService';
import assert from 'node:assert';

// Ensure environment variables are set
process.env.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

async function runTest() {
    console.log("Starting AI Advisor Test...");

    const orchestrator = new OrchestratorService();
    await orchestrator.start();

    // Scenario 1: Real Analysis (or Mocked if Ollama is down, but we assume it's up based on previous run)
    console.log("\n--- Scenario 1: Market Analysis ---");
    const snapshot = {
        coin: "BTC",
        mid: 95000,
        bids: [[94990, 1.5], [94980, 2.0]] as [number, number][],
        asks: [[95010, 1.0], [95020, 1.5]] as [number, number][],
        sentiment: 0.25,
        orderbookPressure: "Buy Pressure"
    };

    try {
        const decision = await orchestrator.analyzeMarket(snapshot);
        console.log("Decision:", decision);
        assert.ok(decision.action, "Decision should have an action");
        assert.ok(typeof decision.confidence === 'number', "Confidence should be a number");
        console.log("✅ Scenario 1 Passed");
    } catch (error) {
        console.error("❌ Scenario 1 Failed:", error);
    }

    // Scenario 2: Force High Confidence to test Trade Execution logic
    // We can't easily force Ollama to give >80% without mocking fetch, 
    // but we can test the executeTrade method if we could access it. 
    // Since it's private, we can't call it directly.
    // However, we can mock the global fetch to intercept the Ollama call and return a high confidence response.

    console.log("\n--- Scenario 2: High Confidence Trade Execution ---");

    const originalFetch = global.fetch;
    let tradeExecuted = false;

    // Mock fetch
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = input.toString();

        // Mock Ollama response
        if (urlStr.includes('/api/generate')) {
            return {
                ok: true,
                json: async () => ({
                    response: JSON.stringify({
                        action: "LONG",
                        confidence: 85,
                        reasoning: "Mocked high confidence for testing"
                    })
                })
            } as Response;
        }

        // Mock Trade Execution API
        if (urlStr.includes('/api/trade/execute')) {
            console.log("Intercepted Trade Execution Call to:", urlStr);
            tradeExecuted = true;
            return {
                ok: true,
                json: async () => ({ status: "success" })
            } as Response;
        }

        return originalFetch(input, init);
    };

    try {
        const decision = await orchestrator.analyzeMarket(snapshot);
        console.log("Mocked Decision:", decision);

        // Wait a bit for the async trade execution (it's awaited in analyzeMarket, so should be done)
        assert.strictEqual(decision.confidence, 85, "Confidence should be mocked to 85");
        assert.strictEqual(tradeExecuted, true, "Trade execution endpoint should have been called");
        console.log("✅ Scenario 2 Passed");

    } catch (error) {
        console.error("❌ Scenario 2 Failed:", error);
    } finally {
        global.fetch = originalFetch;
    }
}

runTest();
