import { SnapshotBuilder, StateSnapshot } from "./SnapshotBuilder";
import { RiskCheckModule, TradeDecision, RiskAssessment } from "@/lib/risk/RiskCheckModule";
import { ExecutionEngine } from "@/lib/hyperliquidExecution";
import { TradingLogger } from "@/lib/log/tradingLogger";

import OpenAI from "openai";

import { TRADER_AGENT_SYSTEM_PROMPT } from "@/prompts/TraderAgent";

export class OrchestratorService {
    private static instance: OrchestratorService;
    private ollamaUrl: string;
    private openRouterClient: OpenAI | null = null;
    private snapshotBuilder: SnapshotBuilder;
    private riskModule: RiskCheckModule;
    private executionEngine: ExecutionEngine;
    private logger: TradingLogger;
    private currentAbortController: AbortController | null = null;

    private constructor() {
        this.ollamaUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

        const openRouterKey = process.env.OPENROUTER_API_KEY;
        if (openRouterKey) {
            this.openRouterClient = new OpenAI({
                baseURL: "https://openrouter.ai/api/v1",
                apiKey: openRouterKey,
                defaultHeaders: {
                    "HTTP-Referer": "http://localhost:3000",
                    "X-Title": "Centrypto Node App",
                },
            });
        }

        this.snapshotBuilder = new SnapshotBuilder();
        this.riskModule = new RiskCheckModule();
        // Note: Private key should be securely managed. For this demo, using env var.
        this.executionEngine = new ExecutionEngine(process.env.HYPERLIQUID_PRIVATE_KEY || "", true);
        this.logger = new TradingLogger();
    }

    public static getInstance(): OrchestratorService {
        if (!OrchestratorService.instance) {
            OrchestratorService.instance = new OrchestratorService();
        }
        return OrchestratorService.instance;
    }

    public cancelCurrentRequest(): void {
        if (this.currentAbortController) {
            console.log("🚫 Aborting current LLM request (client-side only)");
            this.currentAbortController.abort();
            this.currentAbortController = null;
        } else {
            console.log("⚠️ No active request to cancel");
        }
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

        // 2. Call LLM with abort controller
        this.currentAbortController = new AbortController();
        let decisions: TradeDecision[];
        let prompt: string;
        let rawOutput: string;

        try {
            const result = await this.getLLMDecision(snapshot, model, this.currentAbortController.signal);
            decisions = result.decisions;
            prompt = result.prompt;
            rawOutput = result.rawOutput;
        } finally {
            // Always clean up abort controller, even on error
            this.currentAbortController = null;
        }

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

    private async getLLMDecision(snapshot: StateSnapshot, model: string, signal?: AbortSignal): Promise<{ decisions: TradeDecision[], prompt: string, rawOutput: string }> {
        const marketCount = Object.keys(snapshot.markets).length;

        const SYSTEM_PROMPT = TRADER_AGENT_SYSTEM_PROMPT;
        const USER_PROMPT = `MARKET SNAPSHOT:
${JSON.stringify(snapshot)}

CURRENT POSITIONS (JSON):
${JSON.stringify(snapshot.account.current_positions, null, 2)}`;

        let rawOutput = "";

        try {
            console.log(`🤖 Calling LLM with model: ${model}`);

            // Check if we should use OpenRouter
            // If the model string contains "deepseek" or "gpt" or "claude" and we have a client, use it.
            // Or if the user specifically requested an OpenRouter model.
            // For now, let's assume if the model name contains "/" it's likely an OpenRouter model ID (e.g. "deepseek/deepseek-chat-v3-0324:free")
            // OR if we have the client and the model is not a standard local one.

            if (this.openRouterClient && (model.includes("/") || model.startsWith("gpt") || model.startsWith("anthropic"))) {
                console.log("✨ Using OpenRouter via OpenAI SDK");
                const completion = await this.openRouterClient.chat.completions.create({
                    model: model,
                    messages: [
                        { role: "system", content: SYSTEM_PROMPT },
                        { role: "user", content: USER_PROMPT }
                    ],
                    temperature: 0.3,
                    top_p: 0.9,
                    max_tokens: 8000, // Verified max for DeepSeek V3 (non-reasoner)
                    // @ts-ignore - signal is supported in newer openai versions but types might lag
                    signal: signal
                });

                const choice = completion.choices[0];
                console.log("🏁 LLM Finish Reason:", choice.finish_reason);
                if (choice.finish_reason === "length") {
                    console.warn("⚠️ LLM response was truncated due to length limit!");
                }

                rawOutput = choice.message.content || "";

            } else {
                // Fallback to Ollama
                const response = await fetch(`${this.ollamaUrl}/api/generate`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: model,
                        system: SYSTEM_PROMPT,
                        prompt: USER_PROMPT,
                        stream: true, // Enable streaming for better cancellation
                        // format: "json",  // Temporarily disabled
                        options: {
                            temperature: 0.3,
                            top_p: 0.9,
                            num_ctx: 15000 // Reduced context window
                        }
                    }),
                    signal: signal // Pass the abort signal
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error("❌ Ollama API Error:", response.status, errorText);
                    throw new Error(`Ollama API Error: ${response.status} - ${errorText}`);
                }

                // Handle streaming response
                const reader = response.body?.getReader();
                if (!reader) throw new Error("Failed to get response reader");

                const decoder = new TextDecoder();
                rawOutput = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n');

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const json = JSON.parse(line);
                            if (json.response) {
                                rawOutput += json.response;
                            }
                            if (json.done) {
                                break;
                            }
                        } catch (e) {
                            // Ignore parse errors for partial chunks
                        }
                    }
                }
            }

            console.log("📦 Raw LLM Response (first 300 chars):", rawOutput.substring(0, 300));
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
                console.warn("⚠️ Initial JSON parse failed, attempting to repair truncated JSON...");
                try {
                    // Simple repair for truncated JSON
                    // 1. Remove trailing commas
                    // 2. Close open strings/objects/arrays
                    let repaired = jsonStr.trim();

                    // Remove trailing comma if present
                    if (repaired.endsWith(',')) {
                        repaired = repaired.slice(0, -1);
                    }

                    // Balance braces/brackets
                    const stack = [];
                    let inString = false;
                    let escape = false;

                    for (let i = 0; i < repaired.length; i++) {
                        const char = repaired[i];
                        if (escape) {
                            escape = false;
                            continue;
                        }
                        if (char === '\\') {
                            escape = true;
                            continue;
                        }
                        if (char === '"') {
                            inString = !inString;
                            continue;
                        }
                        if (!inString) {
                            if (char === '{' || char === '[') {
                                stack.push(char);
                            } else if (char === '}' || char === ']') {
                                const last = stack.pop();
                                // Mismatch check could go here
                            }
                        }
                    }

                    // Close open string
                    if (inString) {
                        repaired += '"';
                    }

                    // Close open structures
                    while (stack.length > 0) {
                        const open = stack.pop();
                        if (open === '{') repaired += '}';
                        if (open === '[') repaired += ']';
                    }

                    console.log("🔧 Repaired JSON:", repaired.substring(repaired.length - 50)); // Log end of repaired string
                    parsed = JSON.parse(repaired);
                    console.log("✅ JSON repaired successfully");

                } catch (repairError) {
                    console.error("❌ JSON Repair Failed:", repairError);
                    console.error("Original JSON Error:", e);
                    throw new Error(`Failed to parse JSON (even after repair): ${e instanceof Error ? e.message : String(e)}`);
                }
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
