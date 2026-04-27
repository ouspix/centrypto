import { SnapshotBuilder, StateSnapshot } from "./SnapshotBuilder";
import { MarketEntry, GlobalRegime } from "@/types/snapshot";
import { CandidateJournalStatus, EligibleCandidate, ManagedPosition, TraderContext, TraderDecision, TradeDecision, RiskAssessment } from "@/types/trading";
import { RiskCheckModule } from "@/lib/risk/RiskCheckModule";
import {
    computeSizeFraction,
    clampRiskPlan,
    resolveAnchor,
    computeRiskPlan,
    computeMinConfidence,
    inferSideFromPlaybook,
    isPlaybookAllowed,
} from "@/lib/risk/shared";
import { parseTraderResponse } from "@/lib/llm/LlmResponseParser";
import { ExecutionEngine } from "@/lib/hyperliquidExecution";
import { placeOrder, updateLeverage } from "@/lib/hyperliquid";
import { TradingLogger } from "@/lib/log/tradingLogger";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";
import { prisma } from "@/lib/db";
import { promises as fs } from "fs";
import { TraderContextBuilder } from "@/services/TraderContextBuilder";
import { TraderDecisionValidator } from "@/lib/trader/TraderDecisionValidator";

import OpenAI from "openai";

import { TRADER_AGENT_SYSTEM_PROMPT } from "@/prompts/TraderAgent";

export class OrchestratorService {
    private static instance: OrchestratorService;
    private ollamaUrl: string;
    private openRouterClient: OpenAI | null = null;
    private snapshotBuilder: SnapshotBuilder;
    private traderContextBuilder: TraderContextBuilder;
    private traderDecisionValidator: TraderDecisionValidator;
    private riskModule: RiskCheckModule;
    private executionEngine: ExecutionEngine;
    private logger: TradingLogger;
    private currentAbortController: AbortController | null = null;
    private activeJobs: Map<string, AbortController> = new Map();

    public constructor() {
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
        this.traderContextBuilder = new TraderContextBuilder();
        this.traderDecisionValidator = new TraderDecisionValidator();
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

            if (controller.signal.aborted) throw new Error('Aborted');
            const finalResult = await this.runTraderCycle(userAddress, false, model, isTestnet, configOverride, controller.signal);

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
        this.currentAbortController = new AbortController();
        try {
            return await this.runTraderCycle(userAddress, autoTrading, model, isTestnet, configOverride, this.currentAbortController.signal);
        } finally {
            this.currentAbortController = null;
        }
    }

    private async runTraderCycle(
        userAddress: string | null,
        autoTrading: boolean,
        model: string,
        isTestnet: boolean,
        configOverride?: any,
        signal?: AbortSignal
    ): Promise<{ decisions: TradeDecision[], riskAssessments: RiskAssessment[], snapshot: StateSnapshot, prompt: string, rawOutput: string }> {
        const { config, screenerConfig } = this.mergeConfig(configOverride);
        if (signal?.aborted) throw new Error("Aborted");
        if (autoTrading && config.preset_live_mode === "limited_manual") {
            return {
                decisions: [],
                riskAssessments: [{ approved: false, reason: `${config.preset_name || "Preset"} is manual-only for v1` }],
                snapshot: await this.snapshotBuilder.buildSnapshot(userAddress, isTestnet, config, screenerConfig),
                prompt: "SKIPPED",
                rawOutput: "SKIPPED"
            };
        }
        if (autoTrading && config.preset_live_mode === "non_live" && !isTestnet) {
            return {
                decisions: [],
                riskAssessments: [{ approved: false, reason: `${config.preset_name || "Preset"} is non-live and cannot execute on mainnet` }],
                snapshot: await this.snapshotBuilder.buildSnapshot(userAddress, isTestnet, config, screenerConfig),
                prompt: "SKIPPED",
                rawOutput: "SKIPPED"
            };
        }

        const snapshot = await this.snapshotBuilder.buildSnapshot(userAddress, isTestnet, config, screenerConfig);
        const snapshotId = await this.persistSnapshot(snapshot);
        if (snapshotId) snapshot.meta.snapshot_id = snapshotId;

        const profile = this.resolveProfileName(configOverride);
        const { context } = await this.traderContextBuilder.build(snapshot, config, isTestnet, profile);
        const hasWork = context.eligible_candidates.length > 0 || context.existing_positions.length > 0;

        if (!hasWork) {
            console.log("💤 Early Exit: No eligible candidates and no positions to manage. Skipping LLM.");
            return { decisions: [], riskAssessments: [], snapshot, prompt: "SKIPPED", rawOutput: "SKIPPED" };
        }

        console.log(`✨ Trader context: ${context.eligible_candidates.length} candidates, ${context.existing_positions.length} positions.`);
        if (signal?.aborted) throw new Error("Aborted");

        const llmResult = await this.getLLMDecision(context, model, signal);
        const validation = this.traderDecisionValidator.validateBatch(llmResult.decisions, context);

        if (!validation.accepted) {
            const invalidDecisions = this.buildBackendDecisions(llmResult.decisions, context, validation.reason);
            await this.saveLlmInteraction(llmResult.prompt, llmResult.rawOutput, invalidDecisions, isTestnet);
            await this.journalTraderContext(context, llmResult.decisions, validation, new Map());
            return {
                decisions: [],
                riskAssessments: [{ approved: false, reason: `Validator rejected batch: ${validation.reason}` }],
                snapshot,
                prompt: llmResult.prompt,
                rawOutput: llmResult.rawOutput
            };
        }

        const decisions = this.buildBackendDecisions(llmResult.decisions, context, "accepted");
        await this.saveLlmInteraction(llmResult.prompt, llmResult.rawOutput, decisions, isTestnet);

        const riskAssessments: RiskAssessment[] = [];
        const executionResults = new Map<string, { attempted: boolean; success: boolean; error?: string }>();
        let newPositionsCount = 0;

        for (const decision of decisions) {
            if (decision.action === "SKIP" || decision.action === "HOLD_POSITION" || decision.action === "HOLD") {
                riskAssessments.push({ approved: true, reason: "No trade proposed" });
                continue;
            }

            const riskAssessment = this.riskModule.assess(decision, snapshot, { newPositionsCount });
            riskAssessments.push(riskAssessment);

            if (riskAssessment.approved && decision.action === "OPEN_POSITION") {
                newPositionsCount++;
            }

            let executionResult: any = null;
            if (autoTrading && riskAssessment.approved && riskAssessment.modifiedOrder) {
                executionResult = await this.executeApprovedDecision(decision, riskAssessment, snapshot, config, isTestnet);
                const key = decision.candidate_id ?? decision.symbol ?? "";
                executionResults.set(key, {
                    attempted: true,
                    success: !!executionResult?.success,
                    error: executionResult?.error
                });
            } else if (riskAssessment.modifiedOrder) {
                const key = decision.candidate_id ?? decision.symbol ?? "";
                executionResults.set(key, { attempted: false, success: false });
            }

            await this.logger.logDecision({
                timestamp: new Date().toISOString(),
                snapshot: snapshot.meta?.snapshot_id?.toString() || "UNKNOWN",
                decision,
                riskAssessment,
                executionResult
            });
        }

        await this.journalTraderContext(context, llmResult.decisions, validation, executionResults);
        return { decisions, riskAssessments, snapshot, prompt: llmResult.prompt, rawOutput: llmResult.rawOutput };
    }

    private buildBackendDecisions(traderDecisions: TraderDecision[], context: TraderContext, validatorReason: string): TradeDecision[] {
        return traderDecisions.map(decision => {
            if (decision.scope === "candidate") {
                const candidate = context.eligible_candidates.find(c => c.candidate_id === decision.candidate_id);
                const side = decision.target_side === "flat" ? null : decision.target_side;

                return {
                    scope: decision.scope,
                    candidate_id: decision.candidate_id,
                    action: decision.action,
                    symbol: decision.symbol || candidate?.symbol || null,
                    side,
                    target_side: decision.target_side,
                    target_size_fraction_of_equity: decision.target_size_fraction_of_equity,
                    size_fraction_of_equity: decision.target_size_fraction_of_equity,
                    risk_plan: decision.action === "OPEN_POSITION" && candidate ? {
                        stop_loss_pct: candidate.risk.stop_loss_pct,
                        take_profit_pct_primary: candidate.risk.take_profit_pct_primary
                    } : null,
                    playbook: decision.playbook || candidate?.eligible_playbooks[0] || "none",
                    confidence: decision.confidence,
                    reason_code: decision.reason_code,
                    notes: decision.notes,
                    audit: candidate ? {
                        candidate_id: candidate.candidate_id,
                        cost_bps: candidate.market_quality.cost_bps,
                        edge_bps: candidate.market_quality.edge_bps,
                        book_pressure: candidate.market_quality.book_pressure,
                        depth_usd: candidate.market_quality.min_depth_usd,
                        vol_ratio_5m_vs_1h: candidate.market_quality.vol_ratio_5m_vs_1h,
                        ret_sigma_5m_vs_1h: candidate.market_quality.ret_sigma_5m_vs_1h,
                        computed_stop_loss_pct: candidate.risk.stop_loss_pct,
                        computed_take_profit_pct_primary: candidate.risk.take_profit_pct_primary,
                        computed_size_fraction_of_equity: decision.target_size_fraction_of_equity,
                        max_allowed_size_fraction: candidate.sizing.max_allowed_size_fraction,
                        suggested_size_fraction: candidate.sizing.suggested_size_fraction,
                        validator_status: validatorReason === "accepted" ? "accepted" : "rejected",
                        validator_reason: validatorReason
                    } : {
                        validator_status: "rejected",
                        validator_reason: validatorReason
                    }
                };
            }

            const position = context.existing_positions.find(p => p.symbol === decision.symbol);
            const targetSide = decision.action === "CLOSE_POSITION" ? "flat" : decision.target_side;
            return {
                scope: decision.scope,
                candidate_id: null,
                action: decision.action,
                symbol: decision.symbol,
                side: targetSide === "flat" ? null : targetSide,
                target_side: targetSide,
                target_size_fraction_of_equity: decision.target_size_fraction_of_equity,
                size_fraction_of_equity: decision.target_size_fraction_of_equity,
                risk_plan: null,
                playbook: decision.playbook || "none",
                confidence: decision.confidence,
                reason_code: decision.reason_code,
                notes: decision.notes,
                audit: {
                    validator_status: validatorReason === "accepted" ? "accepted" : "rejected",
                    validator_reason: validatorReason,
                    computed_size_fraction_of_equity: decision.target_size_fraction_of_equity,
                    candidate_id: null,
                    book_pressure: position?.market_signal.book_pressure ?? null,
                    vol_ratio_5m_vs_1h: position?.market_signal.vol_ratio_5m_vs_1h ?? null,
                    ret_sigma_5m_vs_1h: position?.market_signal.ret_sigma_5m_vs_1h ?? null
                }
            };
        });
    }

    private async executeApprovedDecision(
        decision: TradeDecision,
        riskAssessment: RiskAssessment,
        snapshot: StateSnapshot,
        config: AgentConfig,
        isTestnet: boolean
    ) {
        const marketData = decision.symbol ? snapshot.markets[decision.symbol] : undefined;
        const assetIndex = marketData?.assetIndex;
        if (assetIndex === undefined || !riskAssessment.modifiedOrder || !marketData) {
            return { success: false, status: "failed", error: "Asset index or order missing" };
        }

        const privateKey = isTestnet
            ? process.env.HYPERLIQUID_TESTNET_PRIVATE_KEY
            : process.env.HYPERLIQUID_PRIVATE_KEY;
        if (!privateKey) return { success: false, status: "failed", error: "Private key not found in env" };

        try {
            const currentPrice = marketData.price || 0;
            const isBuy = riskAssessment.modifiedOrder.side === "buy";
            const sz = riskAssessment.modifiedOrder.sizeUsd / currentPrice;
            const reduceOnly = decision.action === "CLOSE_POSITION" || decision.action === "REDUCE_POSITION";
            const slippage = config.risk.slippage_pct ?? 0.003;
            const limitPx = isBuy ? currentPrice * (1 + slippage) : currentPrice * (1 - slippage);

            if (!reduceOnly && decision.action === "OPEN_POSITION") {
                await updateLeverage(
                    privateKey,
                    {
                        asset: assetIndex,
                        isCross: config.risk.margin_mode !== "isolated",
                        leverage: config.risk.exchange_max_leverage_allowed
                    },
                    isTestnet
                );
            }

            let stopLossPrice: number | undefined;
            let takeProfitPrice: number | undefined;
            if (!reduceOnly && decision.risk_plan) {
                const slPct = Math.abs(decision.risk_plan.stop_loss_pct);
                const tpPct = Math.abs(decision.risk_plan.take_profit_pct_primary);
                stopLossPrice = isBuy ? currentPrice * (1 - slPct) : currentPrice * (1 + slPct);
                takeProfitPrice = isBuy ? currentPrice * (1 + tpPct) : currentPrice * (1 - tpPct);
            }

            const result = await placeOrder(
                privateKey,
                {
                    asset: assetIndex,
                    isBuy,
                    limitPx,
                    sz,
                    reduceOnly,
                    stopLossPrice,
                    takeProfitPrice,
                    tif: reduceOnly ? "Ioc" : "Ioc"
                },
                isTestnet
            );

            if (result.status === "ok") {
                await new Promise(resolve => setTimeout(resolve, 500));
                return {
                    success: true,
                    status: "submitted",
                    orderId: result.response?.data?.statuses?.[0]?.oid?.toString()
                };
            }

            return { success: false, status: "failed", error: JSON.stringify(result.response) };
        } catch (error: any) {
            console.error("❌ Auto-Trading Execution Failed:", error);
            return { success: false, status: "error", error: error.message || String(error) };
        }
    }

    private async journalTraderContext(
        context: TraderContext,
        traderDecisions: TraderDecision[],
        validation: { accepted: boolean; reason: string },
        executionResults: Map<string, { attempted: boolean; success: boolean; error?: string }>
    ) {
        const rows: any[] = [];

        for (const candidate of context.eligible_candidates) {
            const decision = traderDecisions.find(d => d.scope === "candidate" && d.candidate_id === candidate.candidate_id);
            const execution = executionResults.get(candidate.candidate_id);
            rows.push({
                snapshotId: context.snapshot_id,
                timestamp: context.timestamp,
                profile: context.profile,
                regime: context.global_regime,
                candidateId: candidate.candidate_id,
                symbol: candidate.symbol,
                side: candidate.side,
                playbook: candidate.eligible_playbooks[0],
                scope: "candidate",
                status: this.resolveCandidateJournalStatus(decision, validation, execution),
                llmAction: decision?.action ?? null,
                llmConfidence: decision?.confidence ?? null,
                llmNotes: decision?.notes ?? null,
                validatorStatus: validation.accepted ? "accepted" : "rejected",
                validatorReason: validation.reason,
                executed: !!execution?.success,
                metadataJson: JSON.stringify(candidate)
            });
        }

        for (const position of context.existing_positions) {
            const decision = traderDecisions.find(d => d.scope === "position" && d.symbol === position.symbol);
            rows.push({
                snapshotId: context.snapshot_id,
                timestamp: context.timestamp,
                profile: context.profile,
                regime: context.global_regime,
                candidateId: null,
                symbol: position.symbol,
                side: position.side,
                playbook: null,
                scope: "position",
                status: "managed_position",
                llmAction: decision?.action ?? null,
                llmConfidence: decision?.confidence ?? null,
                llmNotes: decision?.notes ?? null,
                validatorStatus: validation.accepted ? "accepted" : "rejected",
                validatorReason: validation.reason,
                executed: false,
                metadataJson: JSON.stringify(position)
            });
        }

        if (rows.length === 0) return;

        try {
            const candidateJournal = (prisma as any).candidateJournal;
            if (!candidateJournal?.createMany) return;
            await candidateJournal.createMany({ data: rows });
        } catch (error) {
            console.warn("⚠️ Failed to write candidate journal:", error);
        }
    }

    private resolveCandidateJournalStatus(
        decision: TraderDecision | undefined,
        validation: { accepted: boolean; reason: string },
        execution?: { attempted: boolean; success: boolean; error?: string }
    ): CandidateJournalStatus {
        if (!decision) return "no_llm_decision";
        if (!validation.accepted && decision.action === "OPEN_POSITION") return "llm_approved_but_validator_rejected";
        if (decision.action === "SKIP") return "eligible_but_llm_skipped";
        if (execution?.success) return "executed";
        if (execution?.attempted && !execution.success) return "validator_accepted_but_execution_failed";
        return "validator_accepted";
    }

    private resolveProfileName(configOverride?: any): string {
        return configOverride?.profileName || configOverride?.preset || configOverride?.name || "active";
    }

    private async getLLMDecision(context: TraderContext, model: string, signal?: AbortSignal): Promise<{ decisions: TraderDecision[], prompt: string, rawOutput: string }> {
        const SYSTEM_PROMPT = TRADER_AGENT_SYSTEM_PROMPT;
        const USER_PROMPT = `TRADER_CONTEXT (backend-precomputed; use provided fields only):
${JSON.stringify(context, null, 2)}`;

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

                if (!response.body?.getReader && typeof (response as any).json === "function") {
                    const json = await (response as any).json();
                    rawOutput = typeof json?.response === "string" ? json.response : JSON.stringify(json);
                } else {
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
            }

            console.log("🔍 Trader Context Debug:");
            console.log("   Global Regime:", context.global_regime);
            console.log("   Eligible Candidates:", context.eligible_candidates.length);
            console.log("   Existing Positions:", context.existing_positions.length);

            console.log("📦 Raw LLM Response (first 300 chars):", rawOutput.substring(0, 300));
            if (process.env.LLM_DEBUG_LOG === "true") {
                fs.appendFile('debug_llm_response.log', `\n\n--- ${new Date().toISOString()} ---\nPrompt:\n${USER_PROMPT}\n\nResponse:\n${rawOutput}\n-----------------------------------\n`).catch(e => console.warn('⚠️ Debug log write failed:', e));
            }
            console.log("🔍 Debug: rawOutput length:", rawOutput.length);
            const decisions = parseTraderResponse(rawOutput);
            return { decisions, prompt: SYSTEM_PROMPT + "\n\n" + USER_PROMPT, rawOutput };

        } catch (error) {
            console.error("❌ LLM Decision Error:", error);
            return {
                decisions: [],
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
                price: market.price,
                news_blocked: market.news_blocked ?? false,
                derived: {
                    rank: market.derived?.rank ?? null,
                    costs: market.derived?.costs ? {
                        cost_bps: market.derived.costs.cost_bps,
                        cost_ok: !!market.derived.costs.cost_ok
                    } : undefined,
                    edge: market.derived?.edge ? {
                        expected_move_bps: market.derived.edge.expected_move_bps,
                        edge_bps: market.derived.edge.edge_bps,
                        edge_ok: !!market.derived.edge.edge_ok
                    } : undefined,
                    entry: {
                        entry_ok: !!market.derived?.entry?.entry_ok,
                        edge_to_cost_mult: market.derived?.entry?.edge_to_cost_mult ?? null,
                        entry_score: market.derived?.entry?.entry_score ?? null,
                        confidence_hint: (market.derived?.entry as any)?.confidence_hint ?? null,
                        reasons_failed: market.derived?.entry?.reasons_failed ?? []
                    },
                    triggers: market.derived?.triggers ? {
                        momentum_ok_long: !!market.derived.triggers.momentum_ok_long,
                        momentum_ok_short: !!market.derived.triggers.momentum_ok_short,
                        mr_ok_long: !!market.derived.triggers.mr_ok_long,
                        mr_ok_short: !!market.derived.triggers.mr_ok_short,
                        breakout_ok: !!market.derived.triggers.breakout_ok,
                        trend_aligned: !!market.derived.triggers.trend_aligned
                    } : undefined,
                    liquidity: {
                        tradeable: !!market.derived?.liquidity?.tradeable,
                        min_depth_usd: market.derived?.liquidity?.min_depth_usd
                    },
                    normalized: market.derived?.normalized ? {
                        ret_sigma_5m_vs_1h: market.derived.normalized.ret_sigma_5m_vs_1h,
                        vol_ratio_5m_vs_1h: market.derived.normalized.vol_ratio_5m_vs_1h
                    } : undefined,
                    orderbook: bookPressure === undefined ? undefined : { book_pressure: bookPressure },
                    risk: {
                        eligible: !!market.derived?.risk?.eligible,
                        eligible_playbooks: market.derived?.risk?.eligible_playbooks ?? [],
                        best_anchor_key: market.derived?.risk?.best_anchor_key,
                        best_anchor_value: market.derived?.risk?.best_anchor_value
                    }
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
                    kill_switch: snapshot.constraints.kill_switch ?? false,
                    max_total_exposure_pct_equity: snapshot.constraints.max_total_exposure_pct_equity,
                    max_position_pct_equity: snapshot.constraints.max_position_pct_equity,
                    max_position_pct_equity_per_symbol: snapshot.constraints.max_position_pct_equity_per_symbol,
                    min_trade_notional_usd: snapshot.constraints.min_trade_notional_usd,
                    max_new_positions_per_cycle: snapshot.constraints.max_new_positions_per_cycle,
                    max_new_trades_allowed: snapshot.constraints.max_new_trades_allowed,
                    max_new_entries_allowed: maxNewEntries,
                    max_increases_allowed: maxIncreases,
                    no_flip_same_tick: snapshot.constraints.no_flip_same_tick
                },
                veto: {
                    risk_reduction_priority: (snapshot as any)?.veto?.risk_reduction_priority ?? false
                },
                policy: {
                    min_confidence: minConfidence
                },
                account: {
                    equity_usd: snapshot.account.equity_usd,
                    derived_portfolio: {
                        remaining_capacity: snapshot.account.derived_portfolio?.remaining_capacity,
                        slots_remaining: snapshot.account.derived_portfolio?.slots_remaining
                    },
                    current_positions: openPositions
                },
                markets: symbols
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
                if (riskInfo && !riskInfo.eligible) {
                    console.log(`[enrichDecisions] Dropped ${decision.action} for ${symbol}: riskInfo not eligible.`);
                    return [];
                }
                if (riskInfo?.eligible_playbooks?.length && !this.isPlaybookAllowed(decision.playbook, riskInfo.eligible_playbooks)) {
                    console.log(`[enrichDecisions] Dropped ${decision.action} for ${symbol}: playbook ${decision.playbook} not allowed.`);
                    return [];
                }

                // Fix: if INCREASE targets a symbol with no open position, treat as OPEN.
                // This prevents ambiguity in sizing math and newPositionsCount tracking.
                const resolvedAction = (decision.action === "INCREASE_POSITION" && isNewPosition)
                    ? "OPEN_POSITION"
                    : decision.action;

                if (resolvedAction === "OPEN_POSITION" && maxNewTrades !== undefined && newTradeCount >= maxNewTrades) return [];

                const sizeFraction = decision.target_size_fraction_of_equity ?? this.computeSizeFraction(decision.confidence ?? 0, config, snapshot.account.equity_usd);
                if (sizeFraction === null) return [];

                const riskPlan = this.computeRiskPlan(decision.playbook, market, config, snapshot.global_regime.current, effectiveLeverage);
                if (!riskPlan) return [];

                const enriched: TradeDecision = {
                    ...normalizedDecision,
                    action: resolvedAction,
                    target_size_fraction_of_equity: sizeFraction,
                    size_fraction_of_equity: sizeFraction,
                    risk_plan: riskPlan,
                    audit: this.buildAudit(market, snapshot, riskPlan, sizeFraction)
                };

                if (resolvedAction === "OPEN_POSITION") newTradeCount += 1;
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

    private inferSideFromPlaybook(playbook: string) { return inferSideFromPlaybook(playbook); }

    private isPlaybookAllowed(playbook: string, eligible: string[]) { return isPlaybookAllowed(playbook, eligible); }

    private computeMinConfidence(regime: string | undefined) { return computeMinConfidence(regime); }

    private computeSizeFraction(confidence: number, config: AgentConfig, equity: number) { return computeSizeFraction(confidence, config, equity); }

    private computeRiskPlan(playbook: string, market: MarketEntry | any, config: AgentConfig, regime: GlobalRegime["current"], leverage: number) {
        return computeRiskPlan(playbook, market, config, regime, leverage);
    }

    private resolveAnchor(market: MarketEntry | any, config: AgentConfig) { return resolveAnchor(market, config); }

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

    /**
     * Deep-merge configOverride onto DEFAULT_AGENT_CONFIG.
     * Extracted to eliminate the duplicate merge block that used to live in both
     * runAnalysisJob and analyzeMarket.
     */
    private mergeConfig(configOverride?: any): { config: AgentConfig; screenerConfig: ScreenerConfig } {
        const config: AgentConfig = {
            ...DEFAULT_AGENT_CONFIG,
            ...configOverride,
            network_profiles: { ...DEFAULT_AGENT_CONFIG.network_profiles, ...configOverride?.network_profiles },
            gates: {
                ...DEFAULT_AGENT_CONFIG.gates,
                ...configOverride?.gates,
                cost_bps_max_by_regime: {
                    ...DEFAULT_AGENT_CONFIG.gates.cost_bps_max_by_regime,
                    ...configOverride?.gates?.cost_bps_max_by_regime
                },
                edge_to_cost_mult_by_regime: {
                    ...DEFAULT_AGENT_CONFIG.gates.edge_to_cost_mult_by_regime,
                    ...configOverride?.gates?.edge_to_cost_mult_by_regime
                },
                per_symbol_cost_override: {
                    ...DEFAULT_AGENT_CONFIG.gates.per_symbol_cost_override,
                    ...configOverride?.gates?.per_symbol_cost_override
                }
            },
            risk: { ...DEFAULT_AGENT_CONFIG.risk, ...configOverride?.risk },
            triggers: {
                momentum: { ...DEFAULT_AGENT_CONFIG.triggers.momentum, ...configOverride?.triggers?.momentum },
                mean_reversion: { ...DEFAULT_AGENT_CONFIG.triggers.mean_reversion, ...configOverride?.triggers?.mean_reversion },
                breakout: { ...DEFAULT_AGENT_CONFIG.triggers.breakout, ...configOverride?.triggers?.breakout }
            },
            cost_sanity: { ...DEFAULT_AGENT_CONFIG.cost_sanity, ...configOverride?.cost_sanity },
            correlation: { ...DEFAULT_AGENT_CONFIG.correlation, ...configOverride?.correlation },
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
        // Ensure both fraction fields are populated from each other when only one is provided
        config.risk.max_position_fraction = config.risk.max_position_fraction ?? config.risk.max_position_fraction_per_symbol;
        config.risk.max_position_fraction_per_symbol = config.risk.max_position_fraction_per_symbol ?? config.risk.max_position_fraction;
        config.risk.max_effective_leverage = config.risk.max_effective_leverage ?? config.risk.exchange_max_leverage_allowed;
        config.risk.exchange_max_leverage_allowed = config.risk.exchange_max_leverage_allowed ?? config.risk.max_effective_leverage;

        const screenerConfig: ScreenerConfig = {
            ...DEFAULT_SCREENER_CONFIG,
            ...configOverride?.screener
        };

        return { config, screenerConfig };
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

    private clampDecisionRiskPlan(decision: TradeDecision) { clampRiskPlan(decision); }
}
