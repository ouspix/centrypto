import "server-only";

import { execSync } from "child_process";
import { prisma } from "@/lib/db";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { getOrderStatus, getUserFills, getUserFillsByTime } from "@/lib/hyperliquid-info";
import { StateSnapshot } from "@/types/snapshot";
import { RiskAssessment, TradeDecision, TraderDecision } from "@/types/trading";
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
    computeReviewFlags,
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
        traderDecisions: TraderDecision[];
        backendDecisions: TradeDecision[];
        validation: { accepted: boolean; reason: string };
        positionSnapshotIds: Map<string, string>;
    }): Promise<(string | null)[]> {
        if (!input.runId || !this.modelsAvailable()) return input.backendDecisions.map(() => null);
        const rows: (string | null)[] = [];
        for (let i = 0; i < input.backendDecisions.length; i++) {
            const backend = input.backendDecisions[i];
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
                    validatorStatus,
                    validatorErrorsJson: input.validation.accepted ? null : safeJson({ reason: input.validation.reason })
                }
            });
            rows.push(created.id);
        }
        return rows;
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

        const [lifecycles, runs, fills, openSnapshots, reliableRun] = await Promise.all([
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
            })
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
        const redFlags = closed.filter((row: any) => row.observedGreenToRed || row.lateGiveback);

        return {
            warning: `Historical attribution before instrumentation is approximate. Reliable attribution starts from: ${reliableSince ?? "not established yet"}.`,
            summary: summarizeLifecycles(lifecycles, fills),
            attributedSummary: summarizeLifecycles(attributed, fills.filter((row: any) => row.attributionStatus !== "UNMATCHED")),
            unattributedSummary: summarizeUnattributed(unattributedFills),
            openPositions: open.map((row: any) => this.openPositionDto(row, openSnapshots)),
            closedLifecycles: closed.map(lifecycleDto),
            runs: runs.map(runDto),
            redFlags: redFlags.map(lifecycleDto),
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
                await this.markFillAttributed(fill.id, exact.id, exact.decisionId, exact.method, exact.method === "FALLBACK" ? "FALLBACK_MATCHED" : "MATCHED");
                if (exact.method === "FALLBACK") fallbackMatched++;
                else matched++;
                continue;
            }

            const fallback = await this.findFallbackAttempt(fill, accountAddress, network);
            if (fallback) {
                await this.markFillAttributed(fill.id, fallback.id, fallback.decisionId, "FALLBACK", "FALLBACK_MATCHED");
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

    private async markFillAttributed(fillId: string, orderAttemptId: string, decisionId: string, method: AutoTraderAttributionMethod, status: AutoTraderAttributionStatus): Promise<void> {
        await this.model("autoTraderFill").update({
            where: { id: fillId },
            data: {
                orderAttemptId,
                decisionId,
                attributionStatus: status,
                attributionMethod: method
            }
        });
    }

    private async rebuildLifecycles(accountAddress: string, network: AutoTraderNetwork): Promise<number> {
        const fills = await this.model("autoTraderFill").findMany({
            where: { accountAddress, network },
            orderBy: { time: "asc" }
        });
        const reconstructed = reconstructTradeLifecycles({ accountAddress, network, fills });

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
                    givebackPct: decorated.flags.givebackPct
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
        flags: { observedGreenToRed: boolean; lateGiveback: boolean; givebackPct: number | null };
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

        if (metrics.coverage === "NONE") {
            const snapshots = await this.model("autoTraderPositionSnapshot").findMany({
                where: {
                    symbol: lifecycle.symbol,
                    observedAt: { gte: lifecycle.openedAt, lte: end },
                    run: { accountAddress: lifecycle.accountAddress, network: lifecycle.network }
                },
                select: { markPrice: true }
            });
            metrics = computeMfeMaeFromMarks({
                side: lifecycle.side,
                entryPrice: lifecycle.entryPrice,
                marks: snapshots.map((row: any) => Number(row.markPrice))
            });
        }

        const flags = computeReviewFlags({
            mfeBps: metrics.mfeBps,
            entryPrice: lifecycle.entryPrice,
            sizeOpened: lifecycle.sizeOpened,
            netRealizedPnl: lifecycle.netRealizedPnl,
            status: lifecycle.status
        });

        return {
            mfeBps: metrics.mfeBps,
            maeBps: metrics.maeBps,
            source: metrics.source,
            coverage: metrics.coverage,
            flags
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
        greenToRedCount: closed.filter(row => row.observedGreenToRed).length,
        lateGivebackCount: closed.filter(row => row.lateGiveback).length,
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}
