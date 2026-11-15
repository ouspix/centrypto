import type { EntryDecision } from "./entry-decision";
import type { ForwardDecision } from "./prospective";
import type { CandleDataset, simulateCandles } from "./backtest/candles";

export type EntryComparison = {
  proposalKey: string;
  proposalRevision: number;
  decisionPlan: EntryDecision;
  mode: string;
  confirmation: {
    relation: "above" | "below";
    price: number;
    closedBars: number;
  };
  waitUntil: number;
  costAssumptions: string;
  baselineDecisions: ForwardDecision[];
  baselineResult?: ReturnType<typeof simulateCandles>;
};

/** Only a timely observed, fully post-registration sequence can confirm entry. */
export function confirmationDecision(
  comparison: EntryComparison,
  bars: CandleDataset[number]["bars"],
  step: number,
  now: number,
  registeredAt: number,
  instrumentId: string,
  direction: number,
): ForwardDecision | null {
  const closedAt = Math.floor(now / step) * step;
  if (
    now > comparison.waitUntil ||
    closedAt <= registeredAt ||
    now - closedAt > 90_000
  )
    return null;
  const required = comparison.confirmation.closedBars;
  const sequence = bars
    .filter((b) => b.at >= registeredAt && b.at + step <= closedAt)
    .slice(-required);
  if (sequence.length !== required) return null;
  const confirmed = sequence.every(
    (bar, index) =>
      bar.at === closedAt - (required - index) * step &&
      bar.volume > 0 &&
      (comparison.confirmation.relation === "above"
        ? bar.close > comparison.confirmation.price
        : bar.close < comparison.confirmation.price),
  );
  return confirmed
    ? {
        instrumentId,
        direction,
        signalClosedAt: closedAt,
        decidedAt: now,
        entryAt: closedAt + step,
      }
    : null;
}

export function comparisonSummary(
  comparison: EntryComparison,
  delayed: ReturnType<typeof simulateCandles> | undefined,
  completed: boolean,
  missedIntervals: number,
  coverageComplete: boolean,
) {
  const baseline = comparison.baselineResult;
  const comparable =
    completed &&
    missedIntervals === 0 &&
    coverageComplete &&
    !!baseline?.dataQuality.usableForSelection &&
    baseline.metrics.closedTrades === 1 &&
    !!delayed?.dataQuality.usableForSelection;
  return {
    proposalKey: comparison.proposalKey,
    proposalRevision: comparison.proposalRevision,
    originalDecision: comparison.decisionPlan,
    confirmation: comparison.confirmation,
    waitUntil: new Date(comparison.waitUntil).toISOString(),
    costAssumptions: comparison.costAssumptions,
    baselineDecisions: comparison.baselineDecisions,
    baselineMetrics: baseline?.metrics ?? null,
    baselineTrades: baseline?.trades ?? [],
    baselineDataQuality: baseline?.dataQuality ?? null,
    delayedTrades: delayed?.trades ?? [],
    comparable,
    waitingMinusImmediateUsd: comparable
      ? delayed!.metrics.netPnlUsd - baseline!.metrics.netPnlUsd
      : null,
    note: "Paired forward candle simulation of one candidate. Immediate arm enters at the first future bar open after registration; confirmation arm enters at the next future open after timely observation. Both use the same frozen percentage stop/target, holding duration, capital, risk limits, order cap and costs; volume caps and entry prices can change actual size. Each arm has its own holding clock. No confirmation leaves that arm in cash. Only the specified price/closed-bar test is measured; other discretionary evidence is outside this experiment. Gaps or missed observation intervals prevent a comparative verdict. Modeled outcomes are separate from account fills and do not establish a general edge.",
  };
}
