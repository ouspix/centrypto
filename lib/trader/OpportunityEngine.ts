import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { computeInPlayScore } from "@/lib/trader/InPlayScorer";
import { classifySetups, SetupSignal } from "@/lib/trader/SetupClassifier";
import { MarketStructureService } from "@/services/MarketStructureService";
import { MarketEntry } from "@/types/snapshot";
import { TradeSide } from "@/types/trading";

export type OpportunityStatus =
    | "DISCOVERED_ONLY"
    | "EXECUTION_BLOCKED"
    | "NO_SETUP"
    | "NEAR_MISS"
    | "CANDIDATE"
    | "HARD_BLOCKED";

export type Opportunity = {
    symbol: string;
    side: TradeSide;
    inPlayScore: number;
    setupSignals: SetupSignal[];
    bestSetup: SetupSignal | null;
    executionTradeable: boolean;
    executionBlockReasons: string[];
    status: OpportunityStatus;
    reasons: string[];
    warnings: string[];
};

export class OpportunityEngine {
    private readonly structureService = new MarketStructureService();

    public evaluateMarket(market: MarketEntry, config: AgentConfig = DEFAULT_AGENT_CONFIG): Opportunity {
        const opportunityConfig = config.opportunity ?? DEFAULT_AGENT_CONFIG.opportunity!;
        const structure = market.derived?.structure ?? this.structureService.compute(market);
        const costBps = market.execution?.costBps ?? market.derived?.costs?.cost_bps ?? 0;
        const spreadBps = market.execution?.spreadBps ?? market.spread_bps ?? 0;
        const depthUsd = market.execution?.depthUsd ?? market.derived?.liquidity?.min_depth_usd ?? 0;
        const inPlay = computeInPlayScore({
            structure,
            executionCostBps: costBps,
            spreadBps,
            depthUsd
        });
        const setupSignals = classifySetups({
            structure,
            executionCostBps: costBps,
            depthUsd
        });
        const bestSetup = setupSignals[0] ?? null;
        const executionTradeable = market.execution?.tradeable ?? market.derived?.liquidity?.tradeable ?? false;
        const executionBlockReasons = market.execution?.blockReasons ?? market.derived?.entry?.reasons_failed ?? [];
        const side = bestSetup?.side ?? sideFromStructure(structure);
        const reasons = [...inPlay.reasons];
        const warnings = [...inPlay.warnings];

        let status: OpportunityStatus;
        if (!executionTradeable) {
            status = "EXECUTION_BLOCKED";
            reasons.push(...executionBlockReasons);
        } else if (inPlay.score < opportunityConfig.minInPlayScore && !bestSetup) {
            status = "DISCOVERED_ONLY";
        } else if (!bestSetup) {
            status = "NO_SETUP";
            reasons.push("NO_SETUP_SIGNAL");
        } else if (bestSetup.score >= opportunityConfig.minSetupScore && inPlay.score >= opportunityConfig.minInPlayScore) {
            status = "CANDIDATE";
        } else if (bestSetup.score >= opportunityConfig.minNearMissScore || inPlay.score >= opportunityConfig.minInPlayScore) {
            status = "NEAR_MISS";
        } else {
            status = "DISCOVERED_ONLY";
        }

        return {
            symbol: market.symbol,
            side,
            inPlayScore: inPlay.score,
            setupSignals,
            bestSetup,
            executionTradeable,
            executionBlockReasons,
            status,
            reasons: Array.from(new Set(reasons)),
            warnings: Array.from(new Set([...warnings, ...(bestSetup?.risks ?? [])]))
        };
    }

    public evaluateMarkets(markets: Record<string, MarketEntry>, config: AgentConfig = DEFAULT_AGENT_CONFIG): Opportunity[] {
        return Object.values(markets)
            .map(market => this.evaluateMarket(market, config))
            .sort((a, b) =>
                statusPriority(b.status) - statusPriority(a.status) ||
                b.inPlayScore - a.inPlayScore ||
                a.symbol.localeCompare(b.symbol)
            );
    }
}

function sideFromStructure(structure: ReturnType<MarketStructureService["compute"]>): TradeSide {
    return structure.impulse.direction === "down" ? "short" : "long";
}

function statusPriority(status: OpportunityStatus): number {
    switch (status) {
        case "CANDIDATE": return 5;
        case "NEAR_MISS": return 4;
        case "EXECUTION_BLOCKED": return 3;
        case "NO_SETUP": return 2;
        case "DISCOVERED_ONLY": return 1;
        case "HARD_BLOCKED": return 0;
    }
}
