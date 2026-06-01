import { prisma } from "@/lib/db";
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
        return { updated: 0 };
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
            }
        };
    }

    return {
        discovery: market.discovery ?? { reasons: opportunity.discoveryReasons },
        execution: market.execution ?? {
            tradeable: opportunity.executionTradeable,
            blockReasons: opportunity.executionBlockReasons
        },
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
