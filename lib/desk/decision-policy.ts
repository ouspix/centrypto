import type { DeskBook, PrismaClient } from "@prisma/client";
import { SWING_PROFILE } from "./swing";
import { bookRiskContext } from "./mandate";
import { NEWS_STRATEGY_PROFILE } from "./news-strategy";
import { ALLOCATION_REVIEW_VERSION } from "./allocation-review";

/** Same current policy for opening briefs and explicit refreshes. No venue read. */
export async function strategyProfile(db: PrismaClient, book: Pick<DeskBook, "id">) {
    const { profile, rollout } = await currentDecisionPolicy(db, book);
    return { ...profile, rollout, newsStrategy: NEWS_STRATEGY_PROFILE };
}

export const DISCRETIONARY_VERSION = "desk-discretionary-1";
export const EXECUTABLE_STRATEGIES = ["continuation-1", DISCRETIONARY_VERSION] as const;
export const DISCRETIONARY_PROFILE = {
    version: DISCRETIONARY_VERSION,
    universe: "All active native USDC perpetuals; no symbol allowlist",
    decision: "Role-based discretion. The lead integrates independently assessed catalyst, positioning, participation, price, execution and risk evidence. No mandatory candle-pattern gate.",
    evidence: "Choose reads that can change the thesis, direction, timing, size or pass decision. Reuse fresh observations; do not request every tool or whole-market account/depth data.",
    referencePatterns: ["continuation-1"], mandatoryEntryPattern: null,
    authority: "Only the live lead authorizes orders. Specialists advise within their roles. Research sessions cannot trade. Strategy activation and host controls remain operator-owned.",
    plan: "Persist decisionPlan with mechanism, holding horizon, sufficient evidence, thesis invalidation, action and optional confirmation with its horizon relevance. Explain material evidence behind changes to criteria. Complete the executable setup, sizing and preview for an entry decision.",
    allocationReview: { version: ALLOCATION_REVIEW_VERSION,
        requiredForNewEntries: "Record decisionPlan.allocation: plausible net continuation, stagnation and failure payoff; evidence for any required beyond-range extension; concrete event sizing/timing/abstention choice; common-driver exposure and marginal advantage over cash. Current saved live plan must match the order. Reductions/protection remain available without rewriting history.",
        discretion: "No fixed reward/risk ratio, win-rate, performance cutoff, event blackout, calibrated-probability requirement or long/short quota. Null scenario magnitudes remain explicit uncertainty, not automatic rejection. Completing the record does not establish alpha.",
        outcomes: "openingBrief.allocationContext and allocation_context expose actual fill-based closed outcomes after fees/funding, same-direction holdings and pending orders. Family labels do not establish diversification or independence." },
    confirmation: "Choose confirmation by mechanism and measure its value after costs. Evaluate brief hesitation at the thesis horizon. Test waiting against immediate modeled entry with compare_entry_timing where a price/closed-bar condition represents the question.",
    holdHours: [2,48],
    evaluation: "Test falsifiable repeatable claims with the backtester or prospective studies when those tools answer the question. Distinguish observed facts, scenarios and unvalidated signals. No invented probabilities or profit guarantees.",
};

/** Active authority wins; otherwise show the most recently installed/paused policy. */
export async function currentDecisionPolicy(db: PrismaClient, book: Pick<DeskBook,"id">) {
    const [current, rows] = await Promise.all([db.deskBook.findUniqueOrThrow({ where: { id: book.id },
        select: { id: true, version: true, mandateJson: true } }), Promise.all(EXECUTABLE_STRATEGIES.map(version =>
        db.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key:`strategy-rollout:${version}`}}})
    ))]);
    const policies = rows.flatMap((row,index) => row ? [{version:EXECUTABLE_STRATEGIES[index],rollout:JSON.parse(row.dataJson)}] : []);
    policies.sort((a,b) => Number(b.rollout.state === "active") - Number(a.rollout.state === "active") ||
        (Date.parse(b.rollout.changedAt) || 0) - (Date.parse(a.rollout.changedAt) || 0));
    const chosen = policies[0];
    const riskPolicy = bookRiskContext(current), m = riskPolicy.mandate;
    const { bookVersion, capitalCeilingUsd, ...rollout } = chosen?.rollout ?? {version:"continuation-1",state:"research_only"};
    return {profile:{...(chosen?.version === DISCRETIONARY_VERSION ? DISCRETIONARY_PROFILE : SWING_PROFILE),
        bookVersion: current.version, mandate: m, riskPolicy,
        capitalCeilingUsd: Math.min(m.capitalUsd, riskPolicy.hostLimits.capitalUsd),
        riskPerTradeUsd: m.maxRiskPerTradeUsd, aggregateOpenRiskUsd: m.maxOpenRiskUsd ?? null,
        dailyLossUsd: m.maxDailyLossUsd, maxConcurrentPositions: m.maxConcurrentPositions ?? null,
        maxOrderUsd: m.maxOrderUsd, maxInstrumentUsd: m.maxInstrumentUsd, maxGrossLeverage: m.maxGrossLeverage,
        maxSlippageBps: m.maxSlippageBps, minDepthUsd: m.minDepthUsd, costAllowanceBps: m.costAllowanceBps ?? null},
        rollout: {...rollout, activationSnapshot: { bookVersion: bookVersion ?? null, capitalCeilingUsd: capitalCeilingUsd ?? null,
            instruction: "Historical activation metadata only; current limits are in mandate and riskPolicy." }}};
}
