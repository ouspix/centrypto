import { SnapshotBuilder, StateSnapshot } from "./SnapshotBuilder";
import { MarketEntry, GlobalRegime } from "@/types/snapshot";
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
                risk_plan_model: {
                    ...DEFAULT_AGENT_CONFIG.risk_plan_model,
                    ...configOverride?.risk_plan_model,
                    vol_anchor_priority: configOverride?.risk_plan_model?.vol_anchor_priority ?? DEFAULT_AGENT_CONFIG.risk_plan_model.vol_anchor_priority,
                    multipliers_by_playbook: {
                        ...DEFAULT_AGENT_CONFIG.risk_plan_model.multipliers_by_playbook,
                        ...configOverride?.risk_plan_model?.multipliers_by_playbook
                    },
                    regime_adjustments: {
                        ...DEFAULT_AGENT_CONFIG.risk_plan_model.regime_adjustments,
                        ...configOverride?.risk_plan_model?.regime_adjustments
                    }
                },
                sentiment_policy: { ...DEFAULT_AGENT_CONFIG.sentiment_policy, ...configOverride?.sentiment_policy }
            };
            config.risk.max_position_fraction = config.risk.max_position_fraction ?? config.risk.max_position_fraction_per_symbol;
            config.risk.max_position_fraction_per_symbol = config.risk.max_position_fraction_per_symbol ?? config.risk.max_position_fraction;

            const screenerConfig: ScreenerConfig = {
                ...DEFAULT_SCREENER_CONFIG,
                ...configOverride?.screener
            };

            // 1. Build Snapshot
            if (controller.signal.aborted) throw new Error('Aborted');
            const snapshot = await this.snapshotBuilder.buildSnapshot(userAddress, isTestnet, config, screenerConfig);
            const snapshotId = await this.persistSnapshot(snapshot);
            if (snapshotId) {
                snapshot.meta.snapshot_id = snapshotId;
            }

            // 2. Optimization
            const shortlistedMarkets: Record<string, any> = {};
            let hasCandidates = false;

            for (const [key, market] of Object.entries(snapshot.markets)) {
                const isHeld = snapshot.account.current_positions.some(p => p.symbol === key);
                const isCandidate = !!market.derived?.risk?.eligible;

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

            const backendDecisions = this.enrichDecisions(result.decisions, snapshot, config);

            // Save interaction
            await this.saveLlmInteraction(result.prompt, result.rawOutput, backendDecisions, isTestnet);

            // 4. Risk Check (Sequential)
            // Note: We are NOT executing trades here for manual analysis jobs.
            // The user just wants the analysis. Execution happens when they click "Execute" in UI.
            const riskAssessments: RiskAssessment[] = [];
            let newPositionsCount = 0;

            for (const decision of backendDecisions) {
                if (decision.target_side === "flat" && (decision.action === "HOLD" || decision.action === "HOLD_POSITION")) {
                    riskAssessments.push({ approved: true, reason: "Hold decision - no trade" });
                    continue;
                }
                this.clampDecisionRiskPlan(decision);
                const riskAssessment = this.riskModule.assess(decision, snapshot, { newPositionsCount });
                riskAssessments.push(riskAssessment);

                if (riskAssessment.approved && (decision.action === 'OPEN_POSITION' || (decision.action === 'INCREASE_POSITION' && riskAssessment.modifiedOrder?.clientTag === 'AI_TRADER_INCREASE_NEW'))) {
                    newPositionsCount++;
                }
            }

            const finalResult = {
                decisions: backendDecisions,
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
            risk_plan_model: {
                ...DEFAULT_AGENT_CONFIG.risk_plan_model,
                ...configOverride?.risk_plan_model,
                vol_anchor_priority: configOverride?.risk_plan_model?.vol_anchor_priority ?? DEFAULT_AGENT_CONFIG.risk_plan_model.vol_anchor_priority,
                multipliers_by_playbook: {
                    ...DEFAULT_AGENT_CONFIG.risk_plan_model.multipliers_by_playbook,
                    ...configOverride?.risk_plan_model?.multipliers_by_playbook
                },
                regime_adjustments: {
                    ...DEFAULT_AGENT_CONFIG.risk_plan_model.regime_adjustments,
                    ...configOverride?.risk_plan_model?.regime_adjustments
                }
            },
            sentiment_policy: { ...DEFAULT_AGENT_CONFIG.sentiment_policy, ...configOverride?.sentiment_policy }
        };
        config.risk.max_position_fraction = config.risk.max_position_fraction ?? config.risk.max_position_fraction_per_symbol;
        config.risk.max_position_fraction_per_symbol = config.risk.max_position_fraction_per_symbol ?? config.risk.max_position_fraction;

        const screenerConfig: ScreenerConfig = {
            ...DEFAULT_SCREENER_CONFIG,
            ...configOverride?.screener
        };

        // 1. Build Snapshot
        const snapshot = await this.snapshotBuilder.buildSnapshot(userAddress, isTestnet, config, screenerConfig);
        const snapshotId = await this.persistSnapshot(snapshot);
        if (snapshotId) {
            snapshot.meta.snapshot_id = snapshotId;
        }

        // 2. Optimization: Filter Markets & Early Exit
        const shortlistedMarkets: Record<string, any> = {};
        let hasCandidates = false;

        for (const [key, market] of Object.entries(snapshot.markets)) {
            // Keep if tradeable AND edge_ok
            // OR if we hold a position in it (so LLM can manage it)
            const isHeld = snapshot.account.current_positions.some(p => p.symbol === key);
            const isCandidate = !!market.derived?.risk?.eligible;

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
            const backendDecisions = this.enrichDecisions(result.decisions, snapshot, config);
            decisions = backendDecisions;
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
        let newPositionsCount = 0;

        for (const decision of decisions) {
            try {
                if (decision.target_side === "flat" && (decision.action === "HOLD" || decision.action === "HOLD_POSITION")) {
                    riskAssessments.push({ approved: true, reason: "Hold decision - no trade" });
                    continue; // Skip no-ops
                }

                this.clampDecisionRiskPlan(decision);
                // Risk Check
                const riskAssessment = this.riskModule.assess(decision, snapshot, { newPositionsCount });
                riskAssessments.push(riskAssessment);

                if (!riskAssessment.approved) {
                    console.warn(`⚠️ Risk Rejected ${decision.symbol} (${decision.action} ${decision.target_side || ""}) | Reason: ${riskAssessment.reason || "unknown"} | Playbook: ${decision.playbook} | Confidence: ${decision.confidence}`);
                }

                if (riskAssessment.approved && (decision.action === 'OPEN_POSITION' || (decision.action === 'INCREASE_POSITION' && riskAssessment.modifiedOrder?.clientTag === 'AI_TRADER_INCREASE_NEW'))) {
                    newPositionsCount++;
                }

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

                        const result = await placeOrder(
                            privateKey,
                            {
                                asset: assetIndex,
                                isBuy,
                                limitPx,
                                sz,
                                reduceOnly
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
        const SYSTEM_PROMPT = TRADER_AGENT_SYSTEM_PROMPT;
        const debugContext = snapshot.debug_context ?? process.env.LLM_DEBUG_CONTEXT === "true";
        const llmPayload = this.buildLlmPayload(snapshot, !!debugContext);
        const debugPresets = debugContext ? snapshot.presets : undefined;

        const USER_PROMPT = `SNAPSHOT (minimal schema; use provided fields only):
${JSON.stringify(llmPayload, null, 2)}${debugPresets ? `\n\nDEBUG_PRESETS (for inspection; not for action logic):\n${JSON.stringify(debugPresets, null, 2)}` : ""}`;

        let rawOutput = "";

        try {
            const fail = (message: string) => {
                rawOutput = rawOutput ? `${rawOutput}\n\nERROR: ${message}` : message;
                throw new Error(message);
            };

            console.log(`🤖 Calling LLM with model: ${model}`);

            // Check if we should use OpenRouter
            // If the model string contains "deepseek" or "gpt" or "claude" and we have a client, use it.
            // Or if the user specifically requested an OpenRouter model.
            // For now, let's assume if the model name contains "/" it's likely an OpenRouter model ID (e.g. "deepseek/deepseek-chat-v3-0324:free")
            // OR if we have the client and the model is not a standard local one.

            if (this.openRouterClient && (model.includes("/") || model.startsWith("gpt") || model.startsWith("anthropic"))) {
                console.log("✨ Using OpenRouter via OpenAI SDK");

                let targetModel = model;
                let includeReasoning = false;

                // Check for reasoning suffix
                if (targetModel.endsWith(":reasoning")) {
                    targetModel = targetModel.replace(":reasoning", "");
                    includeReasoning = true;
                    console.log("🧠 Reasoning Mode Enabled via suffix");
                }

                // Also enable for R1 by default if not already
                if (targetModel.includes("r1") || targetModel.includes("reasoner")) {
                    includeReasoning = true;
                }

                const isReasoning = includeReasoning;
                const temperature = isReasoning ? 0.6 : 0.3;

                if (isReasoning) {
                    console.log(`🧠 Reasoning Active for ${targetModel}: Adjusting temperature to 0.6`);
                }

                const completion = await this.openRouterClient.chat.completions.create({
                    model: targetModel,
                    messages: [
                        { role: "system", content: SYSTEM_PROMPT },
                        { role: "user", content: USER_PROMPT }
                    ],
                    temperature: temperature,
                    top_p: 0.9,
                    max_tokens: 8000,
                    // @ts-ignore - signal is supported
                    signal: signal,
                    // @ts-ignore - extra_body for OpenRouter specific params
                    extra_body: includeReasoning ? {
                        include_reasoning: true
                    } : undefined
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
                    console.log(`     Triggers:`, JSON.stringify(market.derived?.triggers));
                    console.log(`     Edge OK: ${market.derived?.edge?.edge_ok}, Cost OK: ${market.derived?.costs?.cost_ok}`);
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
                const validActions = ["OPEN_POSITION", "INCREASE_POSITION", "REDUCE_POSITION", "CLOSE_POSITION", "HOLD_POSITION", "HOLD"];
                if (!validActions.includes(d.action)) {
                    console.warn(`⚠️ Skipping invalid action: ${d.action} for ${d.symbol}`);
                    continue;
                }

                const sizeHint = d.size_hint ?? d.sizeHint;
                const notes = d.notes || (sizeHint ? `size_hint:${sizeHint}` : "");

                decisions.push({
                    action: d.action,
                    symbol: d.symbol,
                    side: d.side ?? null,
                    size_fraction_of_equity: null,
                    target_side: d.target_side ?? d.side ?? null,
                    target_size_fraction_of_equity: null,
                    risk_plan: null,
                    playbook: d.playbook || "none",
                    confidence: d.confidence ?? 0.5,
                    reason_code: d.reason_code || "unknown",
                    notes,
                    audit: d.audit
                });
            }

            // Backend validator: ensure opens are emitted when slots and entry_ok candidates exist
            const killSwitch = snapshot.constraints.kill_switch;
            const maxNewEntries = snapshot.constraints.max_new_entries_allowed ?? snapshot.constraints.max_new_trades_allowed ?? 0;
            const maxIncreases = snapshot.constraints.max_increases_allowed
                ?? snapshot.constraints.max_new_trades_allowed
                ?? snapshot.constraints.max_new_entries_allowed
                ?? 0;

            const entryCandidatesNew = Object.values(snapshot.markets || {})
                .filter(m => m?.derived?.risk?.eligible && m?.derived?.entry?.entry_ok && m?.derived?.liquidity?.tradeable)
                .filter(m => !snapshot.account.current_positions.some(p => p.symbol === m.symbol))
                .sort((a, b) => (a?.derived?.rank ?? Infinity) - (b?.derived?.rank ?? Infinity));

            const entryCandidatesIncrease = Object.values(snapshot.markets || {})
                .filter(m => m?.derived?.risk?.eligible && m?.derived?.entry?.entry_ok && m?.derived?.liquidity?.tradeable)
                .filter(m => snapshot.account.current_positions.some(p => p.symbol === m.symbol))
                .sort((a, b) => (a?.derived?.rank ?? Infinity) - (b?.derived?.rank ?? Infinity));

            const requiredNew = killSwitch ? 0 : Math.min(maxNewEntries, entryCandidatesNew.length);
            const requiredIncreases = killSwitch ? 0 : Math.min(maxIncreases, entryCandidatesIncrease.length);

            const openDecisionsNew = decisions.filter(d => d.action === "OPEN_POSITION");
            const openDecisionsIncrease = decisions.filter(d => d.action === "INCREASE_POSITION");

            if (killSwitch && (openDecisionsNew.length + openDecisionsIncrease.length) > 0) {
                fail(`INVALID: kill_switch is true but ${openDecisionsNew.length + openDecisionsIncrease.length} open/increase actions were returned.`);
            }

            if (!killSwitch && requiredNew === 0 && openDecisionsNew.length > 0) {
                fail(`INVALID: max_new_entries_allowed is 0 but ${openDecisionsNew.length} open actions were returned.`);
            }

            if (!killSwitch && requiredIncreases === 0 && openDecisionsIncrease.length > 0 && maxIncreases === 0) {
                fail(`INVALID: max_increases_allowed is 0 but ${openDecisionsIncrease.length} increase actions were returned.`);
            }

            // Autofill missing required opens/increases to avoid hard failures
            const minConfidence = (snapshot as any)?.policy?.min_confidence ?? this.computeMinConfidence(snapshot.global_regime?.current);
            const buildDecision = (symbol: string, playbook: string, action: "OPEN_POSITION" | "INCREASE_POSITION") => {
                const side = this.inferSideFromPlaybook(playbook);
                if (!side) return null;
                return {
                    action,
                    symbol,
                    side,
                    target_side: side,
                    playbook,
                    confidence: minConfidence,
                    reason_code: "liquidity_grab",
                    notes: ""
                } as TradeDecision;
            };

            const pickPlaybook = (eligiblePlaybooks: string[]) => eligiblePlaybooks && eligiblePlaybooks.length > 0 ? eligiblePlaybooks[0] : null;

            while (openDecisionsNew.length < requiredNew) {
                const candidate = entryCandidatesNew[openDecisionsNew.length];
                if (!candidate) break;
                const playbook = pickPlaybook(candidate?.derived?.risk?.eligible_playbooks ?? []);
                if (!playbook) break;
                const decision = buildDecision(candidate.symbol, playbook, "OPEN_POSITION");
                if (decision) openDecisionsNew.push(decision); else break;
            }

            while (openDecisionsIncrease.length < requiredIncreases) {
                const candidate = entryCandidatesIncrease[openDecisionsIncrease.length];
                if (!candidate) break;
                const playbook = pickPlaybook(candidate?.derived?.risk?.eligible_playbooks ?? []);
                if (!playbook) break;
                const decision = buildDecision(candidate.symbol, playbook, "INCREASE_POSITION");
                if (decision) openDecisionsIncrease.push(decision); else break;
            }

            if (requiredNew > 0 && openDecisionsNew.length < requiredNew) {
                const topSymbol = entryCandidatesNew[openDecisionsNew.length]?.symbol || entryCandidatesNew[0]?.symbol || "unknown";
                fail(`INVALID: required ${requiredNew} OPEN_POSITION actions (slots=${maxNewEntries}, entry_ok_new=${entryCandidatesNew.length}) but only ${openDecisionsNew.length} provided. Next candidate: ${topSymbol}.`);
            }

            if (requiredIncreases > 0 && openDecisionsIncrease.length < requiredIncreases) {
                const topSymbol = entryCandidatesIncrease[openDecisionsIncrease.length]?.symbol || entryCandidatesIncrease[0]?.symbol || "unknown";
                fail(`INVALID: required ${requiredIncreases} INCREASE_POSITION actions (limit=${maxIncreases}, entry_ok_existing=${entryCandidatesIncrease.length}) but only ${openDecisionsIncrease.length} provided. Next candidate: ${topSymbol}.`);
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

    private buildLlmPayload(snapshot: StateSnapshot, debugContext: boolean) {
        const openPositions = (snapshot.account.current_positions || []).map(p => ({
            symbol: p.symbol,
            side: p.side,
            size_usd: p.size_usd,
            fraction_of_equity: p.fraction_of_equity,
            entry_price: p.entry_price,
            leverage: p.leverage,
            position_age_min: (p as any).position_age_min ?? null,
            playbook_when_opened: (p as any).playbook_when_opened ?? null,
            llm_reason_when_opened: (p as any).llm_reason_when_opened ?? null
        }));

        const symbols = Object.entries(snapshot.markets || {}).map(([symbol, market]) => {
            const position = snapshot.account.current_positions.find(p => p.symbol === symbol);
            const bookPressure = market.orderbook?.book_pressure;

            return {
                symbol: market.symbol || symbol,
                news_blocked: market.news_blocked ?? false,
                derived: {
                    rank: market.derived?.rank ?? null,
                    entry: {
                        entry_ok: !!market.derived?.entry?.entry_ok,
                        edge_to_cost_mult: market.derived?.entry?.edge_to_cost_mult ?? null,
                        entry_score: market.derived?.entry?.entry_score ?? null,
                        confidence_hint: (market.derived?.entry as any)?.confidence_hint ?? null,
                        reasons_failed: market.derived?.entry?.reasons_failed ?? []
                    },
                    risk: {
                        eligible: !!market.derived?.risk?.eligible,
                        eligible_playbooks: market.derived?.risk?.eligible_playbooks ?? []
                    },
                    liquidity: {
                        tradeable: !!market.derived?.liquidity?.tradeable
                    },
                    orderbook: bookPressure === undefined ? undefined : { book_pressure: bookPressure }
                },
                position_state: {
                    has_position: !!position,
                    position_side: position?.side ?? null,
                    pnl_unrealized_usd: position?.unrealized_pnl ?? null,
                    position_age_min: (position as any)?.position_age_min ?? null
                }
            };
        }).sort((a, b) => {
            const rankA = a.derived?.rank ?? Infinity;
            const rankB = b.derived?.rank ?? Infinity;
            return rankA - rankB;
        });

        const maxNewEntries = snapshot.constraints.max_new_entries_allowed ?? snapshot.constraints.max_new_trades_allowed ?? 0;
        const maxIncreases = snapshot.constraints.max_increases_allowed
            ?? snapshot.constraints.max_new_trades_allowed
            ?? snapshot.constraints.max_new_entries_allowed
            ?? 0;
        const minConfidence = (snapshot as any)?.policy?.min_confidence ?? this.computeMinConfidence(snapshot.global_regime?.current);

        return {
            debug_context: debugContext,
            snapshot: {
                snapshot_id: snapshot.meta?.snapshot_id ?? null,
                timestamp: snapshot.timestamp,
                global_regime: { current: snapshot.global_regime?.current },
                constraints: {
                    max_new_entries_allowed: maxNewEntries,
                    max_increases_allowed: maxIncreases
                },
                veto: {
                    kill_switch: snapshot.constraints.kill_switch ?? false,
                    risk_reduction_priority: (snapshot as any)?.veto?.risk_reduction_priority ?? false
                },
                policy: {
                    min_confidence: minConfidence
                },
                open_positions: openPositions,
                symbols
            }
        };
    }

    private enrichDecisions(decisions: TradeDecision[], snapshot: StateSnapshot, config: AgentConfig): TradeDecision[] {
        const maxNewTrades = snapshot.constraints.max_new_trades_allowed ?? snapshot.constraints.max_new_positions_per_cycle;
        const heldSymbols = new Set((snapshot.account.current_positions || []).map(p => p.symbol));
        let newTradeCount = 0;

        return decisions.flatMap(decision => {
            const symbol = decision.symbol;
            if (!symbol) return [];
            const market = snapshot.markets[symbol];
            if (!market) return [];

            const inferredSide = decision.target_side ?? decision.side ?? this.inferSideFromPlaybook(decision.playbook);
            const normalizedDecision: TradeDecision = {
                ...decision,
                target_side: inferredSide,
                side: inferredSide === "flat" ? null : inferredSide
            };
            if (!normalizedDecision.target_side && (decision.action === "CLOSE_POSITION" || decision.action === "HOLD_POSITION")) {
                normalizedDecision.target_side = "flat";
                normalizedDecision.side = null;
            }

            const isNewPosition = !heldSymbols.has(symbol);
            const riskInfo = market.derived?.risk;
            const currentPosition = snapshot.account.current_positions.find(p => p.symbol === symbol);
            const effectiveLeverage = currentPosition?.leverage && currentPosition.leverage > 0
                ? currentPosition.leverage
                : (config.risk.default_leverage ?? 1);

            if (decision.action === "OPEN_POSITION" || decision.action === "INCREASE_POSITION") {
                if (!normalizedDecision.target_side || normalizedDecision.target_side === "flat") return [];
                if (isNewPosition && riskInfo && !riskInfo.eligible) return [];
                if (riskInfo?.eligible_playbooks?.length && !this.isPlaybookAllowed(decision.playbook, riskInfo.eligible_playbooks)) return [];
                if (isNewPosition && maxNewTrades !== undefined && newTradeCount >= maxNewTrades) return [];

                const sizeFraction = this.computeSizeFraction(decision.confidence ?? 0, config, snapshot.account.equity_usd);
                if (sizeFraction === null) return [];

                const riskPlan = this.computeRiskPlan(decision.playbook, market, config, snapshot.global_regime.current, effectiveLeverage);
                if (!riskPlan) return [];

                const enriched: TradeDecision = {
                    ...normalizedDecision,
                    target_size_fraction_of_equity: sizeFraction,
                    size_fraction_of_equity: sizeFraction,
                    risk_plan: riskPlan,
                    audit: this.buildAudit(market, snapshot, riskPlan, sizeFraction)
                };

                if (isNewPosition) newTradeCount += 1;
                return [enriched];
            }

            if (decision.action === "CLOSE_POSITION" || decision.action === "REDUCE_POSITION") {
                const targetSize = decision.action === "CLOSE_POSITION" ? 0 : decision.target_size_fraction_of_equity ?? null;
                const enriched: TradeDecision = {
                    ...normalizedDecision,
                    target_size_fraction_of_equity: targetSize,
                    size_fraction_of_equity: normalizedDecision.size_fraction_of_equity ?? targetSize,
                    audit: this.buildAudit(market, snapshot, normalizedDecision.risk_plan, targetSize)
                };
                return [enriched];
            }

            const audit = this.buildAudit(market, snapshot, normalizedDecision.risk_plan, normalizedDecision.target_size_fraction_of_equity ?? null);
            return [{ ...normalizedDecision, audit }];
        });
    }

    private inferSideFromPlaybook(playbook: string): "long" | "short" | null {
        const lower = (playbook || "").toLowerCase();
        if (lower.includes("short")) return "short";
        if (lower.includes("long")) return "long";
        return null;
    }

    private isPlaybookAllowed(playbook: string, eligiblePlaybooks: string[]): boolean {
        if (!eligiblePlaybooks || eligiblePlaybooks.length === 0) return true;
        const normalized = (playbook || "").toLowerCase().trim();
        return eligiblePlaybooks.some(p => p.toLowerCase().trim() === normalized);
    }

    private computeMinConfidence(regime: string | undefined) {
        const base = 0.3;
        if (regime === "CHOP") return parseFloat((base * 1.2).toFixed(4));
        return base;
    }

    /**
     * Computes a size as a fraction of equity using confidence buckets, then clamps to per-trade and per-symbol caps.
     */
    private computeSizeFraction(confidence: number, config: AgentConfig, equity: number): number | null {
        if (!equity || equity <= 0) return null;

        // New sizing: absolute USD target = 10 * (1 + risk_factor)
        const riskFactor = Math.max(0, Math.min(1, confidence ?? 0));
        const targetUsd = 10 * (1 + riskFactor);

        const perTradeCap = config.risk.max_position_fraction ?? config.risk.max_position_fraction_per_symbol ?? 0;
        const perSymbolCap = config.risk.max_position_fraction_per_symbol ?? perTradeCap;
        const usableCap = perTradeCap > 0 ? Math.min(perTradeCap, perSymbolCap) : perSymbolCap;
        if (usableCap <= 0) return null;

        const targetFraction = targetUsd / equity;
        return Math.min(targetFraction, usableCap);
    }

    private computeRiskPlan(playbook: string, market: MarketEntry, config: AgentConfig, regime: GlobalRegime["current"], leverage: number) {
        const anchor = this.resolveAnchor(market, config);
        if (!anchor.value || anchor.value <= 0) return null;

        const basePlaybook = (playbook || "").split(":")[0]?.trim() || "Discretionary Edge";
        const multipliers = config.risk_plan_model.multipliers_by_playbook?.[basePlaybook] || { sl_mult: 1, tp_mult: 2 };
        const regimeAdj = config.risk_plan_model.regime_adjustments?.[regime] || { sl_mult_factor: 1, tp_mult_factor: 1 };
        const amplification = 1.5; // push both SL and TP wider; agent can exit on next tick if needed
        const lev = Math.max(1, leverage || 1);

        const stop_loss_pct = anchor.value * (multipliers.sl_mult ?? 1) * (regimeAdj.sl_mult_factor ?? 1) * amplification * lev;
        const take_profit_pct_primary = anchor.value * (multipliers.tp_mult ?? 2) * (regimeAdj.tp_mult_factor ?? 1) * amplification * lev;

        return { stop_loss_pct, take_profit_pct_primary };
    }

    private resolveAnchor(market: MarketEntry, config: AgentConfig): { key: string | null, value: number | null } {
        if (market.derived?.risk?.best_anchor_key && market.derived.risk.best_anchor_value !== null && market.derived.risk.best_anchor_value !== undefined) {
            return { key: market.derived.risk.best_anchor_key, value: market.derived.risk.best_anchor_value };
        }

        for (const key of config.risk_plan_model.vol_anchor_priority) {
            const value = this.getValueByPath(market as any, key);
            if (value === null) continue;
            const normalizedValue = key.includes("bps") ? value / 10000 : value;
            return { key, value: normalizedValue };
        }

        return { key: null, value: null };
    }

    private getValueByPath(obj: any, path: string): number | null {
        const parts = path.split(".");
        let current: any = obj;
        for (const part of parts) {
            if (current && Object.prototype.hasOwnProperty.call(current, part)) {
                current = current[part];
            } else {
                return null;
            }
        }
        if (typeof current !== "number" || Number.isNaN(current)) return null;
        return current;
    }

    private buildAudit(
        market: MarketEntry,
        snapshot: StateSnapshot,
        riskPlan: { stop_loss_pct: number; take_profit_pct_primary: number } | null,
        sizeFraction: number | null
    ): TradeDecision["audit"] {
        const depthBands = market.orderbook?.depth_bands_usd;
        const depthFromBands = depthBands
            ? depthBands.bid?.["0.25"] ?? depthBands.ask?.["0.25"] ?? depthBands.bid?.["0.10"] ?? depthBands.ask?.["0.10"]
            : undefined;
        const depth = depthFromBands ?? market.derived?.liquidity?.min_depth_usd ?? null;

        return {
            spread_bps: market.spread_bps ?? null,
            cost_bps: market.derived?.costs?.cost_bps ?? null,
            edge_bps: market.derived?.edge?.edge_bps ?? null,
            book_pressure: market.orderbook?.book_pressure ?? null,
            depth_usd: depth,
            vol_ratio_5m_vs_1h: market.derived?.normalized?.vol_ratio_5m_vs_1h ?? null,
            ret_sigma_5m_vs_1h: market.derived?.normalized?.ret_sigma_5m_vs_1h ?? null,
            anchor_key: market.derived?.risk?.best_anchor_key ?? null,
            anchor_value: market.derived?.risk?.best_anchor_value ?? null,
            regime: snapshot.global_regime?.current,
            computed_stop_loss_pct: riskPlan?.stop_loss_pct ?? null,
            computed_take_profit_pct_primary: riskPlan?.take_profit_pct_primary ?? null,
            computed_size_fraction_of_equity: sizeFraction ?? null
        };
    }

    private async persistSnapshot(snapshot: StateSnapshot): Promise<number | null> {
        try {
            const saved = await prisma.marketStateSnapshot.create({
                data: { data: JSON.stringify(snapshot) }
            });

            // Update stored snapshot with its own id for traceability
            try {
                const snapshotWithId = { ...snapshot, meta: { ...snapshot.meta, snapshot_id: saved.id } };
                await prisma.marketStateSnapshot.update({
                    where: { id: saved.id },
                    data: { data: JSON.stringify(snapshotWithId) }
                });
            } catch (updateError) {
                console.warn("⚠️ Unable to backfill snapshot_id into stored snapshot:", updateError);
            }

            return saved.id;
        } catch (error) {
            console.error("❌ Failed to persist snapshot:", error);
            return null;
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

    /**
     * Clamp stop loss to the allowed bounds before sending to risk manager.
     */
    private clampDecisionRiskPlan(decision: TradeDecision) {
        if (!decision.risk_plan) return;
        const minSl = 0.005; // 0.5% of equity
        const maxSl = 0.05;  // 5% of equity
        const minTp = 0.01;  // 1% target floor to avoid tiny profits
        const minRr = 1.5;

        const sl = decision.risk_plan.stop_loss_pct;
        if (sl === undefined || sl === null) return;
        const clampedSl = Math.min(maxSl, Math.max(minSl, Math.abs(sl)));
        decision.risk_plan.stop_loss_pct = clampedSl;

        const tp = decision.risk_plan.take_profit_pct_primary;
        const floorTp = Math.max(minTp, minRr * clampedSl);
        if (tp === undefined || tp === null || tp < floorTp) {
            decision.risk_plan.take_profit_pct_primary = floorTp;
        }
    }
}
