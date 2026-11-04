import { prisma } from "@/lib/db";
import { getMarketDb, withMarketDbRetry } from "@/lib/market-db";
import { emptyStructureFlags, type CandidateStructureFlags } from "@/lib/candidate-promotion";
import type { MarketEntry, StateSnapshot } from "@/types/snapshot";
import type { OpportunityDiagnostic } from "@/types/trading";

export type OpportunityJournalNetwork = "mainnet" | "testnet";

export type PersistOpportunityJournalInput = {
    accountAddress?: string | null;
    network: OpportunityJournalNetwork;
    snapshotId?: number | null;
    timestamp: number | Date;
    opportunities: OpportunityDiagnostic[];
    markets?: Record<string, MarketEntry>;
};

export type SymbolOpportunityDiagnostics = {
    symbol: string;
    network: OpportunityJournalNetwork;
    latestSnapshotId: number | null;
    timestamp: string | null;
    discovered: boolean;
    discoveryReasons: string[];
    inPlayScore: number | null;
    execution: {
        tradeable: boolean | null;
        blockReasons: string[];
        costBps: number | null;
        spreadBps: number | null;
        depthUsd: number | null;
    };
    setupSignals: Array<{
        setupType: string | null;
        setupScore: number | null;
        playbook: string | null;
        side: string | null;
    }>;
    candidateStatus: string | null;
    pathQuality: string | null;
    policyOutcome: string | null;
    structureFlags: CandidateStructureFlags;
    promotionReason: string | null;
    demotionReason: string | null;
    matchedPriorBucket: string | null;
    configEpoch: string | null;
    pipeline: Array<{
        stage: string;
        status: "passed" | "blocked" | "not_available";
        reasons: string[];
    }>;
    latestReasons: string[];
    latestWarnings: string[];
    priceAtSignal: number | null;
    source: "opportunity_journal" | "market_state_snapshot" | "none";
};

export class OpportunityJournalService {
    private static instance: OpportunityJournalService;

    public static getInstance(): OpportunityJournalService {
        if (!OpportunityJournalService.instance) {
            OpportunityJournalService.instance = new OpportunityJournalService();
        }
        return OpportunityJournalService.instance;
    }

    public async persistSnapshotOpportunities(input: PersistOpportunityJournalInput): Promise<{ count: number }> {
        const model = (prisma as any).opportunityJournal;
        if (!model?.createMany || input.opportunities.length === 0) return { count: 0 };

        const timestamp = toDate(input.timestamp);
        const rows = input.opportunities.map(opportunity => {
            const market = input.markets?.[opportunity.symbol];
            return {
                accountAddress: input.accountAddress ?? null,
                network: input.network,
                snapshotId: input.snapshotId ?? null,
                timestamp,
                symbol: opportunity.symbol,
                side: opportunity.side,
                discoveryReasonsJson: jsonArray(opportunity.discoveryReasons),
                status: opportunity.status,
                inPlayScore: finiteOrNull(opportunity.inPlayScore),
                setupType: opportunity.setupType,
                setupScore: finiteOrNull(opportunity.setupScore),
                playbook: opportunity.playbook ?? null,
                reasonsJson: jsonArray(opportunity.reasons),
                warningsJson: jsonArray(opportunity.warnings),
                featuresJson: jsonValue(buildFeatureSnapshot(market, opportunity)),
                executionTradeable: opportunity.executionTradeable,
                executionBlockReasonsJson: jsonArray(opportunity.executionBlockReasons),
                promotionReason: opportunity.promotion_reason ?? null,
                demotionReason: opportunity.demotion_reason ?? null,
                matchedPriorBucket: opportunity.matched_prior_bucket ?? null,
                configEpoch: parseConfigEpoch(opportunity.config_epoch),
                pathQuality: opportunity.path_quality ?? null,
                policyOutcome: opportunity.policy_outcome ?? null,
                priceAtSignal: finiteOrNull(market?.price)
            };
        });

        const result = await model.createMany({ data: rows });
        return { count: Number(result?.count ?? rows.length) };
    }

    public async getLatestSymbolDiagnostics(input: {
        accountAddress?: string | null;
        network: OpportunityJournalNetwork;
        symbol: string;
    }): Promise<SymbolOpportunityDiagnostics> {
        const [journalRow, snapshotRow] = await Promise.all([
            this.findLatestJournalRow(input),
            this.findLatestSnapshotRow()
        ]);
        const snapshot = parseSnapshot(snapshotRow?.data);
        const snapshotMarket = snapshot?.markets?.[input.symbol] ?? null;

        if (journalRow) {
            return diagnosticsFromJournalRow(journalRow, input.network, snapshotMarket, snapshot?.meta?.snapshot_id ?? null);
        }

        if (snapshotMarket) {
            return diagnosticsFromMarket(input.symbol, input.network, snapshotMarket, snapshot?.meta?.snapshot_id ?? snapshotRow?.id ?? null);
        }

        return {
            symbol: input.symbol,
            network: input.network,
            latestSnapshotId: snapshot?.meta?.snapshot_id ?? snapshotRow?.id ?? null,
            timestamp: null,
            discovered: false,
            discoveryReasons: [],
            inPlayScore: null,
            execution: {
                tradeable: null,
                blockReasons: [],
                costBps: null,
                spreadBps: null,
                depthUsd: null
            },
            setupSignals: [],
            candidateStatus: null,
            pathQuality: null,
            policyOutcome: null,
            structureFlags: emptyStructureFlags(),
            promotionReason: null,
            demotionReason: null,
            matchedPriorBucket: null,
            configEpoch: null,
            pipeline: [
                { stage: "discovery", status: "not_available", reasons: ["SYMBOL_NOT_FOUND"] }
            ],
            latestReasons: [],
            latestWarnings: [],
            priceAtSignal: null,
            source: "none"
        };
    }

    public async updateForwardOutcomes(): Promise<{ updated: number }> {
        const model = (prisma as any).opportunityJournal;
        if (!model?.findMany || !model?.update) return { updated: 0 };
        const cutoff = new Date(Date.now() - 65 * 60_000);
        const dueWhere = {
            timestamp: { lte: cutoff },
            OR: [
                { outcome1hJson: null },
                { pathQuality: null },
                { policyOutcome: null }
            ]
        };
        const priorityRows = await model.findMany({
            where: {
                AND: [
                    dueWhere,
                    {
                        OR: [
                            { promotionReason: { not: null } },
                            { demotionReason: { not: null } }
                        ]
                    }
                ]
            },
            orderBy: { timestamp: "asc" },
            take: 100
        });
        const priorityIds = priorityRows.map((row: any) => row.id);
        const remainingTake = Math.max(0, 100 - priorityRows.length);
        const remainingRows = remainingTake > 0
            ? await model.findMany({
                where: {
                    AND: [
                        dueWhere,
                        priorityIds.length > 0 ? { id: { notIn: priorityIds } } : {}
                    ]
                },
                orderBy: { timestamp: "asc" },
                take: remainingTake
            })
            : [];
        const rows = Array.from(new Map(
            [...priorityRows, ...remainingRows].map((row: any) => [row.id, row])
        ).values());

        let updated = 0;
        for (const row of rows) {
            const outcome = await buildForwardOutcome(row);
            if (!outcome) continue;
            await model.update({
                where: { id: row.id },
                data: outcome
            });
            updated++;
        }
        return { updated };
    }

    private async findLatestJournalRow(input: {
        accountAddress?: string | null;
        network: OpportunityJournalNetwork;
        symbol: string;
    }): Promise<any | null> {
        const model = (prisma as any).opportunityJournal;
        if (!model?.findFirst) return null;
        const where: any = {
            network: input.network,
            symbol: input.symbol
        };
        if (input.accountAddress) {
            where.OR = [
                { accountAddress: input.accountAddress },
                { accountAddress: null }
            ];
        }
        try {
            return await model.findFirst({
                where,
                orderBy: { createdAt: "desc" }
            });
        } catch {
            return null;
        }
    }

    private async findLatestSnapshotRow(): Promise<any | null> {
        const model = (prisma as any).marketStateSnapshot;
        if (!model?.findFirst) return null;
        try {
            return await model.findFirst({
                orderBy: { createdAt: "desc" }
            });
        } catch {
            return null;
        }
    }
}

function buildFeatureSnapshot(market: MarketEntry | undefined, opportunity: OpportunityDiagnostic) {
    if (!market) {
        return {
            discovery: { reasons: opportunity.discoveryReasons },
            execution: {
                tradeable: opportunity.executionTradeable,
                blockReasons: opportunity.executionBlockReasons
            },
            structure_flags: opportunity.structure_flags ?? emptyStructureFlags()
        };
    }

    return {
        discovery: market.discovery ?? { reasons: opportunity.discoveryReasons },
        execution: market.execution ?? {
            tradeable: opportunity.executionTradeable,
            blockReasons: opportunity.executionBlockReasons
        },
        structure_flags: opportunity.structure_flags ?? null,
        structure: market.derived?.structure ?? null,
        derived: {
            rank: market.derived?.rank ?? null,
            costs: market.derived?.costs ?? null,
            edge: market.derived?.edge ?? null,
            entry: market.derived?.entry ?? null,
            liquidity: market.derived?.liquidity ?? null,
            normalized: market.derived?.normalized ?? null,
            triggers: market.derived?.triggers ?? null,
            risk: market.derived?.risk ?? null
        },
        market: {
            price: market.price,
            spread_bps: market.spread_bps,
            returns: market.returns,
            vol_zscores: market.vol_zscores,
            volume_zscores: market.volume_zscores ?? null,
            volume24h: market.volume24h ?? null,
            funding: market.funding,
            open_interest: market.open_interest,
            orderbook: {
                book_pressure: market.orderbook?.book_pressure ?? null,
                bid_liquidity_usd: market.orderbook?.bid_liquidity_usd ?? null,
                ask_liquidity_usd: market.orderbook?.ask_liquidity_usd ?? null
            }
        }
    };
}

function diagnosticsFromJournalRow(
    row: any,
    network: OpportunityJournalNetwork,
    snapshotMarket: MarketEntry | null,
    fallbackSnapshotId: number | null
): SymbolOpportunityDiagnostics {
    const discoveryReasons = parseArray(row.discoveryReasonsJson);
    const reasons = parseArray(row.reasonsJson);
    const warnings = parseArray(row.warningsJson);
    const executionBlockReasons = parseArray(row.executionBlockReasonsJson);
    const features = parseJson(row.featuresJson) as any;
    const execution = executionFromMarketOrFeatures(snapshotMarket, features, row.executionTradeable, executionBlockReasons);
    const structureFlags = normalizeStructureFlags(features?.structure_flags);

    return {
        symbol: row.symbol,
        network,
        latestSnapshotId: row.snapshotId ?? fallbackSnapshotId,
        timestamp: dateString(row.timestamp ?? row.createdAt),
        discovered: discoveryReasons.length > 0 || !!row.status,
        discoveryReasons,
        inPlayScore: finiteOrNull(row.inPlayScore),
        execution,
        setupSignals: row.setupType || row.playbook || row.setupScore !== null
            ? [{
                setupType: row.setupType ?? null,
                setupScore: finiteOrNull(row.setupScore),
                playbook: row.playbook ?? null,
                side: row.side ?? null
            }]
            : [],
        candidateStatus: row.status ?? null,
        pathQuality: row.pathQuality ?? null,
        policyOutcome: row.policyOutcome ?? null,
        structureFlags,
        promotionReason: row.promotionReason ?? null,
        demotionReason: row.demotionReason ?? null,
        matchedPriorBucket: row.matchedPriorBucket ?? null,
        configEpoch: dateString(row.configEpoch),
        pipeline: buildPipeline({
            discovered: discoveryReasons.length > 0 || !!row.status,
            tradeable: row.executionTradeable,
            executionBlockReasons,
            setupType: row.setupType ?? null,
            status: row.status ?? null,
            reasons
        }),
        latestReasons: reasons,
        latestWarnings: warnings,
        priceAtSignal: finiteOrNull(row.priceAtSignal ?? snapshotMarket?.price),
        source: "opportunity_journal"
    };
}

function diagnosticsFromMarket(
    symbol: string,
    network: OpportunityJournalNetwork,
    market: MarketEntry,
    snapshotId: number | null
): SymbolOpportunityDiagnostics {
    const discoveryReasons = market.discovery?.reasons ?? [];
    const executionBlockReasons = market.execution?.blockReasons ?? market.derived?.entry?.reasons_failed ?? [];
    const tradeable = market.execution?.tradeable ?? market.derived?.liquidity?.tradeable ?? null;

    return {
        symbol,
        network,
        latestSnapshotId: snapshotId,
        timestamp: null,
        discovered: discoveryReasons.length > 0,
        discoveryReasons,
        inPlayScore: null,
        execution: executionFromMarketOrFeatures(market, null, tradeable, executionBlockReasons),
        setupSignals: [],
        candidateStatus: null,
        pathQuality: null,
        policyOutcome: null,
        structureFlags: emptyStructureFlags(),
        promotionReason: null,
        demotionReason: null,
        matchedPriorBucket: null,
        configEpoch: null,
        pipeline: buildPipeline({
            discovered: discoveryReasons.length > 0,
            tradeable,
            executionBlockReasons,
            setupType: null,
            status: null,
            reasons: []
        }),
        latestReasons: [],
        latestWarnings: [],
        priceAtSignal: finiteOrNull(market.price),
        source: "market_state_snapshot"
    };
}

function executionFromMarketOrFeatures(
    market: MarketEntry | null,
    features: any,
    fallbackTradeable: boolean | null,
    fallbackBlockReasons: string[]
): SymbolOpportunityDiagnostics["execution"] {
    return {
        tradeable: market?.execution?.tradeable ?? features?.execution?.tradeable ?? fallbackTradeable,
        blockReasons: market?.execution?.blockReasons ?? features?.execution?.blockReasons ?? fallbackBlockReasons,
        costBps: finiteOrNull(market?.execution?.costBps ?? market?.derived?.costs?.cost_bps ?? features?.execution?.costBps ?? features?.derived?.costs?.cost_bps),
        spreadBps: finiteOrNull(market?.execution?.spreadBps ?? market?.spread_bps ?? features?.execution?.spreadBps ?? features?.market?.spread_bps),
        depthUsd: finiteOrNull(market?.execution?.depthUsd ?? market?.derived?.liquidity?.min_depth_usd ?? features?.execution?.depthUsd ?? features?.derived?.liquidity?.min_depth_usd)
    };
}

function buildPipeline(input: {
    discovered: boolean;
    tradeable: boolean | null;
    executionBlockReasons: string[];
    setupType: string | null;
    status: string | null;
    reasons: string[];
}): SymbolOpportunityDiagnostics["pipeline"] {
    return [
        {
            stage: "discovery",
            status: input.discovered ? "passed" : "not_available",
            reasons: input.discovered ? [] : ["NOT_DISCOVERED"]
        },
        {
            stage: "execution",
            status: input.tradeable === true ? "passed" : input.tradeable === false ? "blocked" : "not_available",
            reasons: input.tradeable === false ? input.executionBlockReasons : []
        },
        {
            stage: "setup",
            status: input.setupType ? "passed" : input.status === "NO_SETUP" ? "blocked" : "not_available",
            reasons: input.setupType ? [] : input.reasons.filter(reason => reason.includes("SETUP"))
        },
        {
            stage: "candidate",
            status: input.status === "CANDIDATE" ? "passed" : input.status ? "blocked" : "not_available",
            reasons: input.status && input.status !== "CANDIDATE" ? [input.status] : []
        }
    ];
}

async function buildForwardOutcome(row: any): Promise<Record<string, any> | null> {
    const entryPrice = finiteOrNull(row.priceAtSignal);
    if (!entryPrice || entryPrice <= 0) return null;
    const timestamp = row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp);
    if (!Number.isFinite(timestamp.getTime())) return null;
    const network = row.network === "testnet" ? "testnet" : "mainnet";
    const db = await getMarketDb(network === "testnet");
    const start = new Date(timestamp.getTime());
    const end = new Date(timestamp.getTime() + 4 * 60 * 60_000);
    const symbol = baseSymbol(row.symbol);
    const candles = await withMarketDbRetry(db, "opportunity outcome candles", async () => {
        const primary = await db.marketCandle.findMany({
            where: {
                symbol,
                timeframe: "1m",
                openTime: { gte: start, lte: end }
            },
            orderBy: { openTime: "asc" }
        });
        if (primary.length > 0) return primary;
        return db.marketCandle.findMany({
            where: {
                symbol: row.symbol,
                timeframe: "1m",
                openTime: { gte: start, lte: end }
            },
            orderBy: { openTime: "asc" }
        });
    });
    if (candles.length === 0) return null;

    const features = parseJson(row.featuresJson) as any;
    const costBps = finiteOrNull(features?.execution?.costBps ?? features?.derived?.costs?.cost_bps) ?? 0;
    const flags = normalizeStructureFlags(features?.structure_flags);
    const outcomes = {
        outcome5mJson: jsonValue(computeOutcomeForHorizon({ candles, entryPrice, side: row.side, costBps, horizonMinutes: 5, start })),
        outcome15mJson: jsonValue(computeOutcomeForHorizon({ candles, entryPrice, side: row.side, costBps, horizonMinutes: 15, start })),
        outcome1hJson: jsonValue(computeOutcomeForHorizon({ candles, entryPrice, side: row.side, costBps, horizonMinutes: 60, start })),
        outcome4hJson: jsonValue(computeOutcomeForHorizon({ candles, entryPrice, side: row.side, costBps, horizonMinutes: 240, start }))
    };
    const outcome1h = JSON.parse(outcomes.outcome1hJson);
    const classificationInput = {
        status: row.status,
        cost_bps: costBps,
        is_late_chase: flags.is_late_chase,
        is_extended_breakout: flags.is_extended_breakout,
        covered_60m: outcome1h.covered,
        current_policy_net_60m_bps: outcome1h.net_return_bps,
        current_policy_gross_60m_bps: outcome1h.gross_return_bps,
        net_return_realistic_60m_bps: outcome1h.net_return_bps,
        return_60m_bps: outcome1h.gross_return_bps,
        mfe_60m_bps: outcome1h.mfe_bps,
        mae_60m_bps: outcome1h.mae_bps,
        cost_adjusted_mfe_60m_bps: outcome1h.cost_adjusted_mfe_bps,
        favorable_before_adverse_60m: outcome1h.favorable_before_adverse,
        adverse_before_favorable_60m: outcome1h.adverse_before_favorable,
        mae_before_20bps_favorable_60m_bps: outcome1h.mae_before_20bps_favorable_bps,
        first_trigger_60m: outcome1h.first_trigger
    };

    return {
        ...outcomes,
        pathQuality: classifyPathQuality(classificationInput),
        policyOutcome: classifyCurrentPolicyOutcome(classificationInput)
    };
}

function computeOutcomeForHorizon(input: {
    candles: Array<{ openTime: Date; high: number; low: number; close: number }>;
    entryPrice: number;
    side: string | null | undefined;
    costBps: number;
    horizonMinutes: number;
    start: Date;
}) {
    const endMs = input.start.getTime() + input.horizonMinutes * 60_000;
    const candles = input.candles.filter(candle => candle.openTime.getTime() <= endMs);
    if (candles.length === 0) {
        return { horizon_minutes: input.horizonMinutes, covered: false };
    }
    const side = input.side === "short" ? "short" : "long";
    let mfe = 0;
    let mae = 0;
    let favorableBeforeAdverse = false;
    let adverseBeforeFavorable = false;
    let firstTrigger: string | null = null;
    let maeBefore20bpsFavorable = 0;
    let hitFavorable20 = false;

    for (const candle of candles) {
        const favorable = side === "long"
            ? 10_000 * (candle.high / input.entryPrice - 1)
            : 10_000 * (1 - candle.low / input.entryPrice);
        const adverse = side === "long"
            ? 10_000 * (candle.low / input.entryPrice - 1)
            : 10_000 * (1 - candle.high / input.entryPrice);
        mfe = Math.max(mfe, favorable);
        mae = Math.min(mae, adverse);
        if (!firstTrigger && favorable >= 20) firstTrigger = "take_profit";
        if (!firstTrigger && adverse <= -20) firstTrigger = "stop_loss";
        if (!favorableBeforeAdverse && favorable >= 20 && mae > -20) favorableBeforeAdverse = true;
        if (!adverseBeforeFavorable && adverse <= -20 && mfe < 20) adverseBeforeFavorable = true;
        if (!hitFavorable20) {
            maeBefore20bpsFavorable = Math.min(maeBefore20bpsFavorable, adverse);
            if (favorable >= 20) hitFavorable20 = true;
        }
    }

    const close = candles[candles.length - 1].close;
    const grossReturn = side === "long"
        ? 10_000 * (close / input.entryPrice - 1)
        : 10_000 * (input.entryPrice / close - 1);
    const netReturn = grossReturn - input.costBps;

    return {
        horizon_minutes: input.horizonMinutes,
        covered: candles.length >= Math.max(1, input.horizonMinutes - 1),
        gross_return_bps: round4(grossReturn),
        net_return_bps: round4(netReturn),
        mfe_bps: round4(Math.max(0, mfe)),
        mae_bps: round4(mae),
        cost_adjusted_mfe_bps: round4(Math.max(0, mfe) - input.costBps),
        favorable_before_adverse: favorableBeforeAdverse,
        adverse_before_favorable: adverseBeforeFavorable,
        mae_before_20bps_favorable_bps: round4(maeBefore20bpsFavorable),
        first_trigger: firstTrigger
    };
}

function classifyCurrentPolicyOutcome(row: Record<string, any>): string {
    if (!row.covered_60m) return "UNCOVERED";
    const status = String(row.status ?? "").toUpperCase();
    const accepted = status === "CANDIDATE" || status === "EXECUTED";
    const netReturn = finiteOrZero(row.current_policy_net_60m_bps ?? row.net_return_realistic_60m_bps);
    const grossReturn = finiteOrZero(row.current_policy_gross_60m_bps);
    const mfe = finiteOrZero(row.mfe_60m_bps);
    const cost = finiteOrZero(row.cost_bps);
    const costAdjustedMfe = finiteOrZero(row.cost_adjusted_mfe_60m_bps ?? mfe - cost);
    const firstTrigger = row.first_trigger_60m;
    const threshold = Math.max(20, cost * 3);

    if (!accepted && (firstTrigger === "take_profit" || netReturn >= threshold || costAdjustedMfe >= threshold)) {
        return status === "EXECUTION_BLOCKED" ? "GOOD_BLOCK_UNDER_CURRENT_POLICY" : "MISSED_UNDER_CURRENT_POLICY";
    }
    if (grossReturn > 0 && netReturn <= 0) return "CURRENT_POLICY_FEE_CHURN";
    if (firstTrigger === "take_profit") return "CURRENT_POLICY_WIN";
    if (accepted && (firstTrigger === "stop_loss" || netReturn < 0)) return "CURRENT_POLICY_LOSS";
    if (firstTrigger === "stop_loss") return "CURRENT_POLICY_STOPPED";
    if (costAdjustedMfe >= threshold && netReturn <= 0) return "CURRENT_POLICY_MISSED_MFE";
    if (netReturn < 0) return "CURRENT_POLICY_LOSS";
    if (netReturn > 0) return "CURRENT_POLICY_WIN";
    return "CURRENT_POLICY_NEUTRAL";
}

function classifyPathQuality(row: Record<string, any>): string {
    if (!row.covered_60m) return "UNCOVERED_PATH";
    const cost = finiteOrZero(row.cost_bps);
    const mfe = finiteOrZero(row.mfe_60m_bps);
    const mae = finiteOrZero(row.mae_60m_bps);
    const returnBps = finiteOrZero(row.return_60m_bps);
    const costAdjustedMfe = finiteOrZero(row.cost_adjusted_mfe_60m_bps ?? mfe - cost);
    const favorableBeforeAdverse = Boolean(row.favorable_before_adverse_60m);
    const adverseBeforeFavorable = Boolean(row.adverse_before_favorable_60m);
    const maeBeforeFavorable = Math.abs(finiteOrZero(row.mae_before_20bps_favorable_60m_bps));
    if (Boolean(row.is_late_chase) || Boolean(row.is_extended_breakout)) {
        if (costAdjustedMfe < 20 && Math.abs(mae) > Math.max(mfe, 10)) return "LATE_PATH";
    }
    if (costAdjustedMfe >= Math.max(20, 3 * cost) && favorableBeforeAdverse && maeBeforeFavorable <= 30) return "GOOD_PATH";
    if (costAdjustedMfe >= 20 && Math.abs(mae) >= 40 && !favorableBeforeAdverse) return "NOISY_PATH";
    if (costAdjustedMfe < 15 && returnBps <= 0) return "BAD_PATH";
    if (adverseBeforeFavorable && Math.abs(mae) > Math.max(costAdjustedMfe, 20)) return "BAD_PATH";
    if (costAdjustedMfe >= 20) return "NOISY_PATH";
    return returnBps <= 0 ? "BAD_PATH" : "NOISY_PATH";
}

function toDate(value: number | Date): Date {
    if (value instanceof Date) return value;
    return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
}

function parseSnapshot(data: unknown): StateSnapshot | null {
    const parsed = typeof data === "string" ? parseJson(data) : data;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as StateSnapshot;
}

function parseArray(value: unknown): string[] {
    const parsed = typeof value === "string" ? parseJson(value) : value;
    return Array.isArray(parsed) ? parsed.map(item => String(item)) : [];
}

function parseJson(value: unknown): unknown {
    if (typeof value !== "string") return value ?? null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function jsonArray(value: unknown[]): string {
    return JSON.stringify(value ?? []);
}

function jsonValue(value: unknown): string {
    return JSON.stringify(value ?? null);
}

function finiteOrNull(value: unknown): number | null {
    const numberValue = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
}

function dateString(value: unknown): string | null {
    const date = value instanceof Date ? value : value ? new Date(value as any) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseConfigEpoch(value: string | null | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeStructureFlags(value: unknown): CandidateStructureFlags {
    if (!value || typeof value !== "object") return emptyStructureFlags();
    const raw = value as Record<string, unknown>;
    return {
        is_late_chase: Boolean(raw.is_late_chase),
        is_fresh_continuation: Boolean(raw.is_fresh_continuation),
        is_pullback_continuation: Boolean(raw.is_pullback_continuation),
        is_extended_breakout: Boolean(raw.is_extended_breakout)
    };
}

function finiteOrZero(value: unknown): number {
    return finiteOrNull(value) ?? 0;
}

function round4(value: number): number {
    return Number.isFinite(value) ? parseFloat(value.toFixed(4)) : 0;
}

function baseSymbol(symbol: string): string {
    return String(symbol ?? "").replace(/-PERP$/, "");
}
