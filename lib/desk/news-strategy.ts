import type { SwingBar } from "./swing";

export const NEWS_STRATEGY_VERSION = "news-momentum-1";
export const NEWS_STRATEGY_PROFILE = {
    version: NEWS_STRATEGY_VERSION,
    state: "implementation_only",
    activationSupported: false,
    rule: "Post-verification closed 5m breakout with increasing executed volume; no 4h alignment requirement.",
    // Initial frozen engineering assumptions, not validated profitable thresholds.
    maxEventAgeMs: 60 * 60_000, maxChaseBps: 500, maxSpreadBps: 15,
    minVolumeRatio: 1, holdHours: 2,
    riskAuthority: "No independent risk allowance. Current book mandate and host safeguards govern any separately authorized trade; this module cannot authorize execution.",
    limitations: "Unvalidated candidate rule. Assessment is not a trade permit. Event replay, forward validation and execution-time evidence binding are required before activation.",
} as const;

export type NewsStrategyInput = {
    now: number; instrumentId: string; side: "buy" | "sell";
    event: { key: string; revisionId: number; firstSeenAt: number; publishedAt: number | null;
        availableAt: number; expiresAt: number; change: string; impact: string; direction: string;
        material: boolean; contradictions: string[]; instrumentMatched: boolean; primaryUrls: string[] };
    primary: { url: string; evidenceId: string; verifiedAt: number; expiresAt: number } | null;
    arrival: { price: number; at: number } | null;
    quote: { bid: number; ask: number; at: number };
    bars: SwingBar[];
};

/** Pure evaluator shared by live assessment and the future causal event replay. No orders. */
export function assessNewsMomentum(input: NewsStrategyInput) {
    const { now, event: e, primary, arrival, quote: q } = input, p = NEWS_STRATEGY_PROFILE;
    const blockers: string[] = [];
    if (!Number.isFinite(now)) throw new Error("Invalid assessment clock");
    const epoch = Math.min(e.firstSeenAt, e.publishedAt ?? e.firstSeenAt);
    const times = [epoch, e.firstSeenAt, e.availableAt, e.expiresAt];
    if (!times.every(Number.isFinite) || epoch > now || e.firstSeenAt > now || e.availableAt > now
        || e.availableAt < e.firstSeenAt || e.expiresAt <= now) blockers.push("invalid_or_expired_event_times");
    if (now - epoch > p.maxEventAgeMs) blockers.push("event_window_expired");
    if (!e.material || e.change !== "announcement" || e.impact !== "catalyst") blockers.push("not_a_new_catalyst_announcement");
    if (!e.instrumentMatched || !/^(mainnet|testnet):perp:[A-Za-z0-9_.-]{1,50}$/.test(input.instrumentId)) blockers.push("exact_native_perpetual_link_required");
    if (e.direction !== (input.side === "buy" ? "bullish" : "bearish") || e.contradictions.length) blockers.push("direction_or_contradiction_unresolved");
    const verified = primary && [primary.verifiedAt, primary.expiresAt].every(Number.isFinite)
        && primary.verifiedAt >= e.availableAt && primary.verifiedAt <= now && primary.expiresAt > now;
    if (!verified) blockers.push("current_primary_read_required");
    if (primary && !e.primaryUrls.includes(primary.url)) blockers.push("primary_source_not_bound_to_event");
    const arrivalValid = arrival && Number.isFinite(arrival.price) && arrival.price > 0 && Number.isFinite(arrival.at)
        && arrival.at >= e.availableAt && arrival.at <= now && arrival.at <= e.availableAt + 60_000;
    if (!arrivalValid) blockers.push("timely_event_arrival_quote_required");
    const quoteValid = [q.at, q.bid, q.ask].every(Number.isFinite) && q.bid > 0 && q.ask >= q.bid
        && now - q.at >= -1000 && now - q.at <= 5000;
    if (!quoteValid) blockers.push("fresh_executable_quote_required");
    const entry = input.side === "buy" ? q.ask : q.bid;
    const chaseBps = arrivalValid && quoteValid ? (entry / arrival.price - 1) * 10000 * (input.side === "buy" ? 1 : -1) : null;
    const spreadBps = quoteValid ? (q.ask - q.bid) / ((q.ask + q.bid) / 2) * 10000 : null;
    if (chaseBps !== null && chaseBps > p.maxChaseBps) blockers.push("maximum_chase_exceeded");
    if (spreadBps !== null && spreadBps > p.maxSpreadBps) blockers.push("spread_too_wide");
    const step = 300_000, boundary = Math.floor(now / step) * step;
    const bars = input.bars.filter(b => b.at + step <= now).sort((a, b) => a.at - b.at).slice(-2);
    const [previous, current] = bars;
    const validBars = bars.length === 2 && bars.every(b => [b.at, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite)
        && b.at % step === 0 && b.low > 0 && b.volume > 0 && b.high >= Math.max(b.open, b.close, b.low)
        && b.low <= Math.min(b.open, b.close)) && previous.at + step === current.at && current.at + step === boundary;
    if (!validBars) blockers.push("fresh_contiguous_closed_bars_required");
    const earliest = Math.max(e.availableAt, primary?.verifiedAt ?? Infinity);
    if (validBars && current.at + step <= earliest) blockers.push("wait_for_post_verification_bar");
    if (validBars && !(input.side === "buy" ? current.close > previous.high : current.close < previous.low)) blockers.push("closed_bar_breakout_required");
    if (validBars && current.volume <= previous.volume * p.minVolumeRatio) blockers.push("executed_volume_expansion_required");
    const stop = validBars ? (input.side === "buy" ? Math.min(previous.low, current.low) : Math.max(previous.high, current.high)) : null;
    if (stop !== null && quoteValid && (input.side === "buy" ? stop >= entry : stop <= entry)) blockers.push("structural_stop_invalid");
    const expiry = Math.min(epoch + p.maxEventAgeMs, e.expiresAt, primary?.expiresAt ?? Infinity, boundary + step);
    return { strategyVersion: NEWS_STRATEGY_VERSION, status: blockers.length ? "blocked" : "candidate",
        executionAuthorized: false, blockers, eventKey: e.key, revisionId: e.revisionId, instrumentId: input.instrumentId,
        side: input.side, observedAt: new Date(now).toISOString(), primaryEvidenceId: primary?.evidenceId ?? null,
        signalClosedAt: validBars ? new Date(boundary).toISOString() : null,
        entryExpiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null,
        entryPrice: quoteValid ? entry : null, stopPrice: stop, chaseBps, spreadBps, holdHours: p.holdHours,
        note: p.limitations };
}

/** Until the event-aware strategy is validated, even a manually forged rollout row cannot enable signing. */
export function assertNewsStrategyExecutable(strategyVersion: string | undefined, reduceOnly: boolean | undefined) {
    if (strategyVersion === NEWS_STRATEGY_VERSION && !reduceOnly)
        throw new Error("news-momentum-1 is implementation-only: event replay, forward validation and execution-time evidence binding are not complete");
}
