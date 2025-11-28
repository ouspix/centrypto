
import { TradeDecision } from "@/lib/risk/RiskCheckModule";

// Mock Risk Assessment
const mockRiskAssessment = {
    approved: true,
    reason: "Approved",
    modifiedOrder: {
        symbol: "BTC-USD",
        side: "buy",
        sizeUsd: 100,
        clientTag: "TEST",
        stopLossPrice: 90000,
        takeProfitPrice: 110000
    }
};

// Mock placeOrder
async function mockPlaceOrder(symbol: string, delayMs: number = 100) {
    console.log(`[${Date.now()}] 🚀 Starting placeOrder for ${symbol}...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    console.log(`[${Date.now()}] ✅ Finished placeOrder for ${symbol}`);
    return { status: "ok", response: { data: { statuses: [{ oid: 123 }] } } };
}

async function runLoop() {
    const decisions: TradeDecision[] = [
        {
            action: "OPEN_POSITION",
            symbol: "BTC-USD",
            side: "long",
            target_side: "long",
            target_size_fraction_of_equity: 0.1,
            size_fraction_of_equity: 0.1,
            risk_plan: { stop_loss_pct: 0.01, take_profit_pct_primary: 0.02 },
            playbook: "momentum",
            confidence: 0.9,
            reason_code: "TEST",
            notes: "Test 1"
        },
        {
            action: "OPEN_POSITION",
            symbol: "ETH-USD",
            side: "long",
            target_side: "long",
            target_size_fraction_of_equity: 0.1,
            size_fraction_of_equity: 0.1,
            risk_plan: { stop_loss_pct: 0.01, take_profit_pct_primary: 0.02 },
            playbook: "momentum",
            confidence: 0.9,
            reason_code: "TEST",
            notes: "Test 2"
        }
    ];

    console.log("Starting Loop...");

    for (const decision of decisions) {
        console.log(`Processing ${decision.symbol}...`);

        // Mock Risk Check
        const riskAssessment = { ...mockRiskAssessment, modifiedOrder: { ...mockRiskAssessment.modifiedOrder, symbol: decision.symbol! } };

        if (riskAssessment.approved) {
            try {
                await mockPlaceOrder(decision.symbol!, 200); // 200ms delay
            } catch (e) {
                console.error("Error:", e);
            }
        }
    }

    console.log("Loop Finished.");
}

runLoop();
