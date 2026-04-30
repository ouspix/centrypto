import { BacktestMetrics, SimTrade } from "./BacktestTypes";

export class MetricsReporter {
    public static build(
        initialEquityUsd: number,
        equityCurve: Array<{ ts: Date; equity_usd: number }>,
        trades: SimTrade[],
        dimensions: {
            screeningPresetName?: string;
            agentPresetName?: string;
            traderPolicyName?: string;
        } = {}
    ): BacktestMetrics {
        const finalEquity = equityCurve[equityCurve.length - 1]?.equity_usd ?? initialEquityUsd;
        const netPnl = finalEquity - initialEquityUsd;
        const wins = trades.filter(trade => trade.net_pnl_usd > 0);
        const losses = trades.filter(trade => trade.net_pnl_usd < 0);
        const grossProfit = wins.reduce((sum, trade) => sum + trade.net_pnl_usd, 0);
        const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.net_pnl_usd, 0));
        const turnover = trades.reduce((sum, trade) => sum + trade.notional_usd, 0);
        const fees = trades.reduce((sum, trade) => sum + trade.fees_usd, 0);
        const avgHold = trades.length
            ? average(trades.map(trade => (trade.exit_ts.getTime() - trade.entry_ts.getTime()) / 60_000))
            : 0;
        const drawdown = maxDrawdown(equityCurve, initialEquityUsd);

        return {
            net_pnl_usd: round(netPnl),
            net_pnl_bps: bps(netPnl, initialEquityUsd),
            max_drawdown_usd: round(drawdown.usd),
            max_drawdown_bps: drawdown.bps,
            trade_count: trades.length,
            win_rate: trades.length ? wins.length / trades.length : 0,
            profit_factor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
            avg_win_usd: wins.length ? average(wins.map(trade => trade.net_pnl_usd)) : 0,
            avg_loss_usd: losses.length ? average(losses.map(trade => trade.net_pnl_usd)) : 0,
            avg_trade_net_bps: trades.length ? average(trades.map(trade => bps(trade.net_pnl_usd, trade.notional_usd))) : 0,
            expectancy_per_trade_usd: trades.length ? round(netPnl / trades.length) : 0,
            max_consecutive_losses: maxConsecutiveLosses(trades),
            avg_slippage_bps: trades.length ? round(average(trades.map(trade => trade.slippage_bps))) : 0,
            avg_fees_usd_per_trade: trades.length ? round(fees / trades.length) : 0,
            avg_mfe_bps: trades.length ? round(average(trades.map(trade => trade.max_favorable_excursion_bps))) : 0,
            avg_mae_bps: trades.length ? round(average(trades.map(trade => trade.max_adverse_excursion_bps))) : 0,
            pnl_by_hour_utc: pnlByHourUtc(trades),
            pnl_by_weekday: pnlByWeekday(trades),
            confidence_buckets: confidenceBuckets(trades),
            turnover_usd: round(turnover),
            turnover_cost_usd: round(fees),
            stop_hit_rate: rate(trades, "stop_loss"),
            take_profit_hit_rate: rate(trades, "take_profit"),
            time_stop_rate: rate(trades, "time_stop"),
            avg_holding_minutes: round(avgHold),
            one_symbol_concentration: concentration(trades, trade => trade.symbol),
            one_regime_concentration: concentration(trades, trade => regimeKey(trade.entry_regime)),
            breakdowns: {
                playbook: breakdown(trades, trade => trade.playbook, initialEquityUsd),
                symbol: breakdown(trades, trade => trade.symbol, initialEquityUsd),
                side: breakdown(trades, trade => trade.side, initialEquityUsd),
                exit_reason: breakdown(trades, trade => trade.exit_reason, initialEquityUsd),
                regime_current: breakdown(trades, trade => regimeKey(trade.entry_regime), initialEquityUsd),
                screening_preset: breakdown(trades, () => dimensions.screeningPresetName ?? "unknown", initialEquityUsd),
                agent_preset: breakdown(trades, () => dimensions.agentPresetName ?? "unknown", initialEquityUsd),
                trader_policy: breakdown(trades, () => dimensions.traderPolicyName ?? "unknown", initialEquityUsd)
            }
        };
    }
}

function maxConsecutiveLosses(trades: SimTrade[]): number {
    let current = 0;
    let max = 0;
    for (const trade of trades) {
        if (trade.net_pnl_usd < 0) {
            current++;
            max = Math.max(max, current);
        } else {
            current = 0;
        }
    }
    return max;
}

function pnlByHourUtc(trades: SimTrade[]): Record<string, number> {
    const out = initBuckets(24);
    for (const trade of trades) {
        const key = String(trade.exit_ts.getUTCHours()).padStart(2, "0");
        out[key] = round((out[key] ?? 0) + trade.net_pnl_usd);
    }
    return out;
}

function pnlByWeekday(trades: SimTrade[]): Record<string, number> {
    const labels = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const out = Object.fromEntries(labels.map(label => [label, 0])) as Record<string, number>;
    for (const trade of trades) {
        const key = labels[trade.exit_ts.getUTCDay()];
        out[key] = round((out[key] ?? 0) + trade.net_pnl_usd);
    }
    return out;
}

function confidenceBuckets(trades: SimTrade[]): BacktestMetrics["confidence_buckets"] {
    const groups = new Map<string, SimTrade[]>();
    for (const trade of trades) {
        const confidence = Number((trade as any).confidence ?? (trade as any).llm_confidence);
        const key = Number.isFinite(confidence)
            ? confidence >= 0.8 ? "0.80-1.00" : confidence >= 0.6 ? "0.60-0.79" : confidence >= 0.4 ? "0.40-0.59" : "0.00-0.39"
            : "unknown";
        const bucket = groups.get(key) ?? [];
        bucket.push(trade);
        groups.set(key, bucket);
    }

    const out: BacktestMetrics["confidence_buckets"] = {};
    for (const [key, group] of groups) {
        const wins = group.filter(trade => trade.net_pnl_usd > 0);
        out[key] = {
            trade_count: group.length,
            net_pnl_usd: round(group.reduce((sum, trade) => sum + trade.net_pnl_usd, 0)),
            win_rate: group.length ? wins.length / group.length : 0
        };
    }
    return out;
}

function initBuckets(count: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < count; i++) out[String(i).padStart(2, "0")] = 0;
    return out;
}

function breakdown(trades: SimTrade[], keyFn: (trade: SimTrade) => string, initialEquityUsd: number): Record<string, Partial<BacktestMetrics>> {
    const groups = new Map<string, SimTrade[]>();
    for (const trade of trades) {
        const key = keyFn(trade) || "unknown";
        const bucket = groups.get(key) ?? [];
        bucket.push(trade);
        groups.set(key, bucket);
    }

    const result: Record<string, Partial<BacktestMetrics>> = {};
    for (const [key, group] of groups) {
        const pnl = group.reduce((sum, trade) => sum + trade.net_pnl_usd, 0);
        const wins = group.filter(trade => trade.net_pnl_usd > 0);
        result[key] = {
            net_pnl_usd: round(pnl),
            net_pnl_bps: bps(pnl, initialEquityUsd),
            trade_count: group.length,
            win_rate: group.length ? wins.length / group.length : 0,
            avg_trade_net_bps: average(group.map(trade => bps(trade.net_pnl_usd, trade.notional_usd)))
        };
    }
    return result;
}

function maxDrawdown(curve: Array<{ equity_usd: number }>, initial: number): { usd: number; bps: number } {
    let peak = initial;
    let maxDd = 0;
    for (const point of curve) {
        peak = Math.max(peak, point.equity_usd);
        maxDd = Math.max(maxDd, peak - point.equity_usd);
    }
    return { usd: maxDd, bps: bps(maxDd, initial) };
}

function rate(trades: SimTrade[], reason: string): number {
    return trades.length ? trades.filter(trade => trade.exit_reason === reason).length / trades.length : 0;
}

function concentration(trades: SimTrade[], keyFn: (trade: SimTrade) => string): number {
    if (trades.length === 0) return 0;
    const counts = new Map<string, number>();
    for (const trade of trades) {
        const key = keyFn(trade) || "unknown";
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return round(Math.max(...counts.values()) / trades.length);
}

function regimeKey(value: unknown): string {
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") {
        const current = (value as { current?: unknown }).current;
        if (typeof current === "string" && current.trim()) return current;
    }
    if (Array.isArray(value) && value.length > 0) return String(value[0]);
    return "unknown";
}

function bps(value: number, base: number): number {
    return base > 0 ? round((value / base) * 10000) : 0;
}

function average(values: number[]): number {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number): number {
    if (!Number.isFinite(value)) return value;
    return Math.round(value * 10000) / 10000;
}
