import "server-only";

import { execSync } from "child_process";
import { prisma } from "@/lib/db";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { getOrderStatus, getUserFills, getUserFillsByTime } from "@/lib/hyperliquid-info";
import type { AgentConfig } from "@/lib/agent-config";
import { StateSnapshot } from "@/types/snapshot";
import { RiskAssessment, TradeDecision, TraderDecision } from "@/types/trading";
import {
    directionalBps,
    givebackPct as computeGivebackPct,
    netCurrentBps
} from "@/lib/trader/position-management-math";
import { basePlaybookFrom } from "@/lib/trader/position-management-policy";
import type {
    ManagedLifecycleState,
    PositionManagementAction,
    PositionManagementInput,
    PositionManagementResult
} from "@/lib/trader/position-management-types";
import {
    AutoTraderAttributionMethod,
    AutoTraderAttributionStatus,
    AutoTraderCycleType,
    AutoTraderNetwork,
    AutoTraderOrderRole,
    AutoTraderOrderStatus,
    AutoTraderPositionSnapshotPhase,
    ReconstructedLifecycle
} from "@/types/auto-trader-review";
import {
    AUTO_TRADER_RECONSTRUCTION_VERSION,
    computeMfeMaeFromCandles,
    computeMfeMaeFromMarks,
    computeOpenReviewFlags,
    computeReviewFlags,
    enforceMfeMaeExitBounds,
    extractOrderResponseStatus,
    extractOrderStatusOid,
    generateCloid,
    hashJson,
    normalizeHyperliquidFill,
    reconstructTradeLifecycles,
    safeJson
} from "@/lib/auto-trader-review/review-utils";

type PrismaAny = any;

export type AutoTraderOrderAttemptDraft = {
    orderRole: AutoTraderOrderRole;
    symbol: string;
    cloid?: string | null;
    oid?: string | null;
    batchId?: string | null;
    batchIndex: number;
    nonce?: string | null;
    positionSide?: string | null;
    orderSide: "buy" | "sell";
    reduceOnly: boolean;
    intendedSizeUsd?: number | null;
    intendedSizeCoin?: number | null;
    intendedLimitPx?: number | null;
    intendedStopLossPx?: number | null;
    intendedTakeProfitPx?: number | null;
    requestHash?: string | null;
    status?: AutoTraderOrderStatus;
};

type ReviewRunInput = {
    accountAddress: string;
    agentWalletAddress?: string | null;
    vaultAddress?: string | null;
    subAccountAddress?: string | null;
    network: AutoTraderNetwork;
    cycleType?: AutoTraderCycleType;
    model: string;
    config: unknown;
    snapshot?: StateSnapshot | null;
};

type SyncInput = {
    accountAddress: string;
    agentWalletAddress?: string | null;
    network: AutoTraderNetwork;
    startTimeMs?: number;
    endTimeMs?: number;
};

type ReviewQuery = {
    accountAddress: string;
    network: AutoTraderNetwork;
    startTime: Date;
    endTime: Date;
    symbol?: string | null;
    strategy?: string | null;
    includeUnattributed: boolean;
};

const FILL_PAGE_LIMIT = 2000;
const FALLBACK_MATCH_WINDOW_MS = 2 * 60_000;
const FALLBACK_NOTIONAL_TOLERANCE_FRACTION = 0.2;
const FALLBACK_NOTIONAL_TOLERANCE_USD = 5;

export class AutoTraderReviewService {
    private static instance: AutoTraderReviewService;

    public static getInstance(): AutoTraderReviewService {
        if (!AutoTraderReviewService.instance) {
            AutoTraderReviewService.instance = new AutoTraderReviewService();
        }
        return AutoTraderReviewService.instance;
    }

    public async startRun(input: ReviewRunInput): Promise<string | null> {
        if (!this.modelsAvailable()) return null;
        const now = new Date();
        const configJson = safeJson(input.config ?? {});
        const run = await this.model("autoTraderRun").create({
            data: {
                accountAddress: input.accountAddress.toLowerCase(),
                agentWalletAddress: input.agentWalletAddress?.toLowerCase() ?? null,
                vaultAddress: input.vaultAddress ?? null,
                subAccountAddress: input.subAccountAddress ?? null,
                network: input.network,
                cycleType: input.cycleType ?? "SCHEDULED",
                model: input.model,
                strategyVersion: process.env.AUTO_TRADER_STRATEGY_VERSION ?? "v1",
                promptVersion: process.env.AUTO_TRADER_PROMPT_VERSION ?? "v1",
                validatorVersion: process.env.AUTO_TRADER_VALIDATOR_VERSION ?? "v1",
                codeVersion: codeVersion(),
                configHash: hashJson(input.config ?? {}),
                configJson,
                marketSnapshotId: input.snapshot?.meta?.snapshot_id ?? null,
                status: "RUNNING",
                reliableSince: reliableSince(),
                startedAt: now,
                updatedAt: now
            }
        });
        return run.id;
    }

    public async finishRun(runId: string | null, input: { status: "COMPLETED" | "SKIPPED" | "FAILED"; error?: string | null; llmQueryId?: number | null }): Promise<void> {
        if (!runId || !this.modelsAvailable()) return;
        await this.model("autoTraderRun").update({
            where: { id: runId },
            data: {
                status: input.status,
                error: input.error ?? null,
                llmQueryId: input.llmQueryId ?? undefined,
                finishedAt: new Date(),
                updatedAt: new Date()
            }
        });
    }

    public async markStaleRunningRuns(input: {
        accountAddress?: string | null;
        network?: AutoTraderNetwork | null;
        staleBefore: Date;
        status?: "FAILED" | "SKIPPED";
        reason?: string;
    }): Promise<number> {
        if (!this.modelsAvailable()) return 0;
        const result = await this.model("autoTraderRun").updateMany({
            where: {
                status: "RUNNING",
                startedAt: { lt: input.staleBefore },
                ...(input.accountAddress ? { accountAddress: input.accountAddress.toLowerCase() } : {}),
                ...(input.network ? { network: input.network } : {})
            },
            data: {
                status: input.status ?? "FAILED",
                error: input.reason ?? "stale running auto-trader run finalized during claim",
                finishedAt: new Date(),
                updatedAt: new Date()
            }
        });
        return result.count ?? 0;
    }

    public async snapshotPositions(runId: string | null, phase: AutoTraderPositionSnapshotPhase, snapshot: StateSnapshot): Promise<Map<string, string>> {
        const map = new Map<string, string>();
        if (!runId || !this.modelsAvailable()) return map;

        for (const position of snapshot.account.current_positions || []) {
            const market = snapshot.markets[position.symbol];
            const created = await this.model("autoTraderPositionSnapshot").create({
                data: {
                    runId,
                    phase,
                    symbol: position.symbol,
                    side: position.side,
                    entryPrice: position.entry_price,
                    sizeUsd: position.size_usd,
                    sizeCoin: position.size_coin ?? null,
                    markPrice: market?.price ?? null,
                    unrealizedPnl: position.unrealized_pnl,
                    liquidationPrice: (position as any).liquidation_price ?? null,
                    leverage: position.leverage ?? null,
                    marginMode: (position as any).margin_mode ?? null,
                    observedAt: new Date(snapshot.timestamp * 1000),
                    rawJson: safeJson({ position, market: market ? { price: market.price, assetIndex: market.assetIndex } : null })
                }
            });
            map.set(position.symbol, created.id);
        }
        return map;
    }

    public async persistDecisions(input: {
        runId: string | null;
        traderDecisions: (TraderDecision | null)[];
        backendDecisions: TradeDecision[];
        preRiskDecisions?: TradeDecision[];
        riskAssessments?: RiskAssessment[];
        validation: { accepted: boolean; reason: string };
        positionSnapshotIds: Map<string, string>;
    }): Promise<(string | null)[]> {
        if (!input.runId || !this.modelsAvailable()) return input.backendDecisions.map(() => null);
        const rows: (string | null)[] = [];
        for (let i = 0; i < input.backendDecisions.length; i++) {
            const backend = input.backendDecisions[i];
            const preRisk = input.preRiskDecisions?.[i] ?? backend;
            const riskAssessment = input.riskAssessments?.[i] ?? null;
            const raw = input.traderDecisions[i] ?? null;
            const validatorStatus = input.validation.accepted ? "accepted" : "rejected";
            const decisionType = backend.scope === "position" ? "OPEN_POSITION_MANAGEMENT" : "ENTRY_CANDIDATE";
            const created = await this.model("autoTraderDecision").create({
                data: {
                    runId: input.runId,
                    decisionType,
                    candidateId: backend.candidate_id ?? raw?.candidate_id ?? null,
                    positionSnapshotId: backend.scope === "position" && backend.symbol ? input.positionSnapshotIds.get(backend.symbol) ?? null : null,
                    action: backend.action,
                    symbol: backend.symbol ?? "UNKNOWN",
                    side: backend.side ?? raw?.target_side ?? null,
                    confidence: Number.isFinite(backend.confidence) ? backend.confidence : null,
                    skipReason: backend.action === "SKIP" ? backend.reason_code : null,
                    rawLlmDecisionJson: raw ? safeJson(raw) : null,
                    normalizedDecisionJson: safeJson(backend),
                    preRiskDecisionJson: safeJson(preRisk),
                    riskAssessmentJson: riskAssessment ? safeJson(riskAssessment) : null,
                    finalDecisionJson: riskAssessment ? safeJson(backend) : null,
                    finalRiskPlanJson: riskAssessment && backend.risk_plan ? safeJson(backend.risk_plan) : null,
                    submittedOrderPlanJson: null,
                    validatorStatus,
                    validatorErrorsJson: input.validation.accepted ? null : safeJson({ reason: input.validation.reason })
                }
            });
            rows.push(created.id);
        }
        return rows;
    }

    public async createPositionManagerDecision(input: {
        runId: string | null;
        action: PositionManagementAction;
    }): Promise<string | null> {
        if (!input.runId || !this.modelsAvailable()) return null;
        const created = await this.model("autoTraderDecision").create({
            data: {
                runId: input.runId,
                decisionType: "OPEN_POSITION_MANAGEMENT",
                candidateId: null,
                positionSnapshotId: null,
                action: input.action.action,
                symbol: input.action.symbol,
                side: input.action.side,
                confidence: 1,
                skipReason: null,
                rawLlmDecisionJson: null,
                normalizedDecisionJson: safeJson(input.action),
                preRiskDecisionJson: safeJson(input.action),
                riskAssessmentJson: null,
                finalDecisionJson: safeJson(input.action),
                finalRiskPlanJson: null,
                submittedOrderPlanJson: null,
                validatorStatus: "accepted",
                validatorErrorsJson: null
            }
        });
        return created.id;
    }

    public async createOrderAttempts(decisionId: string | null, drafts: AutoTraderOrderAttemptDraft[]): Promise<string[]> {
        if (!decisionId || !this.modelsAvailable()) return [];
        const ids: string[] = [];
        for (const draft of drafts) {
            const created = await this.model("autoTraderOrderAttempt").create({
                data: {
                    decisionId,
                    cloid: draft.cloid ?? null,
                    oid: draft.oid ?? null,
                    batchId: draft.batchId ?? null,
                    batchIndex: draft.batchIndex,
                    nonce: draft.nonce ?? null,
                    orderRole: draft.orderRole,
                    symbol: draft.symbol,
                    positionSide: draft.positionSide ?? null,
                    orderSide: draft.orderSide,
                    reduceOnly: draft.reduceOnly,
                    intendedSizeUsd: finiteOrNull(draft.intendedSizeUsd),
                    intendedSizeCoin: finiteOrNull(draft.intendedSizeCoin),
                    intendedLimitPx: finiteOrNull(draft.intendedLimitPx),
                    intendedStopLossPx: finiteOrNull(draft.intendedStopLossPx),
                    intendedTakeProfitPx: finiteOrNull(draft.intendedTakeProfitPx),
                    submittedAt: new Date(),
                    requestHash: draft.requestHash ?? null,
                    status: draft.status ?? "PLANNED"
                }
            });
            ids.push(created.id);
        }
        return ids;
    }

    public async updateDecisionSubmittedOrderPlan(decisionId: string | null, plan: unknown): Promise<void> {
        if (!decisionId || !this.modelsAvailable()) return;
        await this.model("autoTraderDecision").update({
            where: { id: decisionId },
            data: { submittedOrderPlanJson: safeJson(plan) }
        });
    }

    public async updateOrderAttemptStatusesByIds(
        attemptIds: string[],
        status: AutoTraderOrderStatus,
        reason?: string | null
    ): Promise<void> {
        if (!attemptIds.length || !this.modelsAvailable()) return;
        await this.model("autoTraderOrderAttempt").updateMany({
            where: { id: { in: attemptIds } },
            data: {
                status,
                statusReason: reason ?? null,
                exchangeReceivedAt: new Date()
            }
        });
    }

    public async updateOrderAttemptStatusesByOids(input: {
        accountAddress: string;
        network: AutoTraderNetwork;
        oids: string[];
        status: AutoTraderOrderStatus;
        reason?: string | null;
    }): Promise<void> {
        const oids = input.oids.map(oid => String(oid)).filter(Boolean);
        if (!oids.length || !this.modelsAvailable()) return;
        await this.model("autoTraderOrderAttempt").updateMany({
            where: {
                oid: { in: oids },
                decision: {
                    run: {
                        accountAddress: input.accountAddress.toLowerCase(),
                        network: input.network
                    }
                }
            },
            data: {
                status: input.status,
                statusReason: input.reason ?? null,
                exchangeReceivedAt: new Date()
            }
        });
    }

    public async getAttemptFillSummary(attemptId: string | null): Promise<{
        avgPx: number;
        totalSz: number;
        totalFee: number;
        notionalUsd: number;
        firstFillAt: Date;
    } | null> {
        if (!attemptId || !this.modelsAvailable()) return null;
        const fills = await this.model("autoTraderFill").findMany({
            where: { orderAttemptId: attemptId },
            orderBy: { time: "asc" }
        });
        return fillSummary(fills);
    }

    public async upsertPositionStateAfterEntryFill(input: {
        accountAddress: string;
        network: AutoTraderNetwork;
        lifecycleId?: string | null;
        symbol: string;
        side: "long" | "short";
        entryPrice: number;
        openedAt: Date;
        policyVersion: string;
    }): Promise<void> {
        const stateModel = this.model("autoTraderPositionState", false);
        if (!stateModel?.upsert) return;
        await stateModel.upsert({
            where: {
                accountAddress_network_symbol_side_openedAt: {
                    accountAddress: input.accountAddress.toLowerCase(),
                    network: input.network,
                    symbol: input.symbol,
                    side: input.side,
                    openedAt: input.openedAt
                }
            },
            update: {
                lifecycleId: input.lifecycleId ?? undefined,
                entryPrice: input.entryPrice,
                state: "NEW",
                policyVersion: input.policyVersion
            },
            create: {
                accountAddress: input.accountAddress.toLowerCase(),
                network: input.network,
                lifecycleId: input.lifecycleId ?? null,
                symbol: input.symbol,
                side: input.side,
                state: "NEW",
                entryPrice: input.entryPrice,
                openedAt: input.openedAt,
                highestMfeBps: 0,
                lowestMaeBps: 0,
                peakUnrealizedPnl: 0,
                partialTakenFraction: 0,
                policyVersion: input.policyVersion
            }
        });
    }

    public async getOpenLifecycleStates(accountAddress: string, network: AutoTraderNetwork): Promise<ReconstructedLifecycle[]> {
        if (!this.modelsAvailable()) return [];
        const rows = await this.model("autoTraderTradeLifecycle").findMany({
            where: { accountAddress: accountAddress.toLowerCase(), network, status: "OPEN" },
            orderBy: { openedAt: "desc" },
            take: 100
        });
        return rows.map((row: any) => ({
            id: row.id,
            accountAddress: row.accountAddress,
            network: row.network,
            symbol: row.symbol,
            side: row.side,
            openedAt: row.openedAt,
            closedAt: row.closedAt,
            status: row.status,
            openFillIds: parseJsonArray(row.openFillIds),
            closeFillIds: parseJsonArray(row.closeFillIds),
            attributedDecisionIds: parseJsonArray(row.attributedDecisionIds),
            attributedOrderAttemptIds: parseJsonArray(row.attributedOrderAttemptIds),
            entryPrice: row.entryPrice,
            exitPrice: row.exitPrice,
            sizeOpened: row.sizeOpened,
            sizeClosed: row.sizeClosed,
            grossRealizedPnl: row.grossRealizedPnl,
            fees: row.fees,
            netRealizedPnl: row.netRealizedPnl,
            attributionMethod: row.attributionMethod,
            closeAction: row.closeAction,
            closeReasonCode: row.closeReasonCode,
            closeAttemptStatus: row.closeAttemptStatus,
            rawDebugJson: parseJsonObject(row.rawDebugJson),
            mfeBps: row.mfeBps,
            maeBps: row.maeBps
        }));
    }

    public async getManagedLifecycleStates(
        accountAddress: string,
        network: AutoTraderNetwork,
        snapshot: StateSnapshot,
        config: AgentConfig
    ): Promise<ManagedLifecycleState[]> {
        const openLifecycleRows = await this.getOpenLifecycleStates(accountAddress, network);
        const stateModel = this.model("autoTraderPositionState", false);
        const stateRows = stateModel?.findMany
            ? await stateModel.findMany({
                where: {
                    accountAddress: accountAddress.toLowerCase(),
                    network,
                    symbol: { in: snapshot.account.current_positions.map(position => position.symbol) }
                },
                orderBy: { updatedAt: "desc" },
                take: 200
            })
            : [];

        const lifecycleByKey = new Map(openLifecycleRows.map(row => [positionStateKey(row.symbol, row.side), row]));
        const stateByLifecycleId = new Map<string, any>();
        const stateByKey = new Map<string, any>();
        for (const row of stateRows) {
            if (row.lifecycleId && !stateByLifecycleId.has(row.lifecycleId)) stateByLifecycleId.set(row.lifecycleId, row);
            const key = positionStateKey(row.symbol, row.side);
            if (!stateByKey.has(key)) stateByKey.set(key, row);
        }

        return snapshot.account.current_positions.map(position => {
            const key = positionStateKey(position.symbol, position.side);
            const lifecycle = lifecycleByKey.get(key);
            const prior = lifecycle?.id ? stateByLifecycleId.get(lifecycle.id) ?? stateByKey.get(key) : stateByKey.get(key);
            const market = snapshot.markets[position.symbol];
            const entryPrice = positive(lifecycle?.entryPrice) ?? positive(position.entry_price) ?? 0;
            const currentPrice = positive(market?.price) ?? entryPrice;
            const estimatedFeeBps = estimatedPositionFeeBps(market, config, network);
            const grossCurrentBps = directionalBps(position.side, entryPrice, currentPrice);
            const netBps = netCurrentBps(grossCurrentBps, estimatedFeeBps, config.position_management.global.exitFeeBufferBps);
            const ageMinutes = finite(position.position_age_min)
                ?? (lifecycle?.openedAt ? Math.max(0, (snapshot.timestamp * 1000 - new Date(lifecycle.openedAt).getTime()) / 60_000) : 0);
            const openedAt = lifecycle?.openedAt
                ? new Date(lifecycle.openedAt)
                : new Date((snapshot.timestamp - ageMinutes * 60) * 1000);
            const lifecycleMfe = finite(lifecycle?.mfeBps);
            const priorMfe = finite(prior?.highestMfeBps);
            const mfeBps = Math.max(0, grossCurrentBps, lifecycleMfe ?? Number.NEGATIVE_INFINITY, priorMfe ?? Number.NEGATIVE_INFINITY);
            const lifecycleMae = finite(lifecycle?.maeBps);
            const priorMae = finite(prior?.lowestMaeBps);
            const maeBps = Math.min(0, grossCurrentBps, lifecycleMae ?? Number.POSITIVE_INFINITY, priorMae ?? Number.POSITIVE_INFINITY);
            const entryNotional = position.size_coin && entryPrice > 0 ? position.size_coin * entryPrice : position.size_usd;
            const peakFromMfe = entryNotional > 0 ? entryNotional * (mfeBps / 10000) : null;
            const peakUnrealizedPnlUsd = Math.max(
                Number(position.unrealized_pnl ?? 0),
                finite(prior?.peakUnrealizedPnl) ?? Number.NEGATIVE_INFINITY,
                peakFromMfe ?? Number.NEGATIVE_INFINITY
            );
            const drawdownFromPeakUsd = Number.isFinite(peakUnrealizedPnlUsd)
                ? peakUnrealizedPnlUsd - Number(position.unrealized_pnl ?? 0)
                : null;
            const playbook = String((position as any).playbook_when_opened ?? playbookFromLifecycle(lifecycle) ?? "") || null;
            const basePlaybook = basePlaybookFrom(playbook);
            const bookPressure = finite(market?.orderbook?.book_pressure);

            return {
                lifecycleId: lifecycle?.id ?? null,
                symbol: position.symbol,
                side: position.side,
                openedAt,
                ageMinutes,
                entryPrice,
                currentPrice,
                sizeUsd: position.size_usd,
                sizeCoin: position.size_coin,
                exposureFraction: position.fraction_of_equity,
                currentUnrealizedPnlUsd: Number(position.unrealized_pnl ?? 0),
                grossCurrentBps,
                estimatedFeeBps,
                netCurrentBps: netBps,
                mfeBps,
                maeBps,
                givebackPct: computeGivebackPct(mfeBps, netBps),
                peakUnrealizedPnlUsd: Number.isFinite(peakUnrealizedPnlUsd) ? peakUnrealizedPnlUsd : null,
                drawdownFromPeakUsd,
                playbook,
                basePlaybook,
                entryReasonCode: typeof (position as any).llm_reason_when_opened === "string" ? (position as any).llm_reason_when_opened : null,
                entryConfidence: null,
                regimeAtEntry: (position as any).regim_when_opening ?? null,
                currentRegime: snapshot.global_regime.current,
                marketTags: marketTagsForManagedPosition(market),
                liquidationPrice: finite((position as any).liquidation_price),
                marketSignal: {
                    edgeOk: market?.derived?.edge?.edge_ok ?? null,
                    entryOk: market?.derived?.entry?.entry_ok ?? null,
                    riskEligible: market?.derived?.risk?.eligible ?? null,
                    bookPressure,
                    bookPressureAlignment: bookPressureAlignment(position.side, bookPressure),
                    trendAligned: market?.derived?.triggers?.trend_aligned ?? null,
                    volRatio5mVs1h: market?.derived?.normalized?.vol_ratio_5m_vs_1h ?? market?.vol_zscores?.vol_5m_vs_1h ?? null,
                    retSigma5mVs1h: market?.derived?.normalized?.ret_sigma_5m_vs_1h ?? market?.vol_zscores?.ret_5m_vs_1h ?? null,
                    reasonsFailed: market?.derived?.entry?.reasons_failed ?? []
                },
                priorManagementState: prior ? {
                    state: prior.state,
                    highestMfeBps: prior.highestMfeBps,
                    lowestMaeBps: prior.lowestMaeBps,
                    peakUnrealizedPnl: prior.peakUnrealizedPnl,
                    partialTakenFraction: prior.partialTakenFraction,
                    protectedAt: prior.protectedAt,
                    lastActionAt: prior.lastActionAt,
                    lastAction: prior.lastAction,
                    lastReasonCode: prior.lastReasonCode,
                    lastStopPx: prior.lastStopPx,
                    lastTakeProfitPx: prior.lastTakeProfitPx
                } : null
            };
        });
    }

    public async persistPositionManagementResult(input: {
        runId: string | null;
        managementInput: PositionManagementInput;
        result: PositionManagementResult;
    }): Promise<void> {
        const stateModel = this.model("autoTraderPositionState", false);
        const eventModel = this.model("autoTraderPositionManagementEvent", false);
        if (!stateModel?.findFirst || !eventModel?.create) return;

        const positionByKey = new Map(input.managementInput.openLifecycles.map(position => [positionStateKey(position.symbol, position.side), position]));
        for (const action of input.result.actions) {
            const position = positionByKey.get(positionStateKey(action.symbol, action.side));
            if (!position) continue;
            const existing = await stateModel.findFirst({
                where: {
                    accountAddress: input.managementInput.accountAddress.toLowerCase(),
                    network: input.managementInput.network,
                    symbol: action.symbol,
                    side: action.side,
                    openedAt: position.openedAt
                }
            });

            const partialTakenFraction = Math.min(1, Math.max(
                Number(existing?.partialTakenFraction ?? position.priorManagementState?.partialTakenFraction ?? 0),
                action.action === "REDUCE_POSITION" ? action.reduceFraction ?? 0 : 0
            ));
            const protectedAt = action.stopReplacement
                ? input.managementInput.now
                : existing?.protectedAt ?? position.priorManagementState?.protectedAt ?? null;
            const lastActionAt = action.action === "HOLD_POSITION" || action.action === "NO_ACTION"
                ? existing?.lastActionAt ?? position.priorManagementState?.lastActionAt ?? null
                : input.managementInput.now;
            const data = {
                accountAddress: input.managementInput.accountAddress.toLowerCase(),
                network: input.managementInput.network,
                lifecycleId: position.lifecycleId,
                symbol: action.symbol,
                side: action.side,
                state: action.stateAfter,
                entryPrice: position.entryPrice,
                openedAt: position.openedAt,
                highestMfeBps: maxNullable(existing?.highestMfeBps, position.mfeBps),
                lowestMaeBps: minNullable(existing?.lowestMaeBps, position.maeBps),
                peakUnrealizedPnl: maxNullable(existing?.peakUnrealizedPnl, position.peakUnrealizedPnlUsd),
                partialTakenFraction,
                protectedAt,
                lastActionAt,
                lastAction: action.action === "HOLD_POSITION" || action.action === "NO_ACTION" ? existing?.lastAction ?? null : action.action,
                lastReasonCode: action.action === "HOLD_POSITION" || action.action === "NO_ACTION" ? existing?.lastReasonCode ?? null : action.reasonCode,
                lastStopPx: action.stopReplacement?.stopPx ?? existing?.lastStopPx ?? null,
                lastTakeProfitPx: action.takeProfitReplacement?.takeProfitPx ?? existing?.lastTakeProfitPx ?? null,
                policyVersion: input.managementInput.config.position_management.version
            };

            const state = existing
                ? await stateModel.update({ where: { id: existing.id }, data })
                : await stateModel.create({ data });

            await eventModel.create({
                data: {
                    accountAddress: input.managementInput.accountAddress.toLowerCase(),
                    network: input.managementInput.network,
                    runId: input.runId,
                    lifecycleId: action.lifecycleId,
                    positionStateId: state.id,
                    symbol: action.symbol,
                    side: action.side,
                    stateBefore: action.stateBefore,
                    stateAfter: action.stateAfter,
                    action: action.action,
                    urgency: action.urgency,
                    bypassLlm: action.bypassLlm,
                    reasonCode: action.reasonCode,
                    notes: action.notes,
                    targetSizeFractionOfEquity: finiteOrNull(action.targetSizeFractionOfEquity),
                    reduceFraction: finiteOrNull(action.reduceFraction),
                    stopReplacementJson: action.stopReplacement ? safeJson(action.stopReplacement) : null,
                    takeProfitReplacementJson: action.takeProfitReplacement ? safeJson(action.takeProfitReplacement) : null,
                    cancelOrderOidsJson: action.cancelOrderOids ? safeJson(action.cancelOrderOids) : null,
                    evidenceJson: safeJson(action.evidence)
                }
            });
        }
    }

    public async updateOrderAttemptsFromResponse(input: {
        attemptIds: string[];
        response: any;
        submittedAt: Date;
        exchangeReceivedAt: Date;
        error?: unknown;
    }): Promise<void> {
        if (!input.attemptIds.length || !this.modelsAvailable()) return;
        const latencyMs = input.exchangeReceivedAt.getTime() - input.submittedAt.getTime();
        for (let i = 0; i < input.attemptIds.length; i++) {
            const parsed = input.error
                ? { status: "ERROR" as AutoTraderOrderStatus, oid: null, reason: errorMessage(input.error) }
                : extractOrderResponseStatus(input.response, i);
            await this.model("autoTraderOrderAttempt").update({
                where: { id: input.attemptIds[i] },
                data: {
                    oid: parsed.oid ?? undefined,
                    status: parsed.status,
                    statusReason: parsed.reason,
                    exchangeReceivedAt: input.exchangeReceivedAt,
                    latencyMs,
                    rawExchangeResponseJson: input.error ? undefined : safeJson(input.response),
                    rawExchangeErrorJson: input.error ? safeJson({ message: errorMessage(input.error), error: String(input.error) }) : undefined
                }
            });
        }
    }

    public async updateRunAgentWalletFromDecision(decisionId: string | null, agentWalletAddress: string | null): Promise<void> {
        if (!decisionId || !agentWalletAddress || !this.modelsAvailable()) return;
        const decision = await this.model("autoTraderDecision").findUnique({
            where: { id: decisionId },
            select: { runId: true }
        });
        if (!decision?.runId) return;
        await this.model("autoTraderRun").update({
            where: { id: decision.runId },
            data: { agentWalletAddress: agentWalletAddress.toLowerCase() }
        });
    }

    public async updateRunAgentWallet(runId: string | null, agentWalletAddress: string | null): Promise<void> {
        if (!runId || !agentWalletAddress || !this.modelsAvailable()) return;
        await this.model("autoTraderRun").update({
            where: { id: runId },
            data: { agentWalletAddress: agentWalletAddress.toLowerCase() }
        });
    }

    public buildOrderAttemptDrafts(input: {
        decision: TradeDecision;
        symbol: string;
        currentPrice: number;
        sizeCoin: number;
        sizeUsd: number;
        limitPx: number;
        isBuy: boolean;
        reduceOnly: boolean;
        stopLossPrice?: number;
        takeProfitPrice?: number;
        nonce: number;
        requestHashSeed: unknown;
    }): AutoTraderOrderAttemptDraft[] {
        const attachCloids = process.env.AUTO_TRADER_ATTACH_CLOID !== "false";
        const batchId = hashJson({ nonce: input.nonce, symbol: input.symbol, seed: input.requestHashSeed }).slice(0, 24);
        const orderSide = input.isBuy ? "buy" : "sell";
        const positionSide = input.decision.target_side === "flat" ? input.decision.side : input.decision.target_side;
        const mainRole: AutoTraderOrderRole = input.decision.action === "REDUCE_POSITION"
            ? "REDUCE"
            : input.decision.action === "CLOSE_POSITION"
                ? "CLOSE"
                : "ENTRY";
        const drafts: AutoTraderOrderAttemptDraft[] = [{
            orderRole: mainRole,
            symbol: input.symbol,
            cloid: attachCloids ? generateCloid() : null,
            batchId,
            batchIndex: 0,
            nonce: String(input.nonce),
            positionSide: positionSide ?? null,
            orderSide,
            reduceOnly: input.reduceOnly,
            intendedSizeUsd: input.sizeUsd,
            intendedSizeCoin: input.sizeCoin,
            intendedLimitPx: input.limitPx,
            requestHash: hashJson(input.requestHashSeed),
            status: "PLANNED"
        }];

        if (!input.reduceOnly && input.stopLossPrice) {
            drafts.push({
                orderRole: "STOP_LOSS",
                symbol: input.symbol,
                cloid: attachCloids ? generateCloid() : null,
                batchId,
                batchIndex: drafts.length,
                nonce: String(input.nonce),
                positionSide: input.decision.target_side,
                orderSide: input.isBuy ? "sell" : "buy",
                reduceOnly: true,
                intendedSizeUsd: input.sizeUsd,
                intendedSizeCoin: input.sizeCoin,
                intendedStopLossPx: input.stopLossPrice,
                status: "PLANNED"
            });
        }

        if (!input.reduceOnly && input.takeProfitPrice) {
            drafts.push({
                orderRole: "TAKE_PROFIT",
                symbol: input.symbol,
                cloid: attachCloids ? generateCloid() : null,
                batchId,
                batchIndex: drafts.length,
                nonce: String(input.nonce),
                positionSide: input.decision.target_side,
                orderSide: input.isBuy ? "sell" : "buy",
                reduceOnly: true,
                intendedSizeUsd: input.sizeUsd,
                intendedSizeCoin: input.sizeCoin,
                intendedTakeProfitPx: input.takeProfitPrice,
                status: "PLANNED"
            });
        }

        return drafts;
    }

    public buildBracketOrderAttemptDrafts(input: {
        symbol: string;
        positionSide: "long" | "short";
        sizeCoin: number;
        sizeUsd: number;
        stopLossPrice?: number | null;
        takeProfitPrice?: number | null;
        nonce: number;
        requestHashSeed: unknown;
    }): AutoTraderOrderAttemptDraft[] {
        const attachCloids = process.env.AUTO_TRADER_ATTACH_CLOID !== "false";
        const batchId = hashJson({ nonce: input.nonce, symbol: input.symbol, seed: input.requestHashSeed }).slice(0, 24);
        const orderSide = input.positionSide === "long" ? "sell" : "buy";
        const drafts: AutoTraderOrderAttemptDraft[] = [];

        if (input.stopLossPrice) {
            drafts.push({
                orderRole: "STOP_LOSS",
                symbol: input.symbol,
                cloid: attachCloids ? generateCloid() : null,
                batchId,
                batchIndex: drafts.length,
                nonce: String(input.nonce),
                positionSide: input.positionSide,
                orderSide,
                reduceOnly: true,
                intendedSizeUsd: input.sizeUsd,
                intendedSizeCoin: input.sizeCoin,
                intendedStopLossPx: input.stopLossPrice,
                requestHash: hashJson({ ...(input.requestHashSeed as any), orderRole: "STOP_LOSS" }),
                status: "PLANNED"
            });
        }

        if (input.takeProfitPrice) {
            drafts.push({
                orderRole: "TAKE_PROFIT",
                symbol: input.symbol,
                cloid: attachCloids ? generateCloid() : null,
                batchId,
                batchIndex: drafts.length,
                nonce: String(input.nonce),
                positionSide: input.positionSide,
                orderSide,
                reduceOnly: true,
                intendedSizeUsd: input.sizeUsd,
                intendedSizeCoin: input.sizeCoin,
                intendedTakeProfitPx: input.takeProfitPrice,
                requestHash: hashJson({ ...(input.requestHashSeed as any), orderRole: "TAKE_PROFIT" }),
                status: "PLANNED"
            });
        }

        return drafts;
    }

    public async syncFills(input: SyncInput): Promise<{ fetched: number; upserted: number; matched: number; fallbackMatched: number; unmatched: number; lifecycles: number }> {
        if (!this.modelsAvailable()) return { fetched: 0, upserted: 0, matched: 0, fallbackMatched: 0, unmatched: 0, lifecycles: 0 };
        const fills = await this.fetchFills(input);
        let upserted = 0;

        for (const fill of fills.map(fill => normalizeHyperliquidFill(fill, input))) {
            await this.model("autoTraderFill").upsert({
                where: { dedupeKey: fill.dedupeKey },
                update: {
                    agentWalletAddress: fill.agentWalletAddress,
                    rawCoin: fill.rawCoin,
                    normalizedSymbol: fill.normalizedSymbol,
                    px: fill.px,
                    sz: fill.sz,
                    side: fill.side,
                    dir: fill.dir,
                    closedPnl: fill.closedPnl,
                    fee: fill.fee,
                    hash: fill.hash,
                    oid: fill.oid,
                    cloid: fill.cloid,
                    tid: fill.tid,
                    time: fill.time,
                    fillType: fill.fillType,
                    rawJson: fill.rawJson
                },
                create: {
                    ...fill,
                    attributionStatus: "UNMATCHED",
                    attributionMethod: "UNMATCHED"
                }
            });
            upserted++;
        }

        await this.backfillOrderIdsByCloid(input.accountAddress, input.network);
        const attribution = await this.attributeFills(input.accountAddress, input.network);
        const lifecycles = await this.rebuildLifecycles(input.accountAddress, input.network);

        return {
            fetched: fills.length,
            upserted,
            matched: attribution.matched,
            fallbackMatched: attribution.fallbackMatched,
            unmatched: attribution.unmatched,
            lifecycles
        };
    }

    public async getReview(query: ReviewQuery): Promise<any> {
        const whereLifecycle: any = {
            accountAddress: query.accountAddress,
            network: query.network,
            openedAt: { lte: query.endTime },
            OR: [
                { closedAt: null },
                { closedAt: { gte: query.startTime } }
            ]
        };
        if (query.symbol) whereLifecycle.symbol = query.symbol;
        if (!query.includeUnattributed) whereLifecycle.attributionMethod = { not: "UNMATCHED" };

        const positionEventModel = this.model("autoTraderPositionManagementEvent", false);
        const [lifecycles, runs, fills, openSnapshots, reliableRun, positionManagementEvents] = await Promise.all([
            this.model("autoTraderTradeLifecycle").findMany({
                where: whereLifecycle,
                orderBy: [{ status: "asc" }, { openedAt: "desc" }],
                take: 200
            }),
            this.model("autoTraderRun").findMany({
                where: {
                    accountAddress: query.accountAddress,
                    network: query.network,
                    startedAt: { gte: query.startTime, lte: query.endTime }
                },
                include: { decisions: { include: { orderAttempts: true } } },
                orderBy: { startedAt: "desc" },
                take: 50
            }),
            this.model("autoTraderFill").findMany({
                where: {
                    accountAddress: query.accountAddress,
                    network: query.network,
                    time: { gte: query.startTime, lte: query.endTime }
                }
            }),
            this.model("autoTraderPositionSnapshot").findMany({
                where: {
                    run: { accountAddress: query.accountAddress, network: query.network },
                    phase: { in: ["POST_EXECUTION", "PERIODIC_SYNC"] },
                    observedAt: { gte: query.startTime, lte: query.endTime }
                },
                orderBy: { observedAt: "desc" },
                take: 100
            }),
            this.model("autoTraderRun").findFirst({
                where: {
                    accountAddress: query.accountAddress,
                    network: query.network
                },
                orderBy: { startedAt: "asc" },
                select: { reliableSince: true, startedAt: true }
            }),
            positionEventModel?.findMany
                ? positionEventModel.findMany({
                    where: {
                        accountAddress: query.accountAddress,
                        network: query.network,
                        createdAt: { gte: query.startTime, lte: query.endTime },
                        ...(query.symbol ? { symbol: query.symbol } : {})
                    },
                    orderBy: { createdAt: "desc" },
                    take: 200
                })
                : Promise.resolve([])
        ]);

        const reliableSince = this.reliableSinceFor(query.accountAddress, query.network, runs, reliableRun);
        const reliableSinceDate = reliableSince ? new Date(reliableSince) : null;
        const attributed = lifecycles.filter((row: any) => row.attributionMethod !== "UNMATCHED");
        const unattributedFills = fills.filter((row: any) => row.attributionStatus === "UNMATCHED");
        const historicalUnmatchedFills = reliableSinceDate && Number.isFinite(reliableSinceDate.getTime())
            ? unattributedFills.filter((row: any) => new Date(row.time).getTime() < reliableSinceDate.getTime())
            : [];
        const postReliableUnmatchedFills = reliableSinceDate && Number.isFinite(reliableSinceDate.getTime())
            ? unattributedFills.filter((row: any) => new Date(row.time).getTime() >= reliableSinceDate.getTime())
            : unattributedFills;
        const closed = lifecycles.filter((row: any) => row.status === "CLOSED");
        const open = lifecycles.filter((row: any) => row.status === "OPEN");
        const redFlags = closed.filter((row: any) => row.closedGreenToRed || row.closedLateGiveback || row.observedGreenToRed || row.lateGiveback);

        return {
            warning: `Historical attribution before instrumentation is approximate. Reliable attribution starts from: ${reliableSince ?? "not established yet"}.`,
            summary: summarizeLifecycles(lifecycles, fills),
            attributedSummary: summarizeLifecycles(attributed, fills.filter((row: any) => row.attributionStatus !== "UNMATCHED")),
            unattributedSummary: summarizeUnattributed(unattributedFills),
            openPositions: open.map((row: any) => this.openPositionDto(row, openSnapshots)),
            closedLifecycles: closed.map(lifecycleDto),
            runs: runs.map(runDto),
            redFlags: redFlags.map(lifecycleDto),
            positionManagementEvents: positionManagementEvents.map(positionManagementEventDto),
            positionManagementSummary: summarizePositionManagementEvents(positionManagementEvents),
            skippedOpportunities: await this.skippedOpportunities(query, runs),
            syncStatus: {
                fillCount: fills.length,
                lastFillAt: fills.reduce((latest: string | null, fill: any) => latestDate(latest, fill.time), null),
                unmatchedFillCount: unattributedFills.length,
                historicalUnmatchedFillCount: historicalUnmatchedFills.length,
                postReliableUnmatchedFillCount: postReliableUnmatchedFills.length
            },
            coverage: {
                reliableSince,
                attributionBoundary: "instrumentation_deployment"
            }
        };
    }

    private async fetchFills(input: SyncInput): Promise<any[]> {
        const start = input.startTimeMs ?? Date.now() - 30 * 24 * 60 * 60 * 1000;
        const end = input.endTimeMs ?? Date.now();
        const results: any[] = [];
        let cursor = start;
        let loops = 0;

        while (cursor <= end && loops < 20) {
            loops++;
            const page = await getUserFillsByTime(input.accountAddress, input.network === "testnet", cursor, end);
            if (!Array.isArray(page) || page.length === 0) break;
            results.push(...page);
            if (page.length < FILL_PAGE_LIMIT) break;
            const maxTime = Math.max(...page.map((fill: any) => Number(fill?.time ?? 0)).filter(Number.isFinite));
            if (!Number.isFinite(maxTime) || maxTime <= cursor) break;
            cursor = maxTime + 1;
        }

        if (results.length === 0 && !input.startTimeMs) {
            const recent = await getUserFills(input.accountAddress, input.network === "testnet");
            return Array.isArray(recent) ? recent : [];
        }
        return results;
    }

    private async backfillOrderIdsByCloid(accountAddress: string, network: AutoTraderNetwork): Promise<void> {
        const attempts = await this.model("autoTraderOrderAttempt").findMany({
            where: {
                cloid: { not: null },
                oid: null,
                decision: { run: { accountAddress, network } }
            },
            take: 50
        });

        for (const attempt of attempts) {
            try {
                const status = await getOrderStatus(accountAddress, attempt.cloid, network === "testnet");
                const oid = extractOrderStatusOid(status);
                if (oid) {
                    await this.model("autoTraderOrderAttempt").update({
                        where: { id: attempt.id },
                        data: {
                            oid,
                            rawExchangeResponseJson: attempt.rawExchangeResponseJson ?? safeJson(status)
                        }
                    });
                }
            } catch {
                // Order-status backfill is best-effort; fill matching still has fallbacks.
            }
        }
    }

    private async attributeFills(accountAddress: string, network: AutoTraderNetwork): Promise<{ matched: number; fallbackMatched: number; unmatched: number }> {
        const fills = await this.model("autoTraderFill").findMany({
            where: { accountAddress, network },
            orderBy: { time: "asc" }
        });

        let matched = 0;
        let fallbackMatched = 0;
        let unmatched = 0;

        for (const fill of fills) {
            const exact = await this.findExactAttempt(fill, accountAddress, network);
            if (exact) {
                await this.markFillAttributed(fill, exact, exact.method, exact.method === "FALLBACK" ? "FALLBACK_MATCHED" : "MATCHED");
                if (exact.method === "FALLBACK") fallbackMatched++;
                else matched++;
                continue;
            }

            const fallback = await this.findFallbackAttempt(fill, accountAddress, network);
            if (fallback) {
                await this.markFillAttributed(fill, fallback, "FALLBACK", "FALLBACK_MATCHED");
                fallbackMatched++;
            } else {
                await this.model("autoTraderFill").update({
                    where: { id: fill.id },
                    data: {
                        attributionStatus: "UNMATCHED",
                        attributionMethod: "UNMATCHED",
                        orderAttemptId: null,
                        decisionId: null
                    }
                });
                unmatched++;
            }
        }

        return { matched, fallbackMatched, unmatched };
    }

    private async findExactAttempt(fill: any, accountAddress: string, network: AutoTraderNetwork): Promise<(any & { method: AutoTraderAttributionMethod }) | null> {
        if (fill.oid) {
            const attempt = await this.model("autoTraderOrderAttempt").findFirst({
                where: {
                    oid: String(fill.oid),
                    decision: { run: { accountAddress, network } }
                }
            });
            if (attempt) return { ...attempt, method: "ORDER_ID" };
        }
        if (fill.cloid) {
            const attempt = await this.model("autoTraderOrderAttempt").findFirst({
                where: {
                    cloid: String(fill.cloid),
                    decision: { run: { accountAddress, network } }
                }
            });
            if (attempt) return { ...attempt, method: attempt.oid ? "CLOID_TO_OID" : "CLOID" };
        }
        return null;
    }

    private async findFallbackAttempt(fill: any, accountAddress: string, network: AutoTraderNetwork): Promise<any | null> {
        const orderSide = fill.side === "B" ? "buy" : fill.side === "A" ? "sell" : null;
        if (!orderSide) return null;
        const notional = fill.px * fill.sz;
        const candidates = await this.model("autoTraderOrderAttempt").findMany({
            where: {
                symbol: fill.normalizedSymbol,
                orderSide,
                submittedAt: {
                    gte: new Date(fill.time.getTime() - FALLBACK_MATCH_WINDOW_MS),
                    lte: new Date(fill.time.getTime() + FALLBACK_MATCH_WINDOW_MS)
                },
                decision: { run: { accountAddress, network } }
            },
            orderBy: { submittedAt: "desc" },
            take: 10
        });

        return candidates.find((attempt: any) => {
            const intended = Number(attempt.intendedSizeUsd ?? 0);
            if (!Number.isFinite(intended) || intended <= 0) return true;
            const tolerance = Math.max(FALLBACK_NOTIONAL_TOLERANCE_USD, intended * FALLBACK_NOTIONAL_TOLERANCE_FRACTION);
            return Math.abs(intended - notional) <= tolerance;
        }) ?? null;
    }

    private async markFillAttributed(fill: any, attempt: any, method: AutoTraderAttributionMethod, status: AutoTraderAttributionStatus): Promise<void> {
        await this.model("autoTraderFill").update({
            where: { id: fill.id },
            data: {
                orderAttemptId: attempt.id,
                decisionId: attempt.decisionId,
                attributionStatus: status,
                attributionMethod: method
            }
        });

        const syncFilledRole = (fill.fillType === "CLOSE" && (attempt.orderRole === "TAKE_PROFIT" || attempt.orderRole === "STOP_LOSS" || attempt.orderRole === "CLOSE" || attempt.orderRole === "REDUCE")) ||
            (fill.fillType === "OPEN" && attempt.orderRole === "ENTRY");
        if (syncFilledRole) {
            await this.model("autoTraderOrderAttempt").update({
                where: { id: attempt.id },
                data: { status: "FILLED_FROM_SYNC" }
            });
        }
    }

    private async rebuildLifecycles(accountAddress: string, network: AutoTraderNetwork): Promise<number> {
        const fills = await this.model("autoTraderFill").findMany({
            where: { accountAddress, network },
            include: { orderAttempt: true },
            orderBy: { time: "asc" }
        });
        const lifecycleFills = fills.map((fill: any) => ({
            ...fill,
            orderAttemptRole: fill.orderAttempt?.orderRole ?? null,
            orderAttemptStatus: fill.orderAttempt?.status ?? null
        }));
        const reconstructed = reconstructTradeLifecycles({ accountAddress, network, fills: lifecycleFills });

        await this.model("autoTraderTradeLifecycle").deleteMany({ where: { accountAddress, network } });

        let count = 0;
        for (const lifecycle of reconstructed) {
            const decorated = await this.decorateLifecycle(lifecycle);
            const created = await this.model("autoTraderTradeLifecycle").create({
                data: {
                    accountAddress,
                    network,
                    symbol: lifecycle.symbol,
                    side: lifecycle.side,
                    openedAt: lifecycle.openedAt,
                    closedAt: lifecycle.closedAt,
                    status: lifecycle.status,
                    openFillIds: safeJson(lifecycle.openFillIds),
                    closeFillIds: safeJson(lifecycle.closeFillIds),
                    attributedDecisionIds: safeJson(lifecycle.attributedDecisionIds),
                    attributedOrderAttemptIds: safeJson(lifecycle.attributedOrderAttemptIds),
                    entryPrice: lifecycle.entryPrice,
                    exitPrice: lifecycle.exitPrice,
                    sizeOpened: lifecycle.sizeOpened,
                    sizeClosed: lifecycle.sizeClosed,
                    grossRealizedPnl: lifecycle.grossRealizedPnl,
                    fees: lifecycle.fees,
                    netRealizedPnl: lifecycle.netRealizedPnl,
                    attributionMethod: lifecycle.attributionMethod,
                    reconstructionVersion: AUTO_TRADER_RECONSTRUCTION_VERSION,
                    rawDebugJson: safeJson(lifecycle.rawDebugJson),
                    mfeBps: decorated.mfeBps,
                    maeBps: decorated.maeBps,
                    mfeSource: decorated.source,
                    mfeCoverage: decorated.coverage,
                    observedGreenToRed: decorated.flags.observedGreenToRed,
                    lateGiveback: decorated.flags.lateGiveback,
                    givebackPct: decorated.flags.givebackPct,
                    openWasGreenNowRed: decorated.flags.openWasGreenNowRed,
                    openLateGiveback: decorated.flags.openLateGiveback,
                    openGivebackPct: decorated.flags.openGivebackPct,
                    closedGreenToRed: decorated.flags.closedGreenToRed,
                    closedLateGiveback: decorated.flags.closedLateGiveback,
                    closeAction: lifecycle.closeAction ?? null,
                    closeReasonCode: lifecycle.closeReasonCode ?? null,
                    closeAttemptStatus: lifecycle.closeAttemptStatus ?? null
                }
            });
            const fillIds = [...lifecycle.openFillIds, ...lifecycle.closeFillIds];
            if (fillIds.length > 0) {
                await this.model("autoTraderFill").updateMany({
                    where: { id: { in: fillIds } },
                    data: { lifecycleId: created.id }
                });
            }
            count++;
        }
        return count;
    }

    private async decorateLifecycle(lifecycle: ReconstructedLifecycle): Promise<{
        mfeBps: number | null;
        maeBps: number | null;
        source: string;
        coverage: string;
        flags: {
            observedGreenToRed: boolean;
            lateGiveback: boolean;
            givebackPct: number | null;
            openWasGreenNowRed: boolean;
            openLateGiveback: boolean;
            openGivebackPct: number | null;
            closedGreenToRed: boolean;
            closedLateGiveback: boolean;
        };
    }> {
        const end = lifecycle.closedAt ?? new Date();
        const expectedMinutes = Math.max(1, Math.ceil((end.getTime() - lifecycle.openedAt.getTime()) / 60_000));
        const marketDb = lifecycle.network === "testnet" ? marketDbTest : marketDbMain;
        const candles = await marketDb.marketCandle.findMany({
            where: {
                symbol: lifecycle.symbol,
                timeframe: "1m",
                openTime: { gte: lifecycle.openedAt, lte: end }
            },
            select: { high: true, low: true },
            orderBy: { openTime: "asc" }
        });

        let metrics = computeMfeMaeFromCandles({
            side: lifecycle.side,
            entryPrice: lifecycle.entryPrice,
            candles,
            expectedMinutes
        });

        const snapshots = await this.model("autoTraderPositionSnapshot").findMany({
            where: {
                symbol: lifecycle.symbol,
                observedAt: { gte: lifecycle.openedAt, lte: end },
                run: { accountAddress: lifecycle.accountAddress, network: lifecycle.network }
            },
            select: { markPrice: true, unrealizedPnl: true, observedAt: true },
            orderBy: { observedAt: "asc" }
        });

        if (metrics.coverage === "NONE") {
            metrics = computeMfeMaeFromMarks({
                side: lifecycle.side,
                entryPrice: lifecycle.entryPrice,
                marks: snapshots.map((row: any) => Number(row.markPrice))
            });
        }

        metrics = enforceMfeMaeExitBounds({
            side: lifecycle.side,
            entryPrice: lifecycle.entryPrice,
            exitPrice: lifecycle.exitPrice,
            status: lifecycle.status,
            metrics
        });

        const flags = computeReviewFlags({
            mfeBps: metrics.mfeBps,
            entryPrice: lifecycle.entryPrice,
            sizeOpened: lifecycle.sizeOpened,
            netRealizedPnl: lifecycle.netRealizedPnl,
            status: lifecycle.status
        });
        const latestSnapshot = snapshots[snapshots.length - 1];
        const observedPeakPnl = snapshots.reduce(
            (max: number, row: any) => Math.max(max, Number(row.unrealizedPnl ?? Number.NEGATIVE_INFINITY)),
            Number.NEGATIVE_INFINITY
        );
        const candleMfePnl = metrics.mfeBps !== null && lifecycle.entryPrice > 0 && lifecycle.sizeOpened > 0
            ? lifecycle.entryPrice * lifecycle.sizeOpened * (metrics.mfeBps / 10000)
            : Number.NEGATIVE_INFINITY;
        const peakUnrealizedPnl = Math.max(observedPeakPnl, candleMfePnl);
        const openFlags = lifecycle.status === "OPEN"
            ? computeOpenReviewFlags({
                mfeBps: metrics.mfeBps,
                currentUnrealizedPnl: latestSnapshot ? Number(latestSnapshot.unrealizedPnl ?? 0) : null,
                peakUnrealizedPnl: Number.isFinite(peakUnrealizedPnl) ? peakUnrealizedPnl : null
            })
            : { openWasGreenNowRed: false, openLateGiveback: false, openGivebackPct: null };

        return {
            mfeBps: metrics.mfeBps,
            maeBps: metrics.maeBps,
            source: metrics.source,
            coverage: metrics.coverage,
            flags: {
                observedGreenToRed: flags.observedGreenToRed,
                lateGiveback: flags.lateGiveback,
                givebackPct: flags.givebackPct,
                openWasGreenNowRed: openFlags.openWasGreenNowRed,
                openLateGiveback: openFlags.openLateGiveback,
                openGivebackPct: openFlags.openGivebackPct,
                closedGreenToRed: flags.observedGreenToRed,
                closedLateGiveback: flags.lateGiveback
            }
        };
    }

    private async skippedOpportunities(query: ReviewQuery, runs: any[]): Promise<any[]> {
        const decisions = runs.flatMap((run: any) =>
            (run.decisions ?? [])
                .filter((decision: any) => decision.decisionType === "ENTRY_CANDIDATE" && (decision.action === "SKIP" || decision.validatorStatus === "rejected"))
                .map((decision: any) => ({ ...decision, runStartedAt: run.startedAt }))
        ).slice(0, 25);
        const marketDb = query.network === "testnet" ? marketDbTest : marketDbMain;
        const rows = [];

        for (const decision of decisions) {
            const side = decision.side === "short" ? "short" : "long";
            const start = new Date(decision.runStartedAt);
            const checkpoints = [15, 60, 240];
            const prices = await Promise.all([
                nearestClose(marketDb, decision.symbol, start),
                ...checkpoints.map(minutes => nearestClose(marketDb, decision.symbol, new Date(start.getTime() + minutes * 60_000)))
            ]);
            const startPrice = prices[0];
            const outcomes = checkpoints.map((minutes, index) => {
                const futurePrice = prices[index + 1];
                const bps = startPrice && futurePrice
                    ? side === "long"
                        ? ((futurePrice - startPrice) / startPrice) * 10000
                        : ((startPrice - futurePrice) / startPrice) * 10000
                    : null;
                return {
                    minutes,
                    bps: bps === null ? null : Math.round(bps * 100) / 100,
                    directionallyCorrect: bps === null ? null : bps > 0
                };
            });
            rows.push({
                id: decision.id,
                symbol: decision.symbol,
                side,
                skipReason: decision.skipReason ?? decision.validatorErrorsJson,
                confidence: decision.confidence,
                validatorStatus: decision.validatorStatus,
                priceAtDecision: startPrice,
                outcomes
            });
        }
        return rows;
    }

    private openPositionDto(row: any, snapshots: any[]): any {
        const related = snapshots.filter(snapshot => snapshot.symbol === row.symbol);
        const current = related[0];
        const observedPeakPnl = related.reduce((max, snapshot) => Math.max(max, Number(snapshot.unrealizedPnl ?? 0)), Number.NEGATIVE_INFINITY);
        const currentPnl = Number(current?.unrealizedPnl ?? 0);
        return {
            ...lifecycleDto(row),
            currentUnrealizedPnl: Number.isFinite(currentPnl) ? currentPnl : null,
            observedPeakPnl: Number.isFinite(observedPeakPnl) ? observedPeakPnl : null,
            drawdownFromPeak: Number.isFinite(observedPeakPnl) ? observedPeakPnl - currentPnl : null,
            latestSnapshotAt: current?.observedAt ?? null
        };
    }

    private reliableSinceFor(accountAddress: string, network: AutoTraderNetwork, runs: any[], reliableRun?: any): string | null {
        const configured = process.env.AUTO_TRADER_REVIEW_RELIABLE_SINCE;
        if (configured) return configured;
        if (reliableRun) return new Date(reliableRun.reliableSince ?? reliableRun.startedAt).toISOString();
        const candidates = runs
            .filter((run: any) => run.accountAddress === accountAddress && run.network === network)
            .map((run: any) => new Date(run.reliableSince ?? run.startedAt).getTime())
            .filter(Number.isFinite);
        if (!candidates.length) return null;
        return new Date(Math.min(...candidates)).toISOString();
    }

    private modelsAvailable(): boolean {
        return !!this.model("autoTraderRun", false);
    }

    private model(name: string, throwIfMissing = true): PrismaAny {
        const model = (prisma as any)[name];
        if (!model && throwIfMissing) throw new Error(`${name} Prisma model is unavailable; run npm run prisma:generate`);
        return model;
    }
}

async function nearestClose(marketDb: any, symbol: string, ts: Date): Promise<number | null> {
    const candle = await marketDb.marketCandle.findFirst({
        where: { symbol, timeframe: "1m", openTime: { gte: new Date(ts.getTime() - 60_000), lte: new Date(ts.getTime() + 60_000) } },
        orderBy: { openTime: "asc" },
        select: { close: true }
    });
    return candle ? Number(candle.close) : null;
}

function summarizeLifecycles(lifecycles: any[], fills: any[]): any {
    const closed = lifecycles.filter(row => row.status === "CLOSED");
    const winners = closed.filter(row => Number(row.netRealizedPnl) > 0);
    const losers = closed.filter(row => Number(row.netRealizedPnl) < 0);
    const totalWin = winners.reduce((sum, row) => sum + Number(row.netRealizedPnl ?? 0), 0);
    const totalLoss = Math.abs(losers.reduce((sum, row) => sum + Number(row.netRealizedPnl ?? 0), 0));
    return {
        lifecycleCount: lifecycles.length,
        closedCount: closed.length,
        openCount: lifecycles.length - closed.length,
        fillCount: fills.length,
        netPnl: round2(closed.reduce((sum, row) => sum + Number(row.netRealizedPnl ?? 0), 0)),
        fees: round2(closed.reduce((sum, row) => sum + Number(row.fees ?? 0), 0)),
        winRate: closed.length ? round2((winners.length / closed.length) * 100) : 0,
        profitFactor: totalLoss > 0 ? round2(totalWin / totalLoss) : totalWin > 0 ? null : 0,
        greenToRedCount: closed.filter(row => row.closedGreenToRed ?? row.observedGreenToRed).length,
        lateGivebackCount: closed.filter(row => row.closedLateGiveback ?? row.lateGiveback).length,
        avgHoldMinutes: closed.length
            ? round2(closed.reduce((sum, row) => sum + ((new Date(row.closedAt).getTime() - new Date(row.openedAt).getTime()) / 60_000), 0) / closed.length)
            : 0
    };
}

function summarizeUnattributed(fills: any[]): any {
    return {
        fillCount: fills.length,
        exchangeTotalPnl: round2(fills.reduce((sum, fill) => sum + Number(fill.closedPnl ?? 0), 0)),
        fees: round2(fills.reduce((sum, fill) => sum + Number(fill.fee ?? 0), 0)),
        symbols: Array.from(new Set(fills.map(fill => fill.normalizedSymbol))).length
    };
}

function lifecycleDto(row: any): any {
    return {
        id: row.id,
        symbol: row.symbol,
        side: row.side,
        status: row.status,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        entryPrice: row.entryPrice,
        exitPrice: row.exitPrice,
        sizeOpened: row.sizeOpened,
        sizeClosed: row.sizeClosed,
        grossRealizedPnl: row.grossRealizedPnl,
        fees: row.fees,
        netRealizedPnl: row.netRealizedPnl,
        mfeBps: row.mfeBps,
        maeBps: row.maeBps,
        mfeSource: row.mfeSource,
        mfeCoverage: row.mfeCoverage,
        observedGreenToRed: row.observedGreenToRed,
        lateGiveback: row.lateGiveback,
        givebackPct: row.givebackPct,
        openWasGreenNowRed: row.openWasGreenNowRed,
        openLateGiveback: row.openLateGiveback,
        openGivebackPct: row.openGivebackPct,
        closedGreenToRed: row.closedGreenToRed,
        closedLateGiveback: row.closedLateGiveback,
        closeAction: row.closeAction,
        closeReasonCode: row.closeReasonCode,
        closeAttemptStatus: row.closeAttemptStatus,
        attributionMethod: row.attributionMethod
    };
}

function runDto(run: any): any {
    return {
        id: run.id,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        status: run.status,
        error: run.error,
        model: run.model,
        marketSnapshotId: run.marketSnapshotId,
        decisionCount: run.decisions?.length ?? 0,
        orderAttemptCount: (run.decisions ?? []).reduce((sum: number, decision: any) => sum + (decision.orderAttempts?.length ?? 0), 0),
        decisions: (run.decisions ?? []).map((decision: any) => ({
            id: decision.id,
            action: decision.action,
            symbol: decision.symbol,
            side: decision.side,
            confidence: decision.confidence,
            validatorStatus: decision.validatorStatus,
            preRiskDecision: parseJsonObject(decision.preRiskDecisionJson),
            riskAssessment: parseJsonObject(decision.riskAssessmentJson),
            finalDecision: parseJsonObject(decision.finalDecisionJson ?? decision.normalizedDecisionJson),
            finalRiskPlan: parseJsonObject(decision.finalRiskPlanJson),
            submittedOrderPlan: parseJsonObject(decision.submittedOrderPlanJson),
            orderAttempts: (decision.orderAttempts ?? []).map((attempt: any) => ({
                id: attempt.id,
                orderRole: attempt.orderRole,
                cloid: attempt.cloid,
                oid: attempt.oid,
                status: attempt.status,
                statusReason: attempt.statusReason
            }))
        }))
    };
}

function positionManagementEventDto(row: any): any {
    return {
        id: row.id,
        createdAt: row.createdAt,
        runId: row.runId,
        lifecycleId: row.lifecycleId,
        positionStateId: row.positionStateId,
        symbol: row.symbol,
        side: row.side,
        stateBefore: row.stateBefore,
        stateAfter: row.stateAfter,
        action: row.action,
        urgency: row.urgency,
        bypassLlm: row.bypassLlm,
        reasonCode: row.reasonCode,
        notes: row.notes,
        targetSizeFractionOfEquity: row.targetSizeFractionOfEquity,
        reduceFraction: row.reduceFraction,
        stopReplacement: parseJsonObject(row.stopReplacementJson),
        takeProfitReplacement: parseJsonObject(row.takeProfitReplacementJson),
        cancelOrderOids: parseJsonObject(row.cancelOrderOidsJson),
        evidence: parseJsonObject(row.evidenceJson)
    };
}

function summarizePositionManagementEvents(rows: any[]): any {
    return {
        actionCount: rows.length,
        urgentActionCount: rows.filter(row => row.bypassLlm && row.action !== "HOLD_POSITION" && row.action !== "NO_ACTION").length,
        greenToRedPrevented: rows.filter(row => row.reasonCode === "OPEN_WAS_GREEN_NOW_RED").length,
        partialProfitsTaken: rows.filter(row => row.reasonCode === "PARTIAL_TP_AFTER_MFE").length,
        stopsRepaired: rows.filter(row => row.action === "PLACE_BREAKEVEN_STOP" || row.action === "REPLACE_STOP").length,
        staleTpsReplaced: rows.filter(row => row.action === "REPLACE_TAKE_PROFIT").length,
        forcedExits: rows.filter(row => row.action === "CLOSE_POSITION").length
    };
}

function latestDate(current: string | null, next: Date | string | null): string | null {
    if (!next) return current;
    const nextIso = new Date(next).toISOString();
    if (!current) return nextIso;
    return new Date(nextIso).getTime() > new Date(current).getTime() ? nextIso : current;
}

function reliableSince(): Date {
    const configured = process.env.AUTO_TRADER_REVIEW_RELIABLE_SINCE;
    if (configured) {
        const date = new Date(configured);
        if (!Number.isNaN(date.getTime())) return date;
    }
    return new Date();
}

function codeVersion(): string | null {
    if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
    try {
        return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
        return null;
    }
}

function finiteOrNull(value: unknown): number | null {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
}

function fillSummary(fills: any[]): {
    avgPx: number;
    totalSz: number;
    totalFee: number;
    notionalUsd: number;
    firstFillAt: Date;
} | null {
    const valid = fills.filter(fill => Number(fill?.px) > 0 && Number(fill?.sz) > 0);
    if (!valid.length) return null;
    const totalSz = valid.reduce((sum, fill) => sum + Math.abs(Number(fill.sz)), 0);
    if (totalSz <= 0) return null;
    const notionalUsd = valid.reduce((sum, fill) => sum + Math.abs(Number(fill.sz)) * Number(fill.px), 0);
    return {
        avgPx: notionalUsd / totalSz,
        totalSz,
        totalFee: valid.reduce((sum, fill) => sum + Math.abs(Number(fill.fee ?? 0)), 0),
        notionalUsd,
        firstFillAt: new Date(valid[0].time)
    };
}

function parseJsonArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    if (typeof value !== "string" || !value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
}

function parseJsonObject(value: unknown): any | null {
    if (!value) return null;
    if (typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

function positionStateKey(symbol: string, side: string): string {
    return `${symbol}:${side}`;
}

function playbookFromLifecycle(lifecycle: any): string | null {
    const raw = lifecycle?.rawDebugJson;
    if (!raw || typeof raw !== "object") return null;
    const value = raw.playbook ?? raw.entryPlaybook ?? raw.entry_playbook;
    return typeof value === "string" && value.length > 0 ? value : null;
}

function estimatedPositionFeeBps(market: any, config: AgentConfig, network: AutoTraderNetwork): number {
    const marketFee = finite(market?.derived?.costs?.fees_bps);
    const slippage = finite(market?.derived?.costs?.slippage_bps_est);
    const profileFee = config.network_profiles[network]?.fees_bps ?? config.position_management.global.estimatedRoundTripFeeBps;
    return Math.max(0, marketFee ?? profileFee, 0) + Math.max(0, slippage ?? 0);
}

function marketTagsForManagedPosition(market: any): string[] {
    const tags = new Set<string>();
    for (const tag of market?.regime_tags ?? []) {
        if (typeof tag === "string" && tag) tags.add(tag);
    }
    if (market?.news_blocked) tags.add("news_blocked");
    if (market?.derived?.entry?.entry_ok === false) tags.add("entry_failed");
    if (market?.derived?.risk?.eligible === false) tags.add("risk_ineligible");
    if (market?.bbands?.expansion || market?.derived?.technicals?.bb_expansion) tags.add("bb_expansion");
    return Array.from(tags);
}

function bookPressureAlignment(side: "long" | "short", pressure: number | null): "supportive" | "opposite" | "neutral" | "unknown" {
    if (pressure === null) return "unknown";
    if (Math.abs(pressure) < 0.03) return "neutral";
    if (side === "long") return pressure > 0 ? "supportive" : "opposite";
    return pressure < 0 ? "supportive" : "opposite";
}

function positive(value: unknown): number | null {
    const number = finite(value);
    return number !== null && number > 0 ? number : null;
}

function finite(value: unknown): number | null {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
}

function maxNullable(...values: unknown[]): number | null {
    const numbers = values.map(finite).filter((value): value is number => value !== null);
    return numbers.length ? Math.max(...numbers) : null;
}

function minNullable(...values: unknown[]): number | null {
    const numbers = values.map(finite).filter((value): value is number => value !== null);
    return numbers.length ? Math.min(...numbers) : null;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}
