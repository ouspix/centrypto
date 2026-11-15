/** Shared, causal features for discovery, live assessment and candle research. */
export const SWING_VERSION = "continuation-1";
export type SwingBar = { at: number; open: number; high: number; low: number; close: number; volume: number };
export function aggregateBars(bars: SwingBar[], intervalMs: number, sourceMs: number, asOf: number): SwingBar[] {
    const buckets = new Map<number, SwingBar[]>();
    for (const b of bars) {
        if (b.at + sourceMs > asOf) continue;
        const at = Math.floor(b.at / intervalMs) * intervalMs;
        if (at + intervalMs > asOf) continue;
        const rows = buckets.get(at) ?? []; rows.push(b); buckets.set(at, rows);
    }
    return [...buckets].sort(([a], [b]) => a - b).flatMap(([at, rows]) => {
        rows.sort((a, b) => a.at - b.at);
        if (rows.length !== intervalMs / sourceMs || rows.some((r, i) => r.at !== at + i * sourceMs)) return [];
        return [{ at, open: rows[0].open, high: Math.max(...rows.map(r => r.high)), low: Math.min(...rows.map(r => r.low)), close: rows.at(-1)!.close, volume: rows.reduce((n, r) => n + r.volume, 0) }];
    });
}
export function swingFeatures(bars: SwingBar[], intervalMs: number, asOf: number, lookback = 20) {
    const closed = bars.filter(b => b.at + intervalMs <= asOf).sort((a,b) => a.at-b.at);
    const tail = closed.slice(-Math.max(lookback + 2, 32));
    const complete = tail.length >= Math.max(lookback + 2, 32) && tail.every((b, i) => !i || b.at - tail[i-1].at === intervalMs) && tail.at(-1)!.at + intervalMs >= asOf - intervalMs;
    if (!complete) return { version: SWING_VERSION, status: "insufficient_history" as const, direction: 0, asOf, reason: "Need fresh contiguous closed setup bars; missing bars are not invented." };
    const current = tail.at(-1)!, previous = tail.at(-2)!;
    const history = tail.slice(-lookback - 1, -1), mean = history.reduce((n,b) => n+b.close,0)/history.length;
    const atr = tail.slice(-14).reduce((n,b,i) => n+Math.max(b.high-b.low,Math.abs(b.high-tail[tail.length-15+i].close),Math.abs(b.low-tail[tail.length-15+i].close)),0)/14;
    const hourly = intervalMs <= 3600000 ? aggregateBars(closed,3600000,intervalMs,asOf) : closed;
    const regime = aggregateBars(closed,14400000,intervalMs,asOf).slice(-20);
    const trend = hourly.slice(-20);
    const slope = (rows: SwingBar[]) => rows.length === 20 ? (rows.at(-1)!.close / rows[0].close - 1)*10000 : null;
    const trendBps = slope(trend), regimeBps = slope(regime);
    const alignment = trendBps !== null && regimeBps !== null && Math.sign(trendBps)===Math.sign(regimeBps) ? Math.sign(trendBps) : 0;
    const pullback = alignment > 0 ? previous.close < mean && current.close > previous.high : alignment < 0 ? previous.close > mean && current.close < previous.low : false;
    return {version: SWING_VERSION,status:"observed" as const,asOf,direction:pullback?alignment:0,trendBps,regimeBps,atr,atrBps:atr/current.close*10000,mean,close:current.close,
        invalidationLong:Math.min(...tail.slice(-5).map(b=>b.low)),invalidationShort:Math.max(...tail.slice(-5).map(b=>b.high)),
        interpretation:"4h regime and 1h trend alignment; pullback through setup mean followed by a closed-bar resumption. Resting book imbalance is not executed flow."};
}
export const SWING_PROFILE = {
    version: SWING_VERSION, universe: "All active native USDC perpetuals; no symbol allowlist or top-volume cutoff",
    discovery: "Cheap full-universe scan; rank changes and relative performance, rotate research, pin positions/orders and accept catalyst nominations. Only shortlist depth/history is fetched on demand.",
    timeframes: {regime:"4h",trend:"1h",setup:"15m",entry:"5m"},
    holdHours: [2,24], catalystHoldHours: [4,48],
    evaluation:"Candle research for long-horizon hypotheses; recorded depth replay for execution sensitivity. Both model fills; neither is deployment approval.",
    promotion:"Research-first. A new strategy version requires prospective observations and explicit operator activation before live entries. Paper remains actual testnet execution only when enabled."
};
