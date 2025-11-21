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
        model: string
    ): Promise<{ decision: TradeDecision, riskAssessment: RiskAssessment, snapshot: StateSnapshot }> {

        // 1. Build Snapshot
        const snapshot = await this.snapshotBuilder.buildSnapshot(userAddress);

        // 2. Call LLM
        const decision = await this.getLLMDecision(snapshot, model);

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

        return { decision, riskAssessment, snapshot };
    }

    private async getLLMDecision(snapshot: StateSnapshot, model: string): Promise<TradeDecision> {
        const systemPrompt = `
You are the TraderAgent in an automated crypto trading system.
Your job: Read the current state snapshot and decide whether to open, reduce, or close a position, adjust stops, or do nothing.
You NEVER talk to exchanges directly. You NEVER break constraints.
Output EXACTLY ONE JSON object.

INPUT FORMAT:
${JSON.stringify(snapshot, null, 2)}

OUTPUT FORMAT:
{
  "action": "OPEN_POSITION" | "CLOSE_POSITION" | "REDUCE_POSITION" | "ADJUST_STOPS" | "DO_NOTHING",
  "symbol": "BTC-PERP" | "ETH-PERP" | null,
  "side": "long" | "short" | null,
  "size_fraction_of_equity": 0.0,
  "risk_plan": { "stop_loss_pct": -0.02, "take_profit_pct_primary": 0.05, ... } | null,
  "playbook": "trend_follow_pullback" | "mean_reversion" | "breakout" | "hedge" | "liquidity_exit" | "none",
  "confidence": 0.0,
  "reason_code": "trend_follow" | "fade_extreme_sentiment" | "no_trade" | ...,
  "notes": "short explanation"
}
`;

        try {
            const response = await fetch(`${this.ollamaUrl}/api/generate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: model,
                    prompt: systemPrompt,
                    stream: false,
                    format: "json"
                })
            });

            if (!response.ok) throw new Error("Ollama API Error");

            const data = await response.json();
            const parsed = JSON.parse(data.response);

            // Basic Validation
            if (!parsed.action) throw new Error("Missing action field");

            return parsed as TradeDecision;

        } catch (error) {
            console.error("LLM Decision Error:", error);
            // Fallback
            return {
                action: "DO_NOTHING",
                symbol: null,
                side: null,
                size_fraction_of_equity: null,
                risk_plan: null,
                playbook: "none",
                confidence: 0,
                reason_code: "error_fallback",
                notes: "Error obtaining valid decision from LLM."
            };
        }
    }
}
