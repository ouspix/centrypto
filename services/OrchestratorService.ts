import { SnapshotBuilder, StateSnapshot } from "./SnapshotBuilder";
import { MarketEntry, GlobalRegime } from "@/types/snapshot";
import { EligibleCandidate, LlmRunStatus, ManagedPosition, TraderContext, TraderContextDiagnostics, TraderDecision, TradeDecision, RiskAssessment } from "@/types/trading";
import { RiskCheckModule } from "@/lib/risk/RiskCheckModule";
import {
    assessDecisionsForRisk,
    buildBackendDecisions,
    isNoTradeAction,
    resolveCandidateJournalStatus
} from "@/lib/trader/TraderWorkflow";
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
import { nextExchangeNonce, placeOrderWithPrivateKey, placeTriggerOrdersWithPrivateKey, updateLeverageWithPrivateKey } from "@/lib/hyperliquid-execution";
import {
    deriveHyperliquidApiWalletAddress,
    getUserHyperliquidApiWalletCredential,
    HyperliquidApiWalletError,
    markHyperliquidApiWalletUsed
} from "@/lib/hyperliquid-api-wallet";
import { TradingLogger } from "@/lib/log/tradingLogger";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";
import { prisma } from "@/lib/db";
import { promises as fs } from "fs";
import { TraderContextBuilder } from "@/services/TraderContextBuilder";
import { TraderDecisionValidator } from "@/lib/trader/TraderDecisionValidator";
import {
    convertManagerActionToTradeDecision,
    lockedSymbolsFromPositionManagement,
    mergePositionManagementConfig,
    PositionManager
} from "@/lib/trader/PositionManager";
import { assertWalletExecutionAllowed } from "@/lib/risk/execution-safety";
import { redactSensitive, safeError } from "@/lib/log/safeLogger";
import { traderError, traderLog, traderWarn } from "@/lib/log/traderLog";
import { normalizeAutoTraderConfigOverride, normalizeScreenerConfig, resolveScreenerPresetName } from "@/lib/auto-trader-config";
import { AutoTraderReviewService } from "@/services/AutoTraderReviewService";
import { AutoTraderOrderManagementService } from "@/services/AutoTraderOrderManagementService";
import { OpportunityJournalService } from "@/services/OpportunityJournalService";
import { extractFilledOrderResponseSummary, extractOrderResponseStatus, hashJson } from "@/lib/auto-trader-review/review-utils";
import type { PositionManagementAction } from "@/lib/trader/position-management-types";

import OpenAI from "openai";

import { TRADER_AGENT_SYSTEM_PROMPT } from "@/prompts/TraderAgent";

type AnalysisResult = {
    decisions: TradeDecision[];
    riskAssessments: RiskAssessment[];
    snapshot: StateSnapshot;
    prompt: string;
    rawOutput: string;
    llmStatus?: LlmRunStatus;
};

export class AnalysisJobLimitError extends Error {
    public readonly status = 429;

    constructor(message = "Only one running and one queued AI job are allowed per wallet") {
        super(message);
        this.name = "AnalysisJobLimitError";
    }
}

export class OrchestratorService {
    private static instance: OrchestratorService;
    private static readonly jobSchedulingLocks = new Map<string, Promise<void>>();
    private static readonly positionManagerLoops = new Map<string, NodeJS.Timeout>();
    private ollamaUrl: string;
    private openRouterClient: OpenAI | null = null;
    private snapshotBuilder: SnapshotBuilder;
    private traderContextBuilder: TraderContextBuilder;
    private traderDecisionValidator: TraderDecisionValidator;
    private positionManager: PositionManager;
    private riskModule: RiskCheckModule;
    private logger: TradingLogger;
    private reviewService: AutoTraderReviewService;
    private orderManagementService: AutoTraderOrderManagementService;
    private opportunityJournalService: OpportunityJournalService;
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
        this.positionManager = new PositionManager();
        this.riskModule = new RiskCheckModule();
        this.logger = new TradingLogger();
        this.reviewService = AutoTraderReviewService.getInstance();
        this.orderManagementService = AutoTraderOrderManagementService.getInstance();
        this.opportunityJournalService = OpportunityJournalService.getInstance();
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
        let shouldStart = false;
        const normalizedUserAddress = userAddress?.toLowerCase() ?? null;

        const job = await this.withWalletJobLock(normalizedUserAddress, async () => {
            const [running, queued] = await Promise.all([
                prisma.analysisJob.count({ where: { userAddress: normalizedUserAddress, status: 'running' } }),
                prisma.analysisJob.count({ where: { userAddress: normalizedUserAddress, status: 'pending' } })
            ]);

            if (running >= 1 && queued >= 1) {
                throw new AnalysisJobLimitError();
            }

            const initialStatus = running === 0 ? 'running' : 'pending';
            shouldStart = initialStatus === 'running';

            return prisma.analysisJob.create({
                data: {
                    status: initialStatus,
                    userAddress: normalizedUserAddress,
                    isTestnet,
                    model,
                    config: configOverride ? JSON.stringify(configOverride) : null
                }
            });
        });

        console.log(`📝 Created analysis job: ${job.id}`);

        if (shouldStart) {
            this.startAnalysisJob(job.id, normalizedUserAddress, model, isTestnet, configOverride);
        }

        return job.id;
    }

    private startAnalysisJob(
        jobId: string,
        userAddress: string | null,
        model: string,
        isTestnet: boolean,
        configOverride?: any
    ) {
        this.runAnalysisJob(jobId, userAddress, model, isTestnet, configOverride).catch(err => {
            console.error(`❌ Background job ${jobId} failed unhandled:`, err);
        });
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
            try {
                await this.startNextQueuedJob(userAddress);
            } catch (error) {
                console.error(`Failed to start next queued analysis job for ${userAddress ?? "unknown wallet"}:`, error);
            }
        }
    }

    private async startNextQueuedJob(userAddress: string | null): Promise<void> {
        const normalizedUserAddress = userAddress?.toLowerCase() ?? null;
        await this.withWalletJobLock(normalizedUserAddress, async () => {
            const running = await prisma.analysisJob.count({
                where: { userAddress: normalizedUserAddress, status: 'running' }
            });
            if (running >= 1) return;

            const queued = await prisma.analysisJob.findFirst({
                where: { userAddress: normalizedUserAddress, status: 'pending' },
                orderBy: { createdAt: 'asc' }
            });
            if (!queued) return;

            await prisma.analysisJob.update({
                where: { id: queued.id },
                data: { status: 'running' }
            });

            this.startAnalysisJob(
                queued.id,
                queued.userAddress,
                queued.model,
                queued.isTestnet,
                parseJobConfig(queued.config)
            );
        });
    }

    private async withWalletJobLock<T>(userAddress: string | null, work: () => Promise<T>): Promise<T> {
        const key = userAddress ?? "anonymous";
        const previous = OrchestratorService.jobSchedulingLocks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => {
            release = resolve;
        });
        const chained = previous.then(() => current, () => current);
        OrchestratorService.jobSchedulingLocks.set(key, chained);

        await previous.catch(() => {});
        try {
            return await work();
        } finally {
            release();
            if (OrchestratorService.jobSchedulingLocks.get(key) === chained) {
                OrchestratorService.jobSchedulingLocks.delete(key);
            }
        }
    }

    public async analyzeMarket(
        userAddress: string | null,
        autoTrading: boolean,
        model: string,
        isTestnet: boolean,
        configOverride?: any
    ): Promise<AnalysisResult> {
        this.currentAbortController = new AbortController();
        try {
            return await this.runTraderCycle(userAddress, autoTrading, model, isTestnet, configOverride, this.currentAbortController.signal);
        } finally {
            this.currentAbortController = null;
        }
    }

    public async runAutonomousTraderCycle(
        userAddress: string,
        model: string,
        isTestnet: boolean,
        configOverride?: any
    ): Promise<AnalysisResult> {
        const controller = new AbortController();
        return this.runTraderCycle(userAddress, true, model, isTestnet, configOverride, controller.signal);
    }

    private async runTraderCycle(
        userAddress: string | null,
        autoTrading: boolean,
        model: string,
        isTestnet: boolean,
        configOverride?: any,
        signal?: AbortSignal
    ): Promise<AnalysisResult> {
        const cycleId = `${autoTrading ? "auto" : "manual"}-${isTestnet ? "testnet" : "mainnet"}-${Date.now().toString(36)}`;
        const logScope = `cycle=${cycleId}`;
        const { config, screenerConfig } = this.mergeConfig(configOverride);
        traderLog(`Starting trader cycle (${autoTrading ? "auto" : "manual"}, ${isTestnet ? "testnet" : "mainnet"}, model=${model}).`, logScope);
        if (signal?.aborted) throw new Error("Aborted");
        if (autoTrading && config.preset_live_mode === "limited_manual") {
            traderWarn(`${config.preset_name || "Preset"} is manual-only for v1.`, logScope);
            return {
                decisions: [],
                riskAssessments: [{ approved: false, reason: `${config.preset_name || "Preset"} is manual-only for v1` }],
                snapshot: await this.snapshotBuilder.buildSnapshot(userAddress, isTestnet, config, screenerConfig),
                prompt: "SKIPPED",
                rawOutput: "SKIPPED"
            };
        }
        if (autoTrading && config.preset_live_mode === "non_live" && !isTestnet) {
            traderWarn(`${config.preset_name || "Preset"} is non-live and cannot execute on mainnet.`, logScope);
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
        traderLog(`Snapshot ready: id=${snapshotId ?? "unpersisted"}, positions=${snapshot.account.current_positions.length}, markets=${Object.keys(snapshot.markets || {}).length}.`, logScope);
        const reviewRunId = autoTrading && userAddress
            ? await this.reviewService.startRun({
                accountAddress: userAddress,
                network: isTestnet ? "testnet" : "mainnet",
                model,
                config: configOverride ?? config,
                snapshot
            })
            : null;
        const prePositionSnapshotIds = await this.reviewService.snapshotPositions(reviewRunId, "PRE_DECISION", snapshot);

        const network: "testnet" | "mainnet" = isTestnet ? "testnet" : "mainnet";
        if (autoTrading && userAddress) {
            try {
                const credential = await resolveExecutionCredential(userAddress, isTestnet);
                if (credential) {
                    await this.reviewService.updateRunAgentWallet(reviewRunId, credential.apiWalletAddress);
                    await this.syncAndReconcileAfterExecution({
                        userAddress,
                        network,
                        credential,
                        snapshot,
                        startTimeMs: Date.now() - 30 * 60_000
                    });
                }
            } catch (error) {
                traderWarn("⚠️ Pre-cycle fill sync/OCO reconciliation skipped:", logScope, error);
            }
        }
        const positionManagementInput = userAddress
            ? {
                accountAddress: userAddress,
                network,
                now: new Date(),
                snapshot,
                openLifecycles: await this.reviewService.getManagedLifecycleStates(userAddress, network, snapshot, config),
                openOrders: await this.orderManagementService.getOpenOrders({ accountAddress: userAddress, network }),
                config
            }
            : null;
        const positionManagement = positionManagementInput
            ? this.positionManager.evaluate(positionManagementInput)
            : {
                actions: [],
                portfolioFlags: { blockNewEntries: false, reasonCodes: [] },
                diagnostics: { evaluatedPositions: 0, urgentActionCount: 0, repairActionCount: 0, holdCount: 0 }
            };
        if (positionManagementInput) {
            await this.reviewService.persistPositionManagementResult({
                runId: reviewRunId,
                managementInput: positionManagementInput,
                result: positionManagement
            });
        }
        if (autoTrading && userAddress) {
            await this.executePositionManagerOrderActions({
                actions: positionManagement.actions,
                snapshot,
                config,
                isTestnet,
                userAddress,
                runId: reviewRunId
            });
        }
        if (positionManagement.portfolioFlags.blockNewEntries) {
            snapshot.constraints.max_new_trades_allowed = 0;
            snapshot.constraints.max_new_entries_allowed = 0;
            traderWarn(`Position manager blocked new entries: ${positionManagement.portfolioFlags.reasonCodes.join(",")}`, logScope);
        }
        const lockedSymbols = lockedSymbolsFromPositionManagement(positionManagement);
        const managerTradeDecisions = positionManagement.actions
            .filter(action => action.bypassLlm && action.action !== "HOLD_POSITION" && action.action !== "NO_ACTION")
            .map(action => convertManagerActionToTradeDecision(action, config))
            .filter((decision): decision is TradeDecision => !!decision);

        const profile = this.resolveProfileName(configOverride);
        const { context, diagnostics } = await this.traderContextBuilder.build(snapshot, config, isTestnet, profile, userAddress);
        await this.journalOpportunityDiagnostics(context, userAddress, network, snapshot.markets, config);
        if (lockedSymbols.size > 0) {
            context.existing_positions = context.existing_positions.filter(position => !lockedSymbols.has(position.symbol));
        }
        const hasLlmWork = context.eligible_candidates.length > 0 || context.existing_positions.length > 0;
        const hasManagerWork = managerTradeDecisions.length > 0;

        let llmResult: { decisions: TraderDecision[]; prompt: string; rawOutput: string } = {
            decisions: [],
            prompt: "SKIPPED_LLM_POSITION_MANAGER_ONLY",
            rawOutput: JSON.stringify({ positionManagement }, null, 2)
        };
        let validation = { accepted: true, reason: "accepted" };
        let llmQueryId: number | null = null;
        let llmStatus: LlmRunStatus = hasLlmWork
            ? this.buildLlmCalledStatus(context, diagnostics)
            : hasManagerWork
                ? this.buildLlmSkippedForManagerStatus(context, diagnostics)
                : this.buildLlmSkippedStatus(context, diagnostics);
        let llmBackendDecisions: TradeDecision[] = [];

        if (!hasLlmWork && !hasManagerWork) {
            traderLog(`[LLM] Skipped: ${llmStatus.reason}`, logScope);
            await this.reviewService.finishRun(reviewRunId, { status: "SKIPPED", error: llmStatus.reason });
            return {
                decisions: [],
                riskAssessments: [],
                snapshot,
                prompt: "SKIPPED_LLM_NO_WORK",
                rawOutput: JSON.stringify(llmStatus, null, 2),
                llmStatus
            };
        }

        if (hasLlmWork) {
            traderLog(`✨ Trader context: ${context.eligible_candidates.length} candidates, ${context.existing_positions.length} positions.`, logScope);
            if (signal?.aborted) throw new Error("Aborted");

            llmResult = await this.getLLMDecision(context, model, signal, logScope);
            validation = this.traderDecisionValidator.validateBatch(llmResult.decisions, context);

            if (!validation.accepted) {
                const invalidDecisions = buildBackendDecisions(llmResult.decisions, context, validation.reason);
                llmQueryId = await this.saveLlmInteraction(llmResult.prompt, llmResult.rawOutput, invalidDecisions, isTestnet, logScope);
                await this.reviewService.persistDecisions({
                    runId: reviewRunId,
                    traderDecisions: llmResult.decisions,
                    backendDecisions: invalidDecisions,
                    validation,
                    positionSnapshotIds: prePositionSnapshotIds
                });
                await this.journalTraderContext(context, llmResult.decisions, validation, new Map());
                if (!hasManagerWork) {
                    await this.reviewService.finishRun(reviewRunId, { status: "COMPLETED", llmQueryId });
                    return {
                        decisions: [],
                        riskAssessments: [{ approved: false, reason: `Validator rejected batch: ${validation.reason}` }],
                        snapshot,
                        prompt: llmResult.prompt,
                        rawOutput: llmResult.rawOutput,
                        llmStatus
                    };
                }
            } else {
                const filteredLlmDecisions = llmResult.decisions.filter(decision => !decision.symbol || !lockedSymbols.has(decision.symbol));
                llmBackendDecisions = buildBackendDecisions(filteredLlmDecisions, context, "accepted");
                llmQueryId = await this.saveLlmInteraction(llmResult.prompt, llmResult.rawOutput, llmBackendDecisions, isTestnet, logScope);
            }
        } else {
            traderLog(`[LLM] Skipped: ${llmStatus.reason}`, logScope);
        }

        const decisions = validation.accepted
            ? [...managerTradeDecisions, ...llmBackendDecisions]
            : [...managerTradeDecisions];
        const preRiskDecisions = cloneJson(decisions);
        const { riskAssessments } = assessDecisionsForRisk(decisions, snapshot, this.riskModule);
        const reviewDecisionIds = await this.reviewService.persistDecisions({
            runId: reviewRunId,
            traderDecisions: [
                ...managerTradeDecisions.map(() => null),
                ...(validation.accepted ? llmResult.decisions.filter(decision => !decision.symbol || !lockedSymbols.has(decision.symbol)) : [])
            ] as any,
            backendDecisions: decisions,
            preRiskDecisions,
            riskAssessments,
            validation: { accepted: true, reason: validation.accepted ? validation.reason : "position_manager_override_after_llm_rejection" },
            positionSnapshotIds: prePositionSnapshotIds
        });
        const executionResults = new Map<string, { attempted: boolean; success: boolean; error?: string }>();

        for (let i = 0; i < decisions.length; i++) {
            const decision = decisions[i];
            const riskAssessment = riskAssessments[i];

            if (isNoTradeAction(decision.action)) {
                continue;
            }

            let executionResult: any = null;
            if (autoTrading && riskAssessment.approved && riskAssessment.modifiedOrder) {
                executionResult = await this.executeApprovedDecision(decision, riskAssessment, snapshot, config, isTestnet, userAddress, reviewDecisionIds[i]);
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

        if (validation.accepted) {
            await this.journalTraderContext(context, llmResult.decisions, validation, executionResults);
        }
        if (reviewRunId) {
            try {
                const postSnapshot = await this.snapshotBuilder.buildSnapshot(userAddress, isTestnet, config, screenerConfig);
                if (snapshotId) postSnapshot.meta.snapshot_id = snapshotId;
                await this.reviewService.snapshotPositions(reviewRunId, "POST_EXECUTION", postSnapshot);
            } catch (error) {
                traderWarn("⚠️ Failed to write post-execution review snapshot:", logScope, error);
            }
            await this.reviewService.finishRun(reviewRunId, {
                status: "COMPLETED",
                llmQueryId
            });
        }
        return {
            decisions,
            riskAssessments,
            snapshot,
            prompt: llmResult.prompt,
            rawOutput: llmResult.rawOutput,
            llmStatus
        };
    }

    private buildLlmSkippedStatus(context: TraderContext, diagnostics: TraderContextDiagnostics): LlmRunStatus {
        return {
            status: "skipped",
            reason_code: "NO_ELIGIBLE_CANDIDATES_NO_POSITIONS",
            reason: "No eligible candidates and no positions to manage. LLM call skipped.",
            diagnostics: {
                ...diagnostics,
                regime: context.global_regime,
                profile: context.profile,
                snapshot_id: context.snapshot_id
            }
        };
    }

    private buildLlmSkippedForManagerStatus(context: TraderContext, diagnostics: TraderContextDiagnostics): LlmRunStatus {
        return {
            status: "skipped",
            reason_code: "POSITION_MANAGER_ONLY",
            reason: "LLM skipped because deterministic position management has executable work and no remaining LLM-managed candidates or positions.",
            diagnostics: {
                ...diagnostics,
                regime: context.global_regime,
                profile: context.profile,
                snapshot_id: context.snapshot_id
            }
        };
    }

    private buildLlmCalledStatus(context: TraderContext, diagnostics: TraderContextDiagnostics): LlmRunStatus {
        return {
            status: "called",
            reason: `LLM called with ${context.eligible_candidates.length} eligible candidates and ${context.existing_positions.length} managed positions.`,
            diagnostics: {
                ...diagnostics,
                regime: context.global_regime,
                profile: context.profile,
                snapshot_id: context.snapshot_id
            }
        };
    }

    private async executeApprovedDecision(
        decision: TradeDecision,
        riskAssessment: RiskAssessment,
        snapshot: StateSnapshot,
        config: AgentConfig,
        isTestnet: boolean,
        userAddress: string | null,
        reviewDecisionId?: string | null
    ) {
        const marketData = decision.symbol ? snapshot.markets[decision.symbol] : undefined;
        const assetIndex = marketData?.assetIndex;
        if (assetIndex === undefined || !riskAssessment.modifiedOrder || !marketData) {
            return { success: false, status: "failed", error: "Asset index or order missing" };
        }

        if (!userAddress) {
            return { success: false, status: "failed", error: "Wallet session required for execution" };
        }
        const network: "testnet" | "mainnet" = isTestnet ? "testnet" : "mainnet";

        try {
            await assertWalletExecutionAllowed(userAddress, isTestnet);
        } catch (error) {
            return { success: false, status: "failed", error: error instanceof Error ? error.message : "Execution blocked by risk controls" };
        }

        let credential: { privateKey: string; mode: "user_api_wallet" | "server_dev_testnet_bot"; apiWalletAddress: string | null } | null;
        try {
            credential = await resolveExecutionCredential(userAddress, isTestnet);
        } catch (error) {
            return { success: false, status: "failed", error: error instanceof Error ? error.message : "Hyperliquid API wallet is not available" };
        }
        if (!credential) {
            return {
                success: false,
                status: "failed",
                error: `Hyperliquid API wallet is not configured for this wallet on ${isTestnet ? "testnet" : "mainnet"}`
            };
        }

        try {
            const currentPrice = marketData.price || 0;
            const isBuy = riskAssessment.modifiedOrder.side === "buy";
            const sz = riskAssessment.modifiedOrder.sizeCoin ?? riskAssessment.modifiedOrder.sizeUsd / currentPrice;
            const reduceOnly = decision.action === "CLOSE_POSITION" || decision.action === "REDUCE_POSITION";
            const slippage = config.risk.slippage_pct ?? 0.003;
            const limitPx = isBuy ? currentPrice * (1 + slippage) : currentPrice * (1 - slippage);

            if (!reduceOnly && decision.action === "OPEN_POSITION") {
                await updateLeverageWithPrivateKey(
                    credential.privateKey,
                    {
                        asset: assetIndex,
                        isCross: config.risk.margin_mode !== "isolated",
                        leverage: config.risk.exchange_max_leverage_allowed
                    },
                    isTestnet
                );
            }

            const nonce = nextExchangeNonce();

            const positionSide = isBuy ? "long" as const : "short" as const;
            let plannedStopLossPrice: number | undefined;
            let plannedTakeProfitPrice: number | undefined;
            if (!reduceOnly && decision.risk_plan) {
                const slPct = Math.abs(decision.risk_plan.stop_loss_pct);
                const tpPct = Math.abs(decision.risk_plan.take_profit_pct_primary);
                plannedStopLossPrice = isBuy ? currentPrice * (1 - slPct) : currentPrice * (1 + slPct);
                plannedTakeProfitPrice = isBuy ? currentPrice * (1 + tpPct) : currentPrice * (1 - tpPct);
            }

            const attemptDrafts = this.reviewService.buildOrderAttemptDrafts({
                decision,
                symbol: decision.symbol ?? riskAssessment.modifiedOrder.symbol,
                currentPrice,
                sizeCoin: sz,
                sizeUsd: riskAssessment.modifiedOrder.sizeUsd,
                limitPx,
                isBuy,
                reduceOnly,
                stopLossPrice: undefined,
                takeProfitPrice: undefined,
                nonce,
                requestHashSeed: {
                    assetIndex,
                    decision,
                    order: riskAssessment.modifiedOrder,
                    limitPx,
                    plannedStopLossPrice,
                    plannedTakeProfitPrice
                }
            });
            await this.reviewService.updateDecisionSubmittedOrderPlan(reviewDecisionId ?? null, {
                symbol: decision.symbol ?? riskAssessment.modifiedOrder.symbol,
                action: decision.action,
                order: riskAssessment.modifiedOrder,
                currentPrice,
                limitPx,
                plannedStopLossPrice: plannedStopLossPrice ?? null,
                plannedTakeProfitPrice: plannedTakeProfitPrice ?? null,
                reduceOnly,
                drafts: attemptDrafts
            });
            const attemptIds = await this.reviewService.createOrderAttempts(reviewDecisionId ?? null, attemptDrafts);
            await this.reviewService.updateRunAgentWalletFromDecision(reviewDecisionId ?? null, credential.apiWalletAddress);
            const cloids = {
                entry: attemptDrafts.find(attempt => attempt.orderRole === "ENTRY" || attempt.orderRole === "REDUCE" || attempt.orderRole === "CLOSE")?.cloid as `0x${string}` | undefined,
            };
            const submittedAt = new Date();

            let result: any;
            try {
                result = await placeOrderWithPrivateKey(
                    credential.privateKey,
                    {
                        asset: assetIndex,
                        isBuy,
                        limitPx,
                        sz,
                        reduceOnly,
                        nonce,
                        cloids,
                        tif: reduceOnly ? "Ioc" : "Ioc"
                    },
                    isTestnet
                );
                await this.reviewService.updateOrderAttemptsFromResponse({
                    attemptIds,
                    response: result,
                    submittedAt,
                    exchangeReceivedAt: new Date()
                });
            } catch (error) {
                await this.reviewService.updateOrderAttemptsFromResponse({
                    attemptIds,
                    response: null,
                    submittedAt,
                    exchangeReceivedAt: new Date(),
                    error
                });
                throw error;
            }

            if (result.status === "ok") {
                if (credential.mode === "user_api_wallet") {
                    await markHyperliquidApiWalletUsed(userAddress, isTestnet);
                }
                await new Promise(resolve => setTimeout(resolve, 500));
                const mainStatus = extractOrderResponseStatus(result, 0);
                if (mainStatus.status === "FAILED" || mainStatus.status === "ERROR") {
                    return { success: false, status: "failed", error: mainStatus.reason ?? "entry order failed" };
                }
                const syncStartMs = submittedAt.getTime() - 60_000;
                await this.syncAndReconcileAfterExecution({
                    userAddress,
                    network,
                    credential,
                    snapshot,
                    startTimeMs: syncStartMs
                });

                if (!reduceOnly && decision.action === "OPEN_POSITION" && decision.risk_plan) {
                    const responseFill = extractFilledOrderResponseSummary(result, 0);
                    const dbFill = await this.reviewService.getAttemptFillSummary(attemptIds[0] ?? null);
                    const fill = responseFill
                        ? {
                            avgPx: responseFill.avgPx,
                            totalSz: responseFill.totalSz,
                            totalFee: dbFill?.totalFee ?? 0,
                            notionalUsd: responseFill.avgPx * responseFill.totalSz,
                            firstFillAt: dbFill?.firstFillAt ?? submittedAt
                        }
                        : dbFill;

                    if (!fill || fill.totalSz <= 0 || fill.avgPx <= 0) {
                        await this.reviewService.updateDecisionSubmittedOrderPlan(reviewDecisionId ?? null, {
                            symbol: decision.symbol ?? riskAssessment.modifiedOrder.symbol,
                            action: decision.action,
                            order: riskAssessment.modifiedOrder,
                            currentPrice,
                            limitPx,
                            reduceOnly,
                            entryOnly: true,
                            fillConfirmed: false,
                            reason: "entry fill not confirmed; bracket not placed",
                            drafts: attemptDrafts,
                            response: result
                        });
                        return {
                            success: true,
                            status: "entry_submitted_no_fill",
                            orderId: mainStatus.oid ?? undefined,
                            cloid: cloids.entry,
                            requestHash: hashJson({ decision, order: riskAssessment.modifiedOrder, nonce })
                        };
                    }

                    const slPct = Math.abs(decision.risk_plan.stop_loss_pct);
                    const tpPct = Math.abs(decision.risk_plan.take_profit_pct_primary);
                    const actualStopLossPrice = isBuy ? fill.avgPx * (1 - slPct) : fill.avgPx * (1 + slPct);
                    const actualTakeProfitPrice = isBuy ? fill.avgPx * (1 + tpPct) : fill.avgPx * (1 - tpPct);
                    const bracketNonce = nextExchangeNonce();
                    const bracketDrafts = this.reviewService.buildBracketOrderAttemptDrafts({
                        symbol: decision.symbol ?? riskAssessment.modifiedOrder.symbol,
                        positionSide,
                        sizeCoin: fill.totalSz,
                        sizeUsd: fill.notionalUsd,
                        stopLossPrice: actualStopLossPrice,
                        takeProfitPrice: actualTakeProfitPrice,
                        nonce: bracketNonce,
                        requestHashSeed: {
                            assetIndex,
                            decision,
                            order: riskAssessment.modifiedOrder,
                            entryAttemptId: attemptIds[0] ?? null,
                            avgFillPrice: fill.avgPx,
                            filledSizeCoin: fill.totalSz,
                            stopLossPrice: actualStopLossPrice,
                            takeProfitPrice: actualTakeProfitPrice
                        }
                    });
                    const bracketAttemptIds = await this.reviewService.createOrderAttempts(reviewDecisionId ?? null, bracketDrafts);
                    const bracketCloids = {
                        stopLoss: bracketDrafts.find(attempt => attempt.orderRole === "STOP_LOSS")?.cloid as `0x${string}` | undefined,
                        takeProfit: bracketDrafts.find(attempt => attempt.orderRole === "TAKE_PROFIT")?.cloid as `0x${string}` | undefined
                    };
                    let bracketResult: any = null;
                    const bracketSubmittedAt = new Date();
                    try {
                        bracketResult = await placeTriggerOrdersWithPrivateKey(
                            credential.privateKey,
                            {
                                asset: assetIndex,
                                positionSide,
                                sz: fill.totalSz,
                                stopLossPrice: actualStopLossPrice,
                                takeProfitPrice: actualTakeProfitPrice,
                                nonce: bracketNonce,
                                cloids: bracketCloids
                            },
                            isTestnet
                        );
                        await this.reviewService.updateOrderAttemptsFromResponse({
                            attemptIds: bracketAttemptIds,
                            response: bracketResult,
                            submittedAt: bracketSubmittedAt,
                            exchangeReceivedAt: new Date()
                        });
                    } catch (error) {
                        await this.reviewService.updateOrderAttemptsFromResponse({
                            attemptIds: bracketAttemptIds,
                            response: null,
                            submittedAt: bracketSubmittedAt,
                            exchangeReceivedAt: new Date(),
                            error
                        });
                        throw error;
                    }

                    await this.reviewService.updateDecisionSubmittedOrderPlan(reviewDecisionId ?? null, {
                        symbol: decision.symbol ?? riskAssessment.modifiedOrder.symbol,
                        action: decision.action,
                        order: riskAssessment.modifiedOrder,
                        currentPrice,
                        limitPx,
                        reduceOnly,
                        entry: {
                            avgFillPrice: fill.avgPx,
                            filledSizeCoin: fill.totalSz,
                            filledNotionalUsd: fill.notionalUsd,
                            entryFees: fill.totalFee,
                            firstFillAt: fill.firstFillAt
                        },
                        stopLossPrice: actualStopLossPrice,
                        takeProfitPrice: actualTakeProfitPrice,
                        entryDrafts: attemptDrafts,
                        bracketDrafts,
                        entryResponse: result,
                        bracketResponse: bracketResult
                    });
                    await this.reviewService.upsertPositionStateAfterEntryFill({
                        accountAddress: userAddress,
                        network,
                        symbol: decision.symbol ?? riskAssessment.modifiedOrder.symbol,
                        side: positionSide,
                        entryPrice: fill.avgPx,
                        openedAt: fill.firstFillAt,
                        policyVersion: config.position_management.version
                    });
                    this.schedulePostFillPositionManagerLoop({
                        accountAddress: userAddress,
                        network,
                        symbol: decision.symbol ?? riskAssessment.modifiedOrder.symbol,
                        side: positionSide,
                        model: "POSITION_MANAGER",
                        isTestnet,
                        config,
                        screenerConfig: snapshot.presets?.screening ?? DEFAULT_SCREENER_CONFIG
                    });
                }

                return {
                    success: true,
                    status: "submitted",
                    orderId: mainStatus.oid ?? undefined,
                    cloid: cloids.entry,
                    requestHash: hashJson({ decision, order: riskAssessment.modifiedOrder, nonce })
                };
            }

            return { success: false, status: "failed", error: JSON.stringify(result.response) };
        } catch (error: any) {
            safeError("Auto-trading execution failed", error);
            return { success: false, status: "error", error: error.message || String(error) };
        }
    }

    private async syncAndReconcileAfterExecution(input: {
        userAddress: string;
        network: "mainnet" | "testnet";
        credential: { privateKey: string; apiWalletAddress: string | null };
        snapshot: StateSnapshot;
        startTimeMs: number;
    }): Promise<void> {
        try {
            await this.reviewService.syncFills({
                accountAddress: input.userAddress,
                agentWalletAddress: input.credential.apiWalletAddress,
                network: input.network,
                startTimeMs: input.startTimeMs,
                endTimeMs: Date.now() + 2_000
            });
            await this.orderManagementService.cancelOcoSiblingOrders({
                accountAddress: input.userAddress,
                network: input.network,
                privateKey: input.credential.privateKey,
                assetIndexBySymbol: assetIndexMapFromSnapshot(input.snapshot)
            });
        } catch (error) {
            traderWarn("⚠️ Post-execution fill sync/OCO reconciliation failed:", undefined, error);
        }
    }

    private async executePositionManagerOrderActions(input: {
        actions: PositionManagementAction[];
        snapshot: StateSnapshot;
        config: AgentConfig;
        isTestnet: boolean;
        userAddress: string;
        runId: string | null;
    }): Promise<void> {
        const repairActions = input.actions.filter(action => isPositionManagerOrderAction(action.action) && action.bypassLlm);
        if (!repairActions.length) return;

        let credential: { privateKey: string; mode: "user_api_wallet" | "server_dev_testnet_bot"; apiWalletAddress: string | null } | null;
        try {
            await assertWalletExecutionAllowed(input.userAddress, input.isTestnet);
            credential = await resolveExecutionCredential(input.userAddress, input.isTestnet);
        } catch (error) {
            traderWarn("⚠️ Position manager order repair skipped; execution credential unavailable:", undefined, error);
            return;
        }
        if (!credential) return;

        for (const action of repairActions) {
            await this.executePositionManagerOrderAction({
                action,
                snapshot: input.snapshot,
                config: input.config,
                isTestnet: input.isTestnet,
                userAddress: input.userAddress,
                runId: input.runId,
                privateKey: credential.privateKey,
                apiWalletAddress: credential.apiWalletAddress
            });
        }
    }

    private async executePositionManagerOrderAction(input: {
        action: PositionManagementAction;
        snapshot: StateSnapshot;
        config: AgentConfig;
        isTestnet: boolean;
        userAddress: string;
        runId: string | null;
        privateKey: string;
        apiWalletAddress: string | null;
    }): Promise<void> {
        const network: "mainnet" | "testnet" = input.isTestnet ? "testnet" : "mainnet";
        const market = input.snapshot.markets[input.action.symbol];
        const asset = market?.assetIndex;
        const position = input.snapshot.account.current_positions.find(p => p.symbol === input.action.symbol && p.side === input.action.side);
        if (asset === undefined || !position) return;

        const decisionId = await this.reviewService.createPositionManagerDecision({
            runId: input.runId,
            action: input.action
        });
        await this.reviewService.updateRunAgentWalletFromDecision(decisionId, input.apiWalletAddress);

        const cancelOids = uniqueStrings([
            ...(input.action.cancelOrderOids ?? []),
            ...(input.action.stopReplacement?.cancelExistingStopOids ?? []),
            ...(input.action.takeProfitReplacement?.cancelExistingTakeProfitOids ?? [])
        ]);
        const numericCancelOids = cancelOids.filter(oid => Number.isFinite(Number(oid)));
        if (numericCancelOids.length > 0) {
            try {
                await this.orderManagementService.cancelOrders({
                    accountAddress: input.userAddress,
                    network,
                    privateKey: input.privateKey,
                    orders: numericCancelOids.map(oid => ({ asset, oid })),
                    status: input.action.action === "CANCEL_STALE_ORDER" ? "CANCELED" : "REPLACED",
                    reason: input.action.reasonCode
                });
            } catch (error) {
                traderWarn("⚠️ Position manager cancel failed:", undefined, error);
            }
        }

        if (input.action.action === "CANCEL_STALE_ORDER") {
            await this.reviewService.updateDecisionSubmittedOrderPlan(decisionId, {
                action: input.action,
                canceledOids: numericCancelOids
            });
            return;
        }

        const stopLossPrice = input.action.stopReplacement?.stopPx;
        const takeProfitPrice = input.action.takeProfitReplacement?.takeProfitPx;
        if (!stopLossPrice && !takeProfitPrice) return;

        const nonce = nextExchangeNonce();
        const sizeCoin = position.size_coin;
        const sizeUsd = position.size_usd;
        if (!sizeCoin || sizeCoin <= 0) return;

        const drafts = this.reviewService.buildBracketOrderAttemptDrafts({
            symbol: input.action.symbol,
            positionSide: input.action.side,
            sizeCoin,
            sizeUsd,
            stopLossPrice,
            takeProfitPrice,
            nonce,
            requestHashSeed: {
                source: "POSITION_MANAGER",
                action: input.action,
                asset,
                sizeCoin,
                sizeUsd
            }
        });
        const attemptIds = await this.reviewService.createOrderAttempts(decisionId, drafts);
        await this.reviewService.updateDecisionSubmittedOrderPlan(decisionId, {
            action: input.action,
            stopLossPrice: stopLossPrice ?? null,
            takeProfitPrice: takeProfitPrice ?? null,
            cancelOids,
            drafts
        });

        const submittedAt = new Date();
        try {
            const response = await placeTriggerOrdersWithPrivateKey(
                input.privateKey,
                {
                    asset,
                    positionSide: input.action.side,
                    sz: sizeCoin,
                    stopLossPrice,
                    takeProfitPrice,
                    nonce,
                    cloids: {
                        stopLoss: drafts.find(draft => draft.orderRole === "STOP_LOSS")?.cloid as `0x${string}` | undefined,
                        takeProfit: drafts.find(draft => draft.orderRole === "TAKE_PROFIT")?.cloid as `0x${string}` | undefined
                    }
                },
                input.isTestnet
            );
            await this.reviewService.updateOrderAttemptsFromResponse({
                attemptIds,
                response,
                submittedAt,
                exchangeReceivedAt: new Date()
            });
        } catch (error) {
            await this.reviewService.updateOrderAttemptsFromResponse({
                attemptIds,
                response: null,
                submittedAt,
                exchangeReceivedAt: new Date(),
                error
            });
            traderWarn("⚠️ Position manager repair order failed:", undefined, error);
        }
    }

    private schedulePostFillPositionManagerLoop(input: {
        accountAddress: string;
        network: "mainnet" | "testnet";
        symbol: string;
        side: "long" | "short";
        model: string;
        isTestnet: boolean;
        config: AgentConfig;
        screenerConfig: ScreenerConfig;
    }): void {
        const key = `${input.accountAddress.toLowerCase()}:${input.network}:${input.symbol}:${input.side}`;
        if (OrchestratorService.positionManagerLoops.has(key)) return;
        const startedAt = Date.now();
        const run = async () => {
            try {
                const shouldContinue = await this.runPositionManagerOnlyCycle(input);
                if (!shouldContinue || Date.now() - startedAt >= 10 * 60_000) {
                    OrchestratorService.positionManagerLoops.delete(key);
                    return;
                }
                const timer = setTimeout(run, 30_000);
                timer.unref?.();
                OrchestratorService.positionManagerLoops.set(key, timer);
            } catch (error) {
                traderWarn("⚠️ Post-fill position manager loop failed:", undefined, error);
                OrchestratorService.positionManagerLoops.delete(key);
            }
        };
        const timer = setTimeout(run, 30_000);
        timer.unref?.();
        OrchestratorService.positionManagerLoops.set(key, timer);
    }

    public async runPositionManagerOnlyCycle(input: {
        accountAddress: string;
        network: "mainnet" | "testnet";
        symbol?: string;
        side?: "long" | "short";
        model?: string;
        isTestnet: boolean;
        config: AgentConfig;
        screenerConfig?: ScreenerConfig;
    }): Promise<boolean> {
        const snapshot = await this.snapshotBuilder.buildSnapshot(
            input.accountAddress,
            input.isTestnet,
            input.config,
            input.screenerConfig ?? DEFAULT_SCREENER_CONFIG
        );
        const snapshotId = await this.persistSnapshot(snapshot);
        if (snapshotId) snapshot.meta.snapshot_id = snapshotId;
        const runId = await this.reviewService.startRun({
            accountAddress: input.accountAddress,
            network: input.network,
            cycleType: "POSITION_MANAGER",
            model: input.model ?? "POSITION_MANAGER",
            config: input.config,
            snapshot
        });
        const positionSnapshotIds = await this.reviewService.snapshotPositions(runId, "PRE_DECISION", snapshot);

        let credential: { privateKey: string; mode: "user_api_wallet" | "server_dev_testnet_bot"; apiWalletAddress: string | null } | null = null;
        try {
            credential = await resolveExecutionCredential(input.accountAddress, input.isTestnet);
            if (credential) {
                await this.syncAndReconcileAfterExecution({
                    userAddress: input.accountAddress,
                    network: input.network,
                    credential,
                    snapshot,
                    startTimeMs: Date.now() - 15 * 60_000
                });
            }
        } catch (error) {
            traderWarn("⚠️ PM-only sync skipped; credential unavailable:", undefined, error);
        }

        const openOrders = await this.orderManagementService.getOpenOrders({
            accountAddress: input.accountAddress,
            network: input.network
        });
        const managed = await this.reviewService.getManagedLifecycleStates(input.accountAddress, input.network, snapshot, input.config);
        const filteredManaged = managed.filter(position =>
            (!input.symbol || position.symbol === input.symbol) &&
            (!input.side || position.side === input.side)
        );
        const managementInput = {
            accountAddress: input.accountAddress,
            network: input.network,
            now: new Date(),
            snapshot,
            openLifecycles: filteredManaged,
            openOrders,
            config: input.config
        };
        const result = this.positionManager.evaluate(managementInput);
        await this.reviewService.persistPositionManagementResult({ runId, managementInput, result });
        await this.executePositionManagerOrderActions({
            actions: result.actions,
            snapshot,
            config: input.config,
            isTestnet: input.isTestnet,
            userAddress: input.accountAddress,
            runId
        });

        const managerTradeDecisions = result.actions
            .filter(action => action.bypassLlm && action.action !== "HOLD_POSITION" && action.action !== "NO_ACTION")
            .map(action => convertManagerActionToTradeDecision(action, input.config))
            .filter((decision): decision is TradeDecision => !!decision);
        const preRiskDecisions = cloneJson(managerTradeDecisions);
        const { riskAssessments } = assessDecisionsForRisk(managerTradeDecisions, snapshot, this.riskModule);
        const decisionIds = await this.reviewService.persistDecisions({
            runId,
            traderDecisions: managerTradeDecisions.map(() => null) as any,
            backendDecisions: managerTradeDecisions,
            preRiskDecisions,
            riskAssessments,
            validation: { accepted: true, reason: "position_manager_only" },
            positionSnapshotIds
        });

        for (let i = 0; i < managerTradeDecisions.length; i++) {
            const decision = managerTradeDecisions[i];
            const riskAssessment = riskAssessments[i];
            if (riskAssessment?.approved && riskAssessment.modifiedOrder) {
                await this.executeApprovedDecision(decision, riskAssessment, snapshot, input.config, input.isTestnet, input.accountAddress, decisionIds[i]);
            }
        }

        await this.reviewService.finishRun(runId, { status: "COMPLETED" });
        const postSnapshot = await this.snapshotBuilder.buildSnapshot(input.accountAddress, input.isTestnet, input.config, input.screenerConfig ?? DEFAULT_SCREENER_CONFIG);
        await this.reviewService.snapshotPositions(runId, "POST_EXECUTION", postSnapshot);
        return postSnapshot.account.current_positions.some(position =>
            (!input.symbol || position.symbol === input.symbol) &&
            (!input.side || position.side === input.side)
        );
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
                status: resolveCandidateJournalStatus(decision, validation, execution),
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
            traderWarn("⚠️ Failed to write candidate journal:", undefined, error);
        }
    }

    private async journalOpportunityDiagnostics(
        context: TraderContext,
        accountAddress: string | null,
        network: "mainnet" | "testnet",
        markets: Record<string, MarketEntry>,
        config: AgentConfig
    ) {
        const opportunities = config.opportunity?.journalAllDiscovered === false
            ? (context.opportunity_diagnostics ?? []).filter(opportunity => opportunity.status !== "DISCOVERED_ONLY")
            : context.opportunity_diagnostics ?? [];
        if (opportunities.length === 0) return;
        try {
            await this.opportunityJournalService.persistSnapshotOpportunities({
                accountAddress,
                network,
                snapshotId: context.snapshot_id,
                timestamp: context.timestamp,
                opportunities,
                markets
            });
        } catch (error) {
            traderWarn("⚠️ Failed to write opportunity journal:", undefined, error);
        }
    }

    private resolveProfileName(configOverride?: any): string {
        return configOverride?.profileName || configOverride?.preset || configOverride?.name || "active";
    }

    private async getLLMDecision(context: TraderContext, model: string, signal?: AbortSignal, logScope?: string): Promise<{ decisions: TraderDecision[], prompt: string, rawOutput: string }> {
        const SYSTEM_PROMPT = TRADER_AGENT_SYSTEM_PROMPT;
        const USER_PROMPT = `TRADER_CONTEXT (backend-precomputed; use provided fields only):
${JSON.stringify(context, null, 2)}`;

        let rawOutput = "";

        try {

            traderLog(`🤖 Calling LLM with model: ${model}`, logScope);

            // Check if we should use OpenRouter
            // If the model string contains "deepseek" or "gpt" or "claude" and we have a client, use it.
            // Or if the user specifically requested an OpenRouter model.
            // For now, let's assume if the model name contains "/" it's likely an OpenRouter model ID (e.g. "deepseek/deepseek-chat-v3-0324:free")
            // OR if we have the client and the model is not a standard local one.

            if (this.openRouterClient && (model.includes("/") || model.startsWith("gpt") || model.startsWith("anthropic"))) {
                traderLog("✨ Using OpenRouter via OpenAI SDK", logScope);

                let targetModel = model;
                let includeReasoning = false;

                // Check for reasoning suffix
                if (targetModel.endsWith(":reasoning")) {
                    targetModel = targetModel.replace(":reasoning", "");
                    includeReasoning = true;
                    traderLog("🧠 Reasoning Mode Enabled via suffix", logScope);
                }

                // Also enable for R1 by default if not already
                if (targetModel.includes("r1") || targetModel.includes("reasoner")) {
                    includeReasoning = true;
                }

                const isReasoning = includeReasoning;
                const temperature = isReasoning ? 0.6 : 0.3;

                if (isReasoning) {
                    traderLog(`🧠 Reasoning Active for ${targetModel}: Adjusting temperature to 0.6`, logScope);
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
                traderLog(`🏁 LLM Finish Reason: ${choice.finish_reason}`, logScope);
                if (choice.finish_reason === "length") {
                    traderWarn("⚠️ LLM response was truncated due to length limit!", logScope);
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
                    traderError(`❌ Ollama API Error: ${response.status}`, logScope, errorText);
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

            traderLog("🔍 Trader Context Debug:", logScope);
            traderLog(`   Global Regime: ${context.global_regime}`, logScope);
            traderLog(`   Eligible Candidates (${context.eligible_candidates.length}): ${formatTraderSymbols(context.eligible_candidates)}`, logScope);
            traderLog(`   Existing Positions (${context.existing_positions.length}): ${formatTraderSymbols(context.existing_positions)}`, logScope);

            if (process.env.CENTRYPT_DEBUG_LOGS === "true") {
                traderLog(`Raw LLM response length: ${rawOutput.length}`, logScope);
            }
            if (process.env.CENTRYPT_DEBUG_LLM_TRANSCRIPTS === "true") {
                fs.appendFile('debug_llm_response.log', `\n\n--- ${new Date().toISOString()} ---\nPrompt:\n${redactSensitive(USER_PROMPT)}\n\nResponse:\n${redactSensitive(rawOutput)}\n-----------------------------------\n`).catch(e => traderWarn('⚠️ Debug log write failed:', logScope, e));
            }
            const decisions = parseTraderResponse(rawOutput);
            return { decisions, prompt: SYSTEM_PROMPT + "\n\n" + USER_PROMPT, rawOutput };

        } catch (error) {
            traderError("❌ LLM Decision Error:", logScope, error);
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
                    traderLog(`[enrichDecisions] Dropped ${decision.action} for ${symbol}: riskInfo not eligible.`);
                    return [];
                }
                if (riskInfo?.eligible_playbooks?.length && !this.isPlaybookAllowed(decision.playbook, riskInfo.eligible_playbooks)) {
                    traderLog(`[enrichDecisions] Dropped ${decision.action} for ${symbol}: playbook ${decision.playbook} not allowed.`);
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
        const normalizedOverride = normalizeAutoTraderConfigOverride(configOverride);
        const config: AgentConfig = {
            ...DEFAULT_AGENT_CONFIG,
            ...normalizedOverride,
            network_profiles: { ...DEFAULT_AGENT_CONFIG.network_profiles, ...normalizedOverride?.network_profiles },
            gates: {
                ...DEFAULT_AGENT_CONFIG.gates,
                ...normalizedOverride?.gates,
                cost_bps_max_by_regime: {
                    ...DEFAULT_AGENT_CONFIG.gates.cost_bps_max_by_regime,
                    ...normalizedOverride?.gates?.cost_bps_max_by_regime
                },
                edge_to_cost_mult_by_regime: {
                    ...DEFAULT_AGENT_CONFIG.gates.edge_to_cost_mult_by_regime,
                    ...normalizedOverride?.gates?.edge_to_cost_mult_by_regime
                },
                per_symbol_cost_override: {
                    ...DEFAULT_AGENT_CONFIG.gates.per_symbol_cost_override,
                    ...normalizedOverride?.gates?.per_symbol_cost_override
                }
            },
            risk: { ...DEFAULT_AGENT_CONFIG.risk, ...normalizedOverride?.risk },
            triggers: {
                momentum: { ...DEFAULT_AGENT_CONFIG.triggers.momentum, ...normalizedOverride?.triggers?.momentum },
                mean_reversion: { ...DEFAULT_AGENT_CONFIG.triggers.mean_reversion, ...normalizedOverride?.triggers?.mean_reversion },
                breakout: { ...DEFAULT_AGENT_CONFIG.triggers.breakout, ...normalizedOverride?.triggers?.breakout }
            },
            cost_sanity: { ...DEFAULT_AGENT_CONFIG.cost_sanity, ...normalizedOverride?.cost_sanity },
            correlation: { ...DEFAULT_AGENT_CONFIG.correlation, ...normalizedOverride?.correlation },
            risk_plan_model: {
                ...DEFAULT_AGENT_CONFIG.risk_plan_model,
                ...normalizedOverride?.risk_plan_model,
                vol_anchor_priority: normalizedOverride?.risk_plan_model?.vol_anchor_priority ?? DEFAULT_AGENT_CONFIG.risk_plan_model.vol_anchor_priority,
                multipliers_by_playbook: {
                    ...DEFAULT_AGENT_CONFIG.risk_plan_model.multipliers_by_playbook,
                    ...normalizedOverride?.risk_plan_model?.multipliers_by_playbook
                },
                regime_adjustments: {
                    ...DEFAULT_AGENT_CONFIG.risk_plan_model.regime_adjustments,
                    ...normalizedOverride?.risk_plan_model?.regime_adjustments
                },
                max_width_bps_by_playbook: {
                    ...DEFAULT_AGENT_CONFIG.risk_plan_model.max_width_bps_by_playbook,
                    ...normalizedOverride?.risk_plan_model?.max_width_bps_by_playbook
                },
                min_width_bps_by_playbook: {
                    ...DEFAULT_AGENT_CONFIG.risk_plan_model.min_width_bps_by_playbook,
                    ...normalizedOverride?.risk_plan_model?.min_width_bps_by_playbook
                }
            },
            trade_cooldowns: {
                ...DEFAULT_AGENT_CONFIG.trade_cooldowns,
                ...normalizedOverride?.trade_cooldowns
            },
            strategy_filters: {
                ...DEFAULT_AGENT_CONFIG.strategy_filters,
                ...normalizedOverride?.strategy_filters,
                playbookBlocklist: normalizedOverride?.strategy_filters?.playbookBlocklist ?? DEFAULT_AGENT_CONFIG.strategy_filters.playbookBlocklist,
                symbolSideBlocklist: normalizedOverride?.strategy_filters?.symbolSideBlocklist ?? DEFAULT_AGENT_CONFIG.strategy_filters.symbolSideBlocklist
            },
            position_management: mergePositionManagementConfig(
                normalizedOverride?.position_management,
                DEFAULT_AGENT_CONFIG.position_management
            ),
            sentiment_policy: { ...DEFAULT_AGENT_CONFIG.sentiment_policy, ...normalizedOverride?.sentiment_policy },
            opportunity: { ...DEFAULT_AGENT_CONFIG.opportunity, ...normalizedOverride?.opportunity }
        };
        // Ensure both fraction fields are populated from each other when only one is provided
        config.risk.max_position_fraction = config.risk.max_position_fraction ?? config.risk.max_position_fraction_per_symbol;
        config.risk.max_position_fraction_per_symbol = config.risk.max_position_fraction_per_symbol ?? config.risk.max_position_fraction;
        config.risk.max_effective_leverage = config.risk.max_effective_leverage ?? config.risk.exchange_max_leverage_allowed;
        config.risk.exchange_max_leverage_allowed = config.risk.exchange_max_leverage_allowed ?? config.risk.max_effective_leverage;

        const screenerConfig = normalizeScreenerConfig(
            normalizedOverride.screener,
            resolveScreenerPresetName(normalizedOverride)
        );

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
                traderWarn("⚠️ Unable to backfill snapshot_id into stored snapshot:", undefined, updateError);
            }

            return saved.id;
        } catch (error) {
            traderError("❌ Failed to persist snapshot:", undefined, error);
            return null;
        }
    }

    private async saveLlmInteraction(prompt: string, response: string, decisions: TradeDecision[], isTestnet: boolean, logScope?: string): Promise<number | null> {
        try {
            const storeTranscripts = process.env.CENTRYPT_STORE_LLM_TRANSCRIPTS === "true";
            const saved = await prisma.llmQuery.create({
                data: {
                    prompt: storeTranscripts ? prompt : "[redacted: set CENTRYPT_STORE_LLM_TRANSCRIPTS=true to store prompts]",
                    response: storeTranscripts ? response : "[redacted: set CENTRYPT_STORE_LLM_TRANSCRIPTS=true to store responses]",
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
            traderLog("✅ Saved LLM interaction to DB", logScope);
            return saved.id;
        } catch (error) {
            traderError("❌ Failed to save LLM interaction:", logScope, error);
            return null;
        }
    }

    private clampDecisionRiskPlan(decision: TradeDecision) { clampRiskPlan(decision); }
}

function getDevTestnetExecutionKey(isTestnet: boolean): string | null {
    if (process.env.NODE_ENV === "production") return null;
    if (!isTestnet) return null;
    if (process.env.ALLOW_SERVER_DEV_BOT_EXECUTION !== "true") return null;
    return process.env.HYPERLIQUID_TESTNET_PRIVATE_KEY ?? null;
}

async function resolveExecutionCredential(userAddress: string, isTestnet: boolean): Promise<{
    privateKey: string;
    mode: "user_api_wallet" | "server_dev_testnet_bot";
    apiWalletAddress: string | null;
} | null> {
    try {
        const credential = await getUserHyperliquidApiWalletCredential(userAddress, isTestnet);
        return { privateKey: credential.privateKey, mode: "user_api_wallet", apiWalletAddress: credential.apiWalletAddress };
    } catch (error) {
        if (!(error instanceof HyperliquidApiWalletError) || error.status !== 412) {
            throw error;
        }
        const devKey = getDevTestnetExecutionKey(isTestnet);
        return devKey ? {
            privateKey: devKey,
            mode: "server_dev_testnet_bot",
            apiWalletAddress: deriveHyperliquidApiWalletAddress(devKey)
        } : null;
    }
}

function parseJobConfig(serialized: string | null | undefined): any {
    if (!serialized) return undefined;
    try {
        return JSON.parse(serialized);
    } catch {
        return undefined;
    }
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

function assetIndexMapFromSnapshot(snapshot: StateSnapshot): Map<string, number> {
    const map = new Map<string, number>();
    for (const [symbol, market] of Object.entries(snapshot.markets || {})) {
        if (market.assetIndex !== undefined) map.set(symbol, market.assetIndex);
    }
    return map;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    return Array.from(new Set(values.map(value => value ? String(value) : "").filter(Boolean)));
}

function isPositionManagerOrderAction(action: PositionManagementAction["action"]): boolean {
    return action === "PLACE_BREAKEVEN_STOP" ||
        action === "REPLACE_STOP" ||
        action === "REPLACE_TAKE_PROFIT" ||
        action === "REPLACE_BRACKET" ||
        action === "CANCEL_STALE_ORDER";
}

function formatTraderSymbols(items: Array<{ symbol?: string; side?: string | null }>): string {
    if (items.length === 0) return "none";
    return items.map(item => item.side ? `${item.symbol}: ${item.side}` : item.symbol || "UNKNOWN").join(", ");
}
