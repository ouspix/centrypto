import { ethers } from 'ethers';

// Types
type MarketSnapshot = {
    coin: string;
    mid: number;
    bids: [number, number][];
    asks: [number, number][];
};

type TradeDecision = {
    action: "LONG" | "SHORT" | "HOLD";
    confidence: number;
    reasoning: string;
};

export class OrchestratorService {
    private ollamaUrl: string;
    private isRunning: boolean = false;

    constructor() {
        this.ollamaUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log("Orchestrator Service Started");

        // In a real service, this would be a loop or event-driven
        // For this demo, we'll expose a method to trigger analysis manually or via cron
    }

    public async analyzeMarket(snapshot: MarketSnapshot): Promise<TradeDecision> {
        try {
            const prompt = `
        You are a crypto scalping bot. Analyze the following order book pressure for ${snapshot.coin}.
        Current Price: ${snapshot.mid}
        Top 5 Bids: ${JSON.stringify(snapshot.bids.slice(0, 5))}
        Top 5 Asks: ${JSON.stringify(snapshot.asks.slice(0, 5))}
        
        Decide LONG, SHORT, or HOLD. 
        Provide confidence score (0-100) and brief reasoning.
        Format: JSON { "action": "...", "confidence": ..., "reasoning": "..." }
      `;

            // Call Ollama
            const response = await fetch(`${this.ollamaUrl}/api/generate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "deepseek-r1:14b",
                    prompt: prompt,
                    stream: false,
                    format: "json"
                })
            });

            if (!response.ok) {
                throw new Error(`Ollama API Error: ${response.statusText}`);
            }

            const data = await response.json();
            const decision: TradeDecision = JSON.parse(data.response);

            console.log(`[Orchestrator] Decision: ${decision.action} (${decision.confidence}%) - ${decision.reasoning}`);

            // Execute Trade if High Confidence
            if (decision.confidence > 80 && decision.action !== "HOLD") {
                await this.executeTrade(decision, snapshot);
            }

            return decision;

        } catch (error) {
            console.error("Orchestrator Analysis Failed:", error);
            return { action: "HOLD", confidence: 0, reasoning: "Error during analysis" };
        }
    }

    private async executeTrade(decision: TradeDecision, snapshot: MarketSnapshot) {
        console.log("Executing High Confidence Trade...");

        // Call our own API route to execute safely
        // In a real backend service, we might call the exchange directly or via an internal method
        // Here we simulate a fetch to our Next.js API route

        try {
            const tradePayload = {
                asset: 0, // Assuming BTC is 0 for this demo
                isBuy: decision.action === "LONG",
                price: snapshot.mid, // Market/Limit at mid
                size: 0.001, // Fixed size for demo
                leverage: 5
            };

            // Note: In a server-side context, we might need the full URL
            const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
            await fetch(`${baseUrl}/api/trade/execute`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(tradePayload)
            });

            console.log("Trade Execution Request Sent");

        } catch (error) {
            console.error("Trade Execution Failed:", error);
        }
    }
}
