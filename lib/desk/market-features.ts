import type { DeskInstrument } from "./instruments";
import { aggregateBars, type SwingBar } from "./swing";

export const minute = 60_000;
export const hour = 60 * minute;
export const intervals = { "15m": 15 * minute, "1h": hour, "4h": 4 * hour } as const;
export type ScreenTimeframe = keyof typeof intervals;
export const timeframes = Object.keys(intervals) as ScreenTimeframe[];
export const windows = { "15m": 15 * minute, "1h": hour, "4h": 4 * hour, "24h": 24 * hour } as const;
export type ContextWindow = keyof typeof windows;

export const median = (xs: number[]) => percentile(xs, .5);
export function percentile(xs: number[], q: number): number | null {
    if (!xs.length) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    const i = (sorted.length - 1) * q;
    return sorted[Math.floor(i)] + (sorted[Math.ceil(i)] - sorted[Math.floor(i)]) * (i % 1);
}
export const bps = (now: number, before: number) => (now / before - 1) * 10_000;
const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const trueRange = (bar: SwingBar, previous: SwingBar) =>
    Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close));

function returns(rows: SwingBar[]) {
    return rows.slice(1).map((bar, i) => Math.log(bar.close / rows[i].close));
}
function volatility(rows: SwingBar[]) {
    return Math.sqrt(returns(rows).reduce((sum, r) => sum + r * r, 0)) * 10_000;
}
function contiguous(rows: SwingBar[], step: number) {
    return rows.every((bar, i) => !i || bar.at - rows[i - 1].at === step);
}

export function barFeatures(rows: SwingBar[], step: number, asOf: number) {
    const end = Math.floor(asOf / step) * step;
    const closed = rows.filter(bar => bar.at + step <= end);
    const tail = closed.slice(-21);
    if (tail.length < 21 || tail.at(-1)!.at + step !== end || !contiguous(tail, step)) return null;
    const latest = tail.at(-1)!;
    const prior = tail.slice(0, -1);
    const high = Math.max(...prior.map(x => x.high)), low = Math.min(...prior.map(x => x.low));
    const range = high - low;
    // Exclude the current candle from denominators and the prior range.
    const atr = mean(prior.slice(-14).map((bar, i) => trueRange(bar, prior[i + 5])));
    const volume = mean(prior.map(bar => bar.volume));
    const change = latest.close - prior[0].close;
    const path = tail.slice(1).reduce((sum, bar, i) => sum + Math.abs(bar.close - tail[i].close), 0);
    const recent = tail.slice(-5);
    const compression = range > 0 ? (Math.max(...recent.map(x => x.high)) - Math.min(...recent.map(x => x.low))) / range : null;
    const realizedVolBps = volatility(tail);
    const historicalVol: number[] = [];
    for (let i = 20; i < closed.length - 1; i++) {
        const sample = closed.slice(i - 20, i + 1);
        if (contiguous(sample, step)) historicalVol.push(volatility(sample));
    }
    return {
        closedAt: end, sampleBars: tail.length, close: latest.close, previousClose: prior.at(-1)!.close,
        priorHigh: high, priorLow: low, atrBps: atr > 0 ? atr / prior.at(-1)!.close * 10_000 : null,
        realizedVolBps, volatilitySamples: historicalVol.length,
        volatilityPercentile: historicalVol.length >= 20 ? rankPercentile(realizedVolBps, historicalVol) : null,
        trendReturnBps: bps(prior.at(-1)!.close, prior[0].close),
        trendEfficiency: path > 0 ? Math.abs(change) / path : null,
        barReturnBps: bps(latest.close, prior.at(-1)!.close),
        rangePosition: range > 0 ? (latest.close - low) / range : null,
        highDistanceAtr: atr > 0 ? (latest.close - high) / atr : null,
        lowDistanceAtr: atr > 0 ? (low - latest.close) / atr : null,
        displacementAtr: atr > 0 ? (latest.close - mean(prior.map(bar => bar.close))) / atr : null,
        retracementAtr: atr > 0 ? (prior.at(-1)!.close >= prior[0].close ? high - latest.close : latest.close - low) / atr : null,
        relativeVolume: volume > 0 ? latest.volume / volume : null,
        compression,
    };
}
export function rankPercentile(value: number, xs: number[]) {
    return 100 * xs.reduce((sum, x) => sum + (x < value ? 1 : x === value ? .5 : 0), 0) / xs.length;
}
export type BarFeatures = NonNullable<ReturnType<typeof barFeatures>>;

export function instrumentFeatures(bars: SwingBar[], asOf: number) {
    const frame = Object.fromEntries(timeframes.map(tf => {
        const step = intervals[tf];
        const rows = tf === "15m" ? bars : aggregateBars(bars, step, intervals["15m"], asOf);
        return [tf, barFeatures(rows, step, asOf)];
    })) as Record<ScreenTimeframe, BarFeatures | null>;
    const end = Math.floor(asOf / intervals["15m"]) * intervals["15m"];
    const map = new Map(bars.map(x => [x.at, x.close]));
    const close = map.get(end - intervals["15m"]);
    const changes = Object.fromEntries(Object.entries(windows).map(([key, duration]) => {
        const before = map.get(end - intervals["15m"] - duration);
        return [key, close && before ? bps(close, before) : null];
    })) as Record<ContextWindow, number | null>;
    const priorChanges = Object.fromEntries(Object.entries(windows).map(([key, duration]) => {
        const priorClose = map.get(end - intervals["15m"] - duration);
        const before = map.get(end - intervals["15m"] - 2 * duration);
        return [key, priorClose && before ? bps(priorClose, before) : null];
    })) as Record<ContextWindow, number | null>;
    return { frame, changes, priorChanges, returnClosedAt: close ? end : null };
}

export type MarketFeatureRow = ReturnType<typeof instrumentFeatures> & {
    instrumentId: string; symbol: string; observedAt: number | null;
    price: number | null; volume24h: number | null; fundingHourly: number | null;
    fundingPercentile: number | null; fundingSamples: number; openInterestBase: number | null;
    openInterestUsd: number | null; oiChange1hPct: number | null;
    basisBps: number | null; spreadBps: number | null;
    tickReturns?: { "1h": number | null; "4h": number | null };
};
export type MarketFeatureSnapshot = {
    version: 1; id: string; network: "mainnet" | "testnet"; asOf: number; durationMs: number;
    instruments: MarketFeatureRow[]; directory?: DeskInstrument[]; candleError: string | null;
};

export function relative(row: MarketFeatureRow, benchmark: MarketFeatureRow | undefined, timeframe: ContextWindow) {
    const a = row.changes[timeframe], b = benchmark?.changes[timeframe];
    return a != null && b != null && row.returnClosedAt === benchmark?.returnClosedAt ? a - b : null;
}

export function marketBreadth(rows: MarketFeatureRow[], at: number) {
    const fresh = rows.filter(r => r.observedAt != null && r.observedAt <= at + 1000 && r.observedAt >= at - 2 * minute);
    const btc = fresh.find(r => r.symbol === "BTC"), eth = fresh.find(r => r.symbol === "ETH");
    const ratio = (xs: number[]) => xs.length ? xs.filter(n => n > 0).length / xs.length : null;
    return Object.fromEntries(Object.keys(windows).map(key => {
        const tf = key as ContextWindow;
        const useTicks = tf === "1h" || tf === "4h";
        const observed = (row: MarketFeatureRow | undefined) => row ?
            (useTicks ? row.tickReturns?.[tf] ?? null : row.changes[tf]) : null;
        const returns = fresh.map(observed).filter(x => x != null);
        const paired = fresh.filter(r => r.changes[tf] != null && r.priorChanges?.[tf] != null);
        const priorAdvancing = ratio(paired.map(r => r.priorChanges[tf]!));
        const currentAdvancing = ratio(paired.map(r => r.changes[tf]!));
        const versus = (row: MarketFeatureRow, benchmark: MarketFeatureRow | undefined) => {
            if (!useTicks) return relative(row, benchmark, tf);
            const a = observed(row), b = observed(benchmark);
            return a != null && b != null && Math.abs(row.observedAt! - benchmark!.observedAt!) <= minute ? a - b : null;
        };
        const btcReturns = fresh.filter(r => r !== btc).map(r => versus(r, btc)).filter(x => x != null);
        const ethReturns = fresh.filter(r => r !== eth).map(r => versus(r, eth)).filter(x => x != null);
        const upper = percentile(returns, .75), lower = percentile(returns, .25);
        return [tf, { source: useTicks ? "collector_mark_snapshots" : "closed_candles", measured: returns.length, eligible: rows.length,
            advancing: returns.filter(n => n > 0).length, declining: returns.filter(n => n < 0).length,
            participationMeasured: paired.length,
            advancingChangePp: currentAdvancing != null && priorAdvancing != null ? (currentAdvancing - priorAdvancing) * 100 : null,
            medianBps: median(returns), dispersionBps: upper != null && lower != null ? upper - lower : null,
            outperformBtc: ratio(btcReturns), outperformEth: ratio(ethReturns),
            versusBtcMeasured: btcReturns.length, versusEthMeasured: ethReturns.length }];
    }));
}
