import { SnapshotBuilder, StateSnapshot } from "./SnapshotBuilder";
import { RiskCheckModule, TradeDecision, RiskAssessment } from "@/lib/risk/RiskCheckModule";
import { ExecutionEngine } from "@/lib/hyperliquidExecution";
import { TradingLogger } from "@/lib/log/tradingLogger";

export class OrchestratorService {
    private ollamaUrl: string;
    private snapshotBuilder: SnapshotBuilder;
    private riskModule: RiskCheckModule;
    private executionEngine: ExecutionEngine;
    private logger: TradingLogger;

    constructor() {
        this.ollamaUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
        this.snapshotBuilder = new SnapshotBuilder();
        this.riskModule = new RiskCheckModule();
        // Note: Private key should be securely managed. For this demo, using env var.
        this.executionEngine = new ExecutionEngine(process.env.HYPERLIQUID_PRIVATE_KEY || "", true);
        this.logger = new TradingLogger();
    }

    public async analyzeMarket(
        userAddress: string | null,
        autoTrading: boolean,
        model: string,
        isTestnet: boolean
    ): Promise<{ decision: TradeDecision, riskAssessment: RiskAssessment, snapshot: StateSnapshot, prompt: string }> {

        // 1. Build Snapshot
        const snapshot = await this.snapshotBuilder.buildSnapshot(userAddress, isTestnet);

        // 2. Call LLM
        const { decision, prompt } = await this.getLLMDecision(snapshot, model);

        // 3. Risk Check
        const riskAssessment = this.riskModule.assess(decision, snapshot);

        // 4. Execution (if Auto-Trading)
        let executionResult = null;
        if (autoTrading && riskAssessment.approved && riskAssessment.modifiedOrder) {
            console.log("🚀 Auto-Trading: Executing Order...");
            // Need asset index for execution. 
            // In a real app, we'd have a map. For now, finding it from snapshot or defaulting.
            // Assuming BTC-PERP is asset 0 for demo.
            const assetIndex = 0; // TODO: Dynamic mapping
            const currentPrice = snapshot.markets[decision.symbol!]?.price || 0;

            this.executionEngine = new ExecutionEngine(process.env.HYPERLIQUID_PRIVATE_KEY || "", isTestnet);
            executionResult = await this.executionEngine.placeOrder(
                riskAssessment.modifiedOrder,
                currentPrice,
                assetIndex
            );
        }

        // 5. Log
        await this.logger.logDecision({
            timestamp: new Date().toISOString(),
            snapshot: "SNAPSHOT_HASH", // Optimize logging
            decision,
            riskAssessment,
            executionResult
        });

        return { decision, riskAssessment, snapshot, prompt };
    }

    private async getLLMDecision(snapshot: StateSnapshot, model: string): Promise<{ decision: TradeDecision, prompt: string }> {
        const marketCount = Object.keys(snapshot.markets).length;
        const hasMarketData = marketCount > 0;

        const systemPrompt = `You are a TraderAgent AI for crypto perpetual futures trading. Analyze the market snapshot and output a trading decision as JSON.

MARKET SNAPSHOT:
${JSON.stringify(snapshot, null, 2)}

ANALYSIS GUIDELINES:
- The snapshot contains ${marketCount} markets: ${Object.keys(snapshot.markets).join(', ')}
- Each market has: price, funding rate, open interest, sentiment, returns, and volatility data
- Account equity: $${snapshot.account.equity_usd.toFixed(2)}
- You can analyze ANY of the provided markets
- Consider: price trends (returns), sentiment scores, funding rates, and volatility
- If sentiment > 0.6 and positive returns, consider LONG positions
- If sentiment < 0.4 and negative returns, consider SHORT positions
- If markets exist but conditions are unclear, you can still choose DO_NOTHING

REQUIRED OUTPUT: A single JSON object with these exact fields:
- action: Must be one of: "OPEN_POSITION", "CLOSE_POSITION", "REDUCE_POSITION", "ADJUST_STOPS", "DO_NOTHING"
- symbol: One of the available markets (${Object.keys(snapshot.markets).map(s => `"${s}"`).join(', ')}) or null
- side: "long", "short", or null
- size_fraction_of_equity: A number between 0.0 and 1.0 (e.g., 0.1 for 10% of equity), or null
- risk_plan: An object with "stop_loss_pct" (negative number like -0.02) and "take_profit_pct_primary" (positive number like 0.05), or null
- playbook: One of: "trend_follow_pullback", "mean_reversion", "breakout", "hedge", "liquidity_exit", "none"
- confidence: A number between 0.0 and 1.0
- reason_code: A short code like "bullish_sentiment", "trend_follow", "high_funding", "no_clear_signal", etc.
- notes: A brief explanation (1-2 sentences)

OUTPUT ONLY THE JSON. NO EXPLANATION. NO MARKDOWN. NO CODE BLOCKS.

Example outputs:
{"action":"OPEN_POSITION","symbol":"BTC-PERP","side":"long","size_fraction_of_equity":0.1,"risk_plan":{"stop_loss_pct":-0.02,"take_profit_pct_primary":0.05},"playbook":"trend_follow_pullback","confidence":0.75,"reason_code":"bullish_sentiment","notes":"Positive sentiment and upward price momentum suggest a long position."}

{"action":"DO_NOTHING","symbol":null,"side":null,"size_fraction_of_equity":null,"risk_plan":null,"playbook":"none","confidence":0.5,"reason_code":"no_clear_signal","notes":"Market conditions are mixed, waiting for clearer signals."}`;


        try {
            console.log(`🤖 Calling LLM with model: ${model}`);
            const response = await fetch(`${this.ollamaUrl}/api/generate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: model,
                    prompt: systemPrompt,
                    stream: false,
                    format: "json",
                    options: {
                        temperature: 0.3,
                        top_p: 0.9
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error("❌ Ollama API Error:", response.status, errorText);
                throw new Error(`Ollama API Error: ${response.status}`);
            }

            const data = await response.json();
            console.log("📦 Raw LLM Response (first 300 chars):", data.response.substring(0, 300));

            // Try to extract JSON from the response
            let jsonStr = data.response.trim();

            // Remove markdown code blocks if present
            if (jsonStr.includes('```')) {
                const match = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
                if (match) {
                    jsonStr = match[1].trim();
                } else {
                    // Try to extract JSON between first { and last }
                    const firstBrace = jsonStr.indexOf('{');
                    const lastBrace = jsonStr.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1) {
                        jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
                    }
                }
            }

            // Parse JSON
            const parsed = JSON.parse(jsonStr);
            console.log("✅ Parsed Decision:", parsed);

            // Comprehensive Validation
            if (!parsed.action || typeof parsed.action !== 'string') {
                console.error("❌ Missing or invalid 'action' field");
                throw new Error("Invalid response: missing 'action' field");
            }

            const validActions = ["OPEN_POSITION", "CLOSE_POSITION", "REDUCE_POSITION", "ADJUST_STOPS", "DO_NOTHING"];
            if (!validActions.includes(parsed.action)) {
                console.error("❌ Invalid action value:", parsed.action);
                throw new Error(`Invalid action: ${parsed.action}`);
            }

            // Ensure all required fields exist
            const decision: TradeDecision = {
                action: parsed.action,
                symbol: parsed.symbol ?? null,
                side: parsed.side ?? null,
                size_fraction_of_equity: parsed.size_fraction_of_equity ?? null,
                risk_plan: parsed.risk_plan ?? null,
                playbook: parsed.playbook || "none",
                confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
                reason_code: parsed.reason_code || "unknown",
                notes: parsed.notes || "No explanation provided"
            };

            return { decision, prompt: systemPrompt };

        } catch (error) {
            console.error("❌ LLM Decision Error:", error);
            if (error instanceof Error) {
                console.error("Error details:", error.message);
            }

            // Fallback
            return {
                decision: {
                    action: "DO_NOTHING",
                    symbol: null,
                    side: null,
                    size_fraction_of_equity: null,
                    risk_plan: null,
                    playbook: "none",
                    confidence: 0,
                    reason_code: "error_fallback",
                    notes: `Error with model ${model}: ${error instanceof Error ? error.message : String(error)}`
                },
                prompt: systemPrompt
            };
        }
    }
}
