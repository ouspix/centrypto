import { SnapshotBuilder, StateSnapshot } from "./SnapshotBuilder";
import { RiskCheckModule, TradeDecision, RiskAssessment } from "@/lib/risk/RiskCheckModule";
import { ExecutionEngine } from "@/lib/hyperliquidExecution";
import { placeOrder } from "@/lib/hyperliquid";
import { TradingLogger } from "@/lib/log/tradingLogger";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";
import { prisma } from "@/lib/db";

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
    private activeJobs: Map<string, AbortController> = new Map();

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

    public async cancelJob(jobId: string): Promise<boolean> {
        // 1. Abort the running process if active in memory
        const controller = this.activeJobs.get(jobId);
        if (controller) {
            console.log(`🚫 Aborting job ${jobId}`);
            controller.abort();
            this.activeJobs.delete(jobId);
        }

        // 2. Update DB status
        try {
            await prisma.analysisJob.update({
                where: { id: jobId },
                data: {
                    status: 'cancelled',
                    completedAt: new Date()
                }
            });
            return true;
        } catch (error) {
            console.error(`Failed to cancel job ${jobId} in DB:`, error);
            return false;
        }
    }

    public async getJobStatus(jobId: string): Promise<any> {
        const job = await prisma.analysisJob.findUnique({
            where: { id: jobId }
        });

        if (!job) return null;

        return {
            id: job.id,
            status: job.status,
            result: job.result ? JSON.parse(job.result) : null,
            error: job.error,
            createdAt: job.createdAt,
            completedAt: job.completedAt
        };
    }

    public async analyzeMarketWithJobTracking(
        userAddress: string | null,
        model: string,
        isTestnet: boolean,
        configOverride?: any
    ): Promise<string> {
        // 1. Create Job Record
        const job = await prisma.analysisJob.create({
            data: {
                status: 'pending',
                userAddress,
                isTestnet,
                model,
                config: configOverride ? JSON.stringify(configOverride) : null
            }
        });

        console.log(`📝 Created analysis job: ${job.id}`);

        // 2. Start Analysis in Background (Fire & Forget)
        this.runAnalysisJob(job.id, userAddress, model, isTestnet, configOverride).catch(err => {
            console.error(`❌ Background job ${job.id} failed unhandled:`, err);
        });

        return job.id;
    }

    private async runAnalysisJob(
        jobId: string,
        userAddress: string | null,
        model: string,
        isTestnet: boolean,
        configOverride?: any
    ) {
        const controller = new AbortController();
        this.activeJobs.set(jobId, controller);

        try {
            // Update status to running
            await prisma.analysisJob.update({
                where: { id: jobId },
                data: { status: 'running' }
            });

            // Re-use existing analyzeMarket logic but with our controller
            // We need to refactor analyzeMarket slightly or just call it and pass the signal
            // Since analyzeMarket creates its own controller, we should probably extract the core logic
            // OR just modify analyzeMarket to accept an optional external signal.

            // For now, I'll call analyzeMarket but I need to ensure it uses MY signal if passed.
            // I'll modify analyzeMarket signature to accept an optional signal.

            // Actually, analyzeMarket currently manages `this.currentAbortController`.
            // I should refactor analyzeMarket to be "stateless" regarding the controller if a signal is provided.

            // Let's use a private internal method for the core logic to avoid breaking the public API
            // Or just call the public API and let it overwrite currentAbortController (which is fine for single-user dev mode, 
            // but for job tracking we want isolation).

            // Better approach: Call getLLMDecision directly after building snapshot?
            // analyzeMarket does: Build Snapshot -> Filter -> Get LLM Decision -> Risk Check -> Execution -> Log

            // I will duplicate the orchestration logic here for safety and isolation, 
            // reusing the helper methods.

            // --- COPY OF ORCHESTRATION LOGIC ---
            // Merge config
            const config: AgentConfig = {
                ...DEFAULT_AGENT_CONFIG,
                ...configOverride,
                network_profiles: { ...DEFAULT_AGENT_CONFIG.network_profiles, ...configOverride?.network_profiles },
                gates: { ...DEFAULT_AGENT_CONFIG.gates, ...configOverride?.gates },
                risk: { ...DEFAULT_AGENT_CONFIG.risk, ...configOverride?.risk },
                sentiment_policy: { ...DEFAULT_AGENT_CONFIG.sentiment_policy, ...configOverride?.sentiment_policy }
            };

            const screenerConfig: ScreenerConfig = {
                ...DEFAULT_SCREENER_CONFIG,
                ...configOverride?.screener
            };

            // 1. Build Snapshot
            if (controller.signal.aborted) throw new Error('Aborted');
            const snapshot = await this.snapshotBuilder.buildSnapshot(userAddress, isTestnet, config, screenerConfig);

            // 2. Optimization
            const shortlistedMarkets: Record<string, any> = {};
            let hasCandidates = false;

            for (const [key, market] of Object.entries(snapshot.markets)) {
                const isHeld = snapshot.account.current_positions.some(p => p.symbol === key);
                const isCandidate = market.derived?.liquidity?.tradeable && market.derived?.edge?.edge_ok;

                if (isHeld || isCandidate) {
                    shortlistedMarkets[key] = market;
                    if (isCandidate) hasCandidates = true;
                }
            }

            const hasPositions = snapshot.account.current_positions.length > 0;

            if (!hasPositions && !hasCandidates) {
                await prisma.analysisJob.update({
                    where: { id: jobId },
                    data: {
                        status: 'completed',
                        result: JSON.stringify({
                            decisions: [],
                            riskAssessments: [],
                            snapshot,
                            prompt: "SKIPPED",
                            rawOutput: "SKIPPED"
                        }),
                        completedAt: new Date()
                    }
                });
                return;
            }

            // 3. Call LLM
            if (controller.signal.aborted) throw new Error('Aborted');

            const llmSnapshot = {
                ...snapshot,
                markets: shortlistedMarkets
            };

            const result = await this.getLLMDecision(llmSnapshot, model, controller.signal);

            // Save interaction
            await this.saveLlmInteraction(result.prompt, result.rawOutput, result.decisions, isTestnet);

            // 4. Risk Check (Sequential)
            // Note: We are NOT executing trades here for manual analysis jobs.
            // The user just wants the analysis. Execution happens when they click "Execute" in UI.
            const riskAssessments: RiskAssessment[] = [];

            for (const decision of result.decisions) {
                if (decision.target_side === "flat" && decision.action === "HOLD") {
                    riskAssessments.push({ approved: true, reason: "Hold decision - no trade" });
                    continue;
                }
                const riskAssessment = this.riskModule.assess(decision, snapshot);
                riskAssessments.push(riskAssessment);
            }

            const finalResult = {
                decisions: result.decisions,
                riskAssessments,
                snapshot,
                prompt: result.prompt,
                rawOutput: result.rawOutput
            };

            // 5. Complete Job
            await prisma.analysisJob.update({
                where: { id: jobId },
                data: {
                    status: 'completed',
                    result: JSON.stringify(finalResult),
                    completedAt: new Date()
                }
            });

        } catch (error) {
            if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted')) {
                console.log(`Job ${jobId} was cancelled`);
                // Status already updated to cancelled in cancelJob, but just in case
                await prisma.analysisJob.update({
                    where: { id: jobId },
                    data: { status: 'cancelled', completedAt: new Date() }
                });
            } else {
                console.error(`Job ${jobId} failed:`, error);
                await prisma.analysisJob.update({
                    where: { id: jobId },
                    data: {
                        status: 'failed',
                        error: error instanceof Error ? error.message : String(error),
                        completedAt: new Date()
                    }
                });
            }
        } finally {
            this.activeJobs.delete(jobId);
        }
    }

    public async analyzeMarket(
        userAddress: string | null,
        autoTrading: boolean,
        model: string,
        isTestnet: boolean,
        configOverride?: any
    ): Promise<{ decisions: TradeDecision[], riskAssessments: RiskAssessment[], snapshot: StateSnapshot, prompt: string, rawOutput: string }> {

        // Merge config
        // Basic deep merge for top-level sections
        const config: AgentConfig = {
            ...DEFAULT_AGENT_CONFIG,
            ...configOverride,
            network_profiles: { ...DEFAULT_AGENT_CONFIG.network_profiles, ...configOverride?.network_profiles },
            gates: { ...DEFAULT_AGENT_CONFIG.gates, ...configOverride?.gates },
            risk: { ...DEFAULT_AGENT_CONFIG.risk, ...configOverride?.risk },
            sentiment_policy: { ...DEFAULT_AGENT_CONFIG.sentiment_policy, ...configOverride?.sentiment_policy }
        };

        const screenerConfig: ScreenerConfig = {
            ...DEFAULT_SCREENER_CONFIG,
            ...configOverride?.screener
        };

        // 1. Build Snapshot
        const snapshot = await this.snapshotBuilder.buildSnapshot(userAddress, isTestnet, config, screenerConfig);

        // 2. Optimization: Filter Markets & Early Exit
        const shortlistedMarkets: Record<string, any> = {};
        let hasCandidates = false;

        for (const [key, market] of Object.entries(snapshot.markets)) {
            // Keep if tradeable AND edge_ok
            // OR if we hold a position in it (so LLM can manage it)
            const isHeld = snapshot.account.current_positions.some(p => p.symbol === key);
            const isCandidate = market.derived?.liquidity?.tradeable && market.derived?.edge?.edge_ok;

            if (isHeld || isCandidate) {
                shortlistedMarkets[key] = market;
                if (isCandidate) hasCandidates = true;
            }
        }

        const hasPositions = snapshot.account.current_positions.length > 0;

        // EARLY EXIT: If no positions to manage AND no valid candidates to open
        if (!hasPositions && !hasCandidates) {
            console.log("💤 Early Exit: No positions and no valid candidates. Skipping LLM.");
            return {
                decisions: [],
                riskAssessments: [],
                snapshot,
                prompt: "SKIPPED",
                rawOutput: "SKIPPED"
            };
        }

        console.log(`✨ Optimization: Sending ${Object.keys(shortlistedMarkets).length} markets to LLM (filtered from ${Object.keys(snapshot.markets).length})`);

        // 3. Call LLM with abort controller
        this.currentAbortController = new AbortController();
        let decisions: TradeDecision[];
        let prompt: string;
        let rawOutput: string;

        try {
            // Create a lightweight snapshot for the LLM
            const llmSnapshot = {
                ...snapshot,
                markets: shortlistedMarkets
            };

            const result = await this.getLLMDecision(llmSnapshot, model, this.currentAbortController.signal);
            decisions = result.decisions;
            prompt = result.prompt;
            rawOutput = result.rawOutput;

            // Save to DB
            await this.saveLlmInteraction(prompt, rawOutput, decisions, isTestnet);

        } finally {
            // Always clean up abort controller, even on error
            this.currentAbortController = null;
        }

        // 3. Risk Check & Execution Loop
        // We need to assess risk for EACH decision.
        // For simplicity in this iteration, we will process them sequentially.

        const processedDecisions: TradeDecision[] = [];
        const riskAssessments: RiskAssessment[] = [];

        for (const decision of decisions) {
            try {
                if (decision.target_side === "flat" && decision.action === "HOLD") {
                    riskAssessments.push({ approved: true, reason: "Hold decision - no trade" });
                    continue; // Skip no-ops
                }

                // Risk Check
                const riskAssessment = this.riskModule.assess(decision, snapshot);
                riskAssessments.push(riskAssessment);

                // 4. Execution (if Auto-Trading)
                let executionResult = null;
                if (autoTrading && riskAssessment.approved && riskAssessment.modifiedOrder) {
                    console.log(`🚀 Auto-Trading: Risk Officer APPROVED. Executing Order for ${decision.symbol}...`);

                    const marketData = snapshot.markets[decision.symbol!];
                    const assetIndex = marketData?.assetIndex;

                    if (assetIndex === undefined) {
                        console.error(`❌ Auto-Trading Error: Asset index not found for ${decision.symbol}`);
                        // Log the failure
                        await this.logger.logDecision({
                            timestamp: new Date().toISOString(),
                            snapshot: "SNAPSHOT_HASH",
                            decision,
                            riskAssessment,
                            executionResult: { success: false, error: "Asset index not found" }
                        });
                        continue;
                    }

                    const currentPrice = marketData?.price || 0;

                    // Direct Execution using placeOrder (same as manual trading)
                    try {
                        const privateKey = isTestnet
                            ? process.env.HYPERLIQUID_TESTNET_PRIVATE_KEY
                            : process.env.HYPERLIQUID_PRIVATE_KEY;

                        if (!privateKey) {
                            throw new Error("Private key not found in env");
                        }

                        const isBuy = riskAssessment.modifiedOrder.side === 'buy';
                        const sz = riskAssessment.modifiedOrder.sizeUsd / currentPrice;
                        const reduceOnly = decision.action === 'CLOSE_POSITION' || decision.action === 'REDUCE_POSITION';

                        // 5% Slippage for "Market" execution
                        const slippage = 0.05;
                        const limitPx = isBuy
                            ? currentPrice * (1 + slippage)
                            : currentPrice * (1 - slippage);

                        console.log(`🚀 Sending Order: ${isBuy ? 'BUY' : 'SELL'} ${decision.symbol} sz=${sz.toFixed(4)} px=${limitPx.toFixed(4)} reduce=${reduceOnly}`);

                        const stopLossPrice = !reduceOnly ? riskAssessment.modifiedOrder.stopLossPrice : undefined;
                        const takeProfitPrice = !reduceOnly ? riskAssessment.modifiedOrder.takeProfitPrice : undefined;

                        const result = await placeOrder(
                            privateKey,
                            {
                                asset: assetIndex,
                                isBuy,
                                limitPx,
                                sz,
                                reduceOnly,
                                stopLossPrice,
                                takeProfitPrice
                            },
                            isTestnet
                        );

                        if (result.status === "ok") {
                            executionResult = {
                                success: true,
                                status: "submitted",
                                orderId: result.response?.data?.statuses?.[0]?.oid?.toString()
                            };
                            // Add a small delay to prevent nonce collisions and rate limits
                            await new Promise(resolve => setTimeout(resolve, 500));
                        } else {
                            executionResult = {
                                success: false,
                                status: "failed",
                                error: JSON.stringify(result.response)
                            };
                        }

                    } catch (error: any) {
                        console.error("❌ Auto-Trading Execution Failed:", error);
                        executionResult = {
                            success: false,
                            status: "error",
                            error: error.message || String(error)
                        };
                    }
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
            } catch (loopError) {
                console.error(`❌ Error processing decision for ${decision.symbol}:`, loopError);
            }
        }

        return { decisions, riskAssessments, snapshot, prompt, rawOutput };
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

            // Log Snapshot Details for Debugging
            if (snapshot.markets) {
                console.log("🔍 Snapshot Debug:");
                console.log("   Global Regime:", JSON.stringify(snapshot.global_regime));
                Object.entries(snapshot.markets).forEach(([symbol, market]) => {
                    console.log(`   Market ${symbol}:`);
                    console.log(`     Price: ${market.price}, Spread: ${market.spread_bps.toFixed(2)}bps`);
                    console.log(`     Triggers:`, JSON.stringify(market.derived.triggers));
                    console.log(`     Edge OK: ${market.derived.edge.edge_ok}, Cost OK: ${market.derived.costs.cost_ok}`);
                });
            }

            console.log("📦 Raw LLM Response (first 300 chars):", rawOutput.substring(0, 300));
            require('fs').appendFileSync('debug_llm_response.log', `\n\n--- ${new Date().toISOString()} ---\nPrompt:\n${USER_PROMPT}\n\nResponse:\n${rawOutput}\n-----------------------------------\n`);
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

            const decisions: TradeDecision[] = [];

            for (const d of decisionsArray) {
                // 1. Filter out DO_NOTHING
                if (d.action === "DO_NOTHING") continue;

                // 2. Filter out invalid symbols (N/A, null, empty)
                if (!d.symbol || d.symbol === "N/A" || d.symbol === "null") continue;

                // 3. Validate Action
                const validActions = ["OPEN_POSITION", "INCREASE_POSITION", "REDUCE_POSITION", "CLOSE_POSITION", "HOLD_POSITION"];
                if (!validActions.includes(d.action)) {
                    console.warn(`⚠️ Skipping invalid action: ${d.action} for ${d.symbol}`);
                    continue;
                }

                decisions.push({
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
                });
            }

            return { decisions, prompt: SYSTEM_PROMPT + "\n\n" + USER_PROMPT, rawOutput };

        } catch (error) {
            console.error("❌ LLM Decision Error:", error);
            // Fallback
            return {
                decisions: [], // Return empty array on error instead of DO_NOTHING
                prompt: SYSTEM_PROMPT + "\n\n" + USER_PROMPT,
                rawOutput: rawOutput || `Error: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    private async saveLlmInteraction(prompt: string, response: string, decisions: TradeDecision[], isTestnet: boolean) {
        try {
            await prisma.llmQuery.create({
                data: {
                    prompt,
                    response,
                    decisions: {
                        create: decisions.map(d => ({
                            action: d.action,
                            symbol: d.symbol || "UNKNOWN",
                            confidence: d.confidence || 0,
                            reasonCode: d.reason_code,
                            notes: d.notes,
                            side: d.side,
                            sizeFraction: d.size_fraction_of_equity,
                            targetSide: d.target_side,
                            targetSize: d.target_size_fraction_of_equity,
                            playbook: d.playbook,
                            riskPlan: d.risk_plan ? JSON.stringify(d.risk_plan) : null
                        }))
                    },
                    isTestnet: isTestnet
                }
            });
            console.log("✅ Saved LLM interaction to DB");
        } catch (error) {
            console.error("❌ Failed to save LLM interaction:", error);
        }
    }
}
