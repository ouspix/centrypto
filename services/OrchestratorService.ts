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
        isTestnet: boolean,
        screeningConfig?: any
    ): Promise<{ decisions: TradeDecision[], riskAssessment: RiskAssessment, snapshot: StateSnapshot, prompt: string, rawOutput: string }> {

        // 1. Build Snapshot
        const snapshot = await this.snapshotBuilder.buildSnapshot(userAddress, isTestnet, screeningConfig);

        // 2. Call LLM
        const { decisions, prompt, rawOutput } = await this.getLLMDecision(snapshot, model);

        // 3. Risk Check & Execution Loop
        // We need to assess risk for EACH decision.
        // For simplicity in this iteration, we will process them sequentially.

        const processedDecisions: TradeDecision[] = [];
        // Note: RiskAssessment currently returns a single assessment. 
        // We might need to aggregate them or just return the last one for the signature, 
        // but ideally we should return an array of assessments.
        // For now, I'll keep the signature compatible-ish but return the first assessment or a dummy one if multiple.
        // Actually, I should update the return type of analyzeMarket to include decisions array.

        let lastRiskAssessment: RiskAssessment = { approved: false, reason: "No decisions" };

        for (const decision of decisions) {
            if (decision.target_side === "flat" && decision.action === "HOLD") continue; // Skip no-ops

            // Risk Check
            const riskAssessment = this.riskModule.assess(decision, snapshot);
            lastRiskAssessment = riskAssessment;

            // 4. Execution (if Auto-Trading)
            let executionResult = null;
            if (autoTrading && riskAssessment.approved && riskAssessment.modifiedOrder) {
                console.log(`🚀 Auto-Trading: Executing Order for ${decision.symbol}...`);

                // Need asset index for execution. 
                // In a real app, we'd have a map. For now, finding it from snapshot or defaulting.
                // We need to fetch meta to get the index if not in snapshot.
                // Assuming we can get it or pass it. 
                // For this demo, we might fail if we don't have the index.
                // TODO: Add asset index to snapshot or fetch it here.
                const assetIndex = 0; // Placeholder
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

            processedDecisions.push(decision);
        }

        return { decisions, riskAssessment: lastRiskAssessment, snapshot, prompt, rawOutput };
    }

    private async getLLMDecision(snapshot: StateSnapshot, model: string): Promise<{ decisions: TradeDecision[], prompt: string, rawOutput: string }> {
        const marketCount = Object.keys(snapshot.markets).length;

        const SYSTEM_PROMPT = `ROLE: Crypto Volatility Scalper AI.
GOAL: Build and rebalance a diversified portfolio (target 3-5 positions) for max risk-adjusted return using INTRADAY VOLATILITY SCALPING.
STRATEGY: 
- Mean Reversion: strong negative ret_5m_vs_1h, "fast_move_down" regime_tags, stretched negative returns vs h1.
- Momentum: strong positive ret_5m_vs_1h, "fast_move_up" / "high_intraday_vol" regime_tags, elevated vol_5m_vs_1h.
- Use book_pressure to confirm or reject entries (longs prefer positive book_pressure, shorts prefer negative).

### HARD CONSTRAINTS (NON-NEGOTIABLE)
- CURRENT_POSITIONS = account.current_positions in the MARKET SNAPSHOT.
- For every cp in CURRENT_POSITIONS, you MUST output exactly one decision object in "decisions" with the same "symbol" as cp.symbol.
- If any symbol in CURRENT_POSITIONS is missing from "decisions", your answer is INVALID.
- Total number of non-flat positions in "decisions" must be between 3 and 5 (unless capital constrained).
- You MUST respect numerical limits in constraints:
  * max_position_pct_equity_per_symbol
  * max_total_exposure_pct_equity
  * min_trade_notional_usd

### ACTIONS
Valid "action" values (string, required):
- "OPEN_POSITION"
- "INCREASE_POSITION"
- "REDUCE_POSITION"
- "CLOSE_POSITION"
- "HOLD_POSITION"

### STRATEGIC SYNTHESIS (REQUIRED)
In "reasoning", briefly (max 200 words) follow this structure:
1) Brief market regime.
2) What you do with each CURRENT_POSITION (explicitly list them).
3) Why you picked each new symbol (vol_zscores, returns, book_pressure, sentiment).
4) Final exposure and risk rationale.

### OUTPUT FORMAT (JSON ONLY)
Return a SINGLE JSON object.
{
  "reasoning": "1) Market is low vol... 2) ETH-PERP: HOLD, SOL-PERP: REDUCE... 3) New: BTC-PERP Short due to...",
  "decisions": [
    {
      "symbol": "ETH-PERP",
      "target_side": "short",
      "target_size_fraction_of_equity": 0.15,
      "action": "OPEN_POSITION",
      "risk_plan": { "stop_loss_pct": -0.01, "take_profit_pct_primary": 0.03 },
      "playbook": "mean_reversion_rsi_div",
      "confidence": 0.85,
      "reason_code": "high_vol_zscore_neg_pressure",
      "notes": "High vol z-score with negative book pressure."
    }
  ]
}`;

        const USER_PROMPT = `MARKET SNAPSHOT:
${JSON.stringify(snapshot)}

CURRENT POSITIONS (JSON):
${JSON.stringify(snapshot.account.current_positions, null, 2)}

INSTRUCTION:
- Use MARKET SNAPSHOT and constraints as provided.
- Respect HARD CONSTRAINTS from the system prompt.
- Focus on intraday volatility scalping opportunities.
- Return JSON only.`;

        let rawOutput = "";

        try {
            console.log(`🤖 Calling LLM with model: ${model}`);

            const response = await fetch(`${this.ollamaUrl}/api/generate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: model,
                    system: SYSTEM_PROMPT,
                    prompt: USER_PROMPT,
                    stream: false,
                    // format: "json",  // Temporarily disabled
                    options: {
                        temperature: 0.3,
                        top_p: 0.9,
                        num_ctx: 15000 // Reduced context window
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error("❌ Ollama API Error:", response.status, errorText);
                throw new Error(`Ollama API Error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            rawOutput = data.response || "";

            console.log("📦 Raw LLM Response (first 300 chars):", rawOutput.substring(0, 300));
            console.log("🔍 Debug: data keys:", Object.keys(data));
            console.log("🔍 Debug: rawOutput length:", rawOutput.length);

            // Robust JSON Extraction
            let jsonStr = rawOutput.trim();

            // 1. Try to find JSON in code blocks
            const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
            if (codeBlockMatch) {
                jsonStr = codeBlockMatch[1].trim();
            } else {
                // 2. If no code blocks, try to find the first '{' or '['
                const firstBrace = jsonStr.indexOf('{');
                const firstBracket = jsonStr.indexOf('[');

                if (firstBrace === -1 && firstBracket === -1) {
                    throw new Error("No JSON object or array found in response");
                }

                const start = (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket))
                    ? firstBrace
                    : firstBracket;

                const end = jsonStr.lastIndexOf((start === firstBrace) ? '}' : ']');

                if (end !== -1) {
                    jsonStr = jsonStr.substring(start, end + 1);
                }
            }

            // Parse JSON
            let parsed: any;
            try {
                parsed = JSON.parse(jsonStr);
            } catch (e) {
                console.error("JSON Parse Error:", e);
                throw new Error(`Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`);
            }

            // Normalize Structure
            let decisionsArray: any[] = [];

            if (Array.isArray(parsed)) {
                // Case 1: Direct array of decisions
                decisionsArray = parsed;
            } else if (parsed.decisions && Array.isArray(parsed.decisions)) {
                // Case 2: Standard format { decisions: [...] }
                decisionsArray = parsed.decisions;
            } else if (parsed.symbol && parsed.action) {
                // Case 3: Single decision object
                decisionsArray = [parsed];
            } else {
                // Case 4: Maybe wrapped in another key? Try to find an array value
                const arrayValue = Object.values(parsed).find(v => Array.isArray(v));
                if (arrayValue) {
                    decisionsArray = arrayValue as any[];
                } else {
                    // Case 5: DeepSeek-R1 reasoning tokens - check if all keys start with "/"
                    const keys = Object.keys(parsed);
                    const allKeysAreMetadata = keys.length > 0 && keys.every(k => k.startsWith('/'));

                    if (allKeysAreMetadata) {
                        console.error("⚠️ DeepSeek-R1 returned only reasoning/metadata tokens. The model may not be following the JSON schema.");
                        console.error("Parsed object:", JSON.stringify(parsed, null, 2));
                        throw new Error("DeepSeek-R1 returned reasoning tokens instead of decisions. Try a different model or adjust the prompt.");
                    }

                    console.error("Parsed object keys:", keys);
                    console.error("Parsed object:", JSON.stringify(parsed, null, 2));
                    throw new Error(`Invalid response structure: could not find decisions array. Found keys: ${keys.join(', ')}`);
                }
            }

            const decisions: TradeDecision[] = decisionsArray.map((d: any) => ({
                action: d.action,
                symbol: d.symbol,
                side: d.side ?? null,
                size_fraction_of_equity: d.size_fraction_of_equity ?? null,
                target_side: d.target_side,
                target_size_fraction_of_equity: d.target_size_fraction_of_equity,
                risk_plan: d.risk_plan,
                playbook: d.playbook || "none",
                confidence: d.confidence || 0.5,
                reason_code: d.reason_code || "unknown",
                notes: d.notes || ""
            }));

            return { decisions, prompt: SYSTEM_PROMPT + "\n\n" + USER_PROMPT, rawOutput };

        } catch (error) {
            console.error("❌ LLM Decision Error:", error);
            // Fallback
            return {
                decisions: [{
                    action: "DO_NOTHING",
                    symbol: null,
                    side: null,
                    size_fraction_of_equity: null,
                    target_side: "flat",
                    target_size_fraction_of_equity: 0,
                    risk_plan: null,
                    playbook: "none",
                    confidence: 0,
                    reason_code: "error_fallback",
                    notes: `Error: ${error instanceof Error ? error.message : String(error)}`
                }],
                prompt: SYSTEM_PROMPT + "\n\n" + USER_PROMPT,
                rawOutput: rawOutput || `Error: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
}
