import fs from "fs";
import path from "path";
import readline from "readline";
import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ALLOWED_FEATURE_INTERVALS, ExecutionBookSnapshot, L2BookLevel, L2BookSnapshot, MarketFeatureRow } from "./BacktestTypes";

type FeatureBuildOptions = {
    intervalSeconds?: number;
    takerFeeBps?: number;
    sourceDate?: string | null;
    sourceHour?: number | null;
    sourceFile?: string | null;
};

export async function parseHyperliquidL2File(filePath: string, symbol: string): Promise<L2BookSnapshot[]> {
    const snapshots: L2BookSnapshot[] = [];
    const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity
    });

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
            const parsed = JSON.parse(trimmed);
            const row = parsed?.raw?.data?.levels
                ? parsed.raw.data
                : parsed?.data?.levels
                    ? parsed.data
                    : parsed;
            if (row && !row.time && parsed?.time) row.time = parsed.time;
            const snapshot = parseL2Row(row, symbol);
            if (snapshot) snapshots.push(snapshot);
        } catch {
            // Skip malformed JSONL rows. Archive files can contain partial/corrupt tails.
        }
    }

    return snapshots.sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

export function buildMarketFeaturesFromSnapshots(
    snapshots: L2BookSnapshot[],
    options: FeatureBuildOptions = {}
): MarketFeatureRow[] {
    const intervalSeconds = options.intervalSeconds ?? 10;
    assertAllowedInterval(intervalSeconds);

    const sampled = sampleSnapshots(snapshots, intervalSeconds);
    const rows: MarketFeatureRow[] = [];
    const takerFeeBps = options.takerFeeBps ?? DEFAULT_AGENT_CONFIG.network_profiles.mainnet.fees_bps;

    for (const snapshot of sampled) {
        const core = computeCoreFeatures(snapshot, takerFeeBps);
        if (!core) continue;
        rows.push({
            ...core,
            intervalSeconds,
            ret_1m: null,
            ret_5m: null,
            ret_15m: null,
            ret_1h: null,
            ret_4h: null,
            realized_vol_5m: null,
            realized_vol_1h: null,
            vol_ratio_5m_vs_1h: null,
            ret_sigma_5m_vs_1h: null,
            trend_side: null,
            trend_alignment_score: null,
            source_date: options.sourceDate ?? null,
            source_hour: options.sourceHour ?? null,
            source_file: options.sourceFile ?? null
        });
    }

    addRollingFeatures(rows);
    return rows;
}

export function buildExecutionBooksFromSnapshots(
    snapshots: L2BookSnapshot[],
    options: { intervalSeconds?: number; maxLevels?: number } = {}
): ExecutionBookSnapshot[] {
    const intervalSeconds = options.intervalSeconds ?? 10;
    assertAllowedInterval(intervalSeconds);
    const maxLevels = options.maxLevels ?? 25;

    return sampleSnapshots(snapshots, intervalSeconds).map(snapshot => ({
        ts: snapshot.ts,
        symbol: toPerpSymbol(snapshot.symbol),
        intervalSeconds,
        bids: snapshot.bids.slice(0, maxLevels),
        asks: snapshot.asks.slice(0, maxLevels)
    }));
}

export function inferSourceFromPath(filePath: string): Pick<FeatureBuildOptions, "sourceDate" | "sourceHour" | "sourceFile"> {
    const parts = filePath.split(path.sep);
    const date = parts.find(part => /^\d{8}$/.test(part)) ?? null;
    const hourCandidate = date ? parts[parts.indexOf(date) + 1] : null;
    const hour = hourCandidate && /^\d{1,2}$/.test(hourCandidate) ? Number(hourCandidate) : null;
    return {
        sourceDate: date,
        sourceHour: hour,
        sourceFile: filePath
    };
}

function parseL2Row(row: any, symbol: string): L2BookSnapshot | null {
    if (!row?.levels || !Array.isArray(row.levels) || row.levels.length < 2) return null;
    const ts = parseTimestamp(row.time ?? row.ts ?? row.timestamp ?? row.T);
    if (!ts) return null;

    const bids = parseLevels(row.levels[0], "bid");
    const asks = parseLevels(row.levels[1], "ask");
    if (bids.length === 0 || asks.length === 0) return null;

    return { ts, symbol, bids, asks };
}

function parseTimestamp(value: unknown): Date | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    if (typeof value === "number") {
        const ms = value < 10_000_000_000 ? value * 1000 : value;
        const date = new Date(ms);
        return Number.isFinite(date.getTime()) ? date : null;
    }
    if (typeof value === "string") {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return parseTimestamp(numeric);
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? date : null;
    }
    return null;
}

function parseLevels(levels: unknown, side: "bid" | "ask"): L2BookLevel[] {
    if (!Array.isArray(levels)) return [];
    const parsed: L2BookLevel[] = [];

    for (const level of levels) {
        const priceRaw = Array.isArray(level) ? level[0] : (level as any)?.px;
        const sizeRaw = Array.isArray(level) ? level[1] : (level as any)?.sz;
        const price = Number(priceRaw);
        const size = Number(sizeRaw);
        if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;
        parsed.push({ price, size });
    }

    parsed.sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price);
    return parsed;
}

function assertAllowedInterval(intervalSeconds: number): void {
    if (!ALLOWED_FEATURE_INTERVALS.includes(intervalSeconds as any)) {
        throw new Error(`intervalSeconds must be one of ${ALLOWED_FEATURE_INTERVALS.join(", ")}`);
    }
}

function sampleSnapshots(snapshots: L2BookSnapshot[], intervalSeconds: number): L2BookSnapshot[] {
    const byBucket = new Map<number, L2BookSnapshot>();
    const intervalMs = intervalSeconds * 1000;
    for (const snapshot of snapshots) {
        const bucketMs = Math.ceil(snapshot.ts.getTime() / intervalMs) * intervalMs;
        byBucket.set(bucketMs, { ...snapshot, ts: new Date(bucketMs) });
    }
    return Array.from(byBucket.values()).sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

function computeCoreFeatures(snapshot: L2BookSnapshot, takerFeeBps: number): Omit<MarketFeatureRow,
    "intervalSeconds" | "ret_1m" | "ret_5m" | "ret_15m" | "ret_1h" | "ret_4h" |
    "realized_vol_5m" | "realized_vol_1h" | "vol_ratio_5m_vs_1h" | "ret_sigma_5m_vs_1h" |
    "trend_side" | "trend_alignment_score" | "source_date" | "source_hour" | "source_file"> | null {
    const bestBid = snapshot.bids[0]?.price;
    const bestAsk = snapshot.asks[0]?.price;
    if (!bestBid || !bestAsk || bestAsk <= bestBid) return null;

    const mid = (bestBid + bestAsk) / 2;
    const spreadBps = 10000 * (bestAsk - bestBid) / mid;
    const depth5 = depthPair(snapshot, mid, 5);
    const depth10 = depthPair(snapshot, mid, 10);
    const depth25 = depthPair(snapshot, mid, 25);
    const buy100 = walkBook(snapshot.asks, 100, bestAsk, "buy");
    const sell100 = walkBook(snapshot.bids, 100, bestBid, "sell");
    const buy500 = walkBook(snapshot.asks, 500, bestAsk, "buy");
    const sell500 = walkBook(snapshot.bids, 500, bestBid, "sell");

    return {
        ts: snapshot.ts,
        symbol: toPerpSymbol(snapshot.symbol),
        best_bid: bestBid,
        best_ask: bestAsk,
        mid_price: mid,
        spread_bps: spreadBps,
        bid_depth_5bps_usd: depth5.bid,
        ask_depth_5bps_usd: depth5.ask,
        bid_depth_10bps_usd: depth10.bid,
        ask_depth_10bps_usd: depth10.ask,
        bid_depth_25bps_usd: depth25.bid,
        ask_depth_25bps_usd: depth25.ask,
        depth_5bps_usd: Math.min(depth5.bid, depth5.ask),
        depth_10bps_usd: Math.min(depth10.bid, depth10.ask),
        depth_25bps_usd: Math.min(depth25.bid, depth25.ask),
        book_pressure_5bps: pressure(depth5.bid, depth5.ask),
        book_pressure_10bps: pressure(depth10.bid, depth10.ask),
        book_pressure_25bps: pressure(depth25.bid, depth25.ask),
        buy_slippage_bps_100: buy100,
        sell_slippage_bps_100: sell100,
        buy_slippage_bps_500: buy500,
        sell_slippage_bps_500: sell500,
        cost_bps_100: costBps(takerFeeBps, spreadBps, buy100, sell100),
        cost_bps_500: costBps(takerFeeBps, spreadBps, buy500, sell500)
    };
}

function depthPair(snapshot: L2BookSnapshot, mid: number, bps: number): { bid: number; ask: number } {
    const bidFloor = mid * (1 - bps / 10000);
    const askCeil = mid * (1 + bps / 10000);
    let bid = 0;
    let ask = 0;

    for (const level of snapshot.bids) {
        if (level.price < bidFloor) break;
        bid += level.price * level.size;
    }
    for (const level of snapshot.asks) {
        if (level.price > askCeil) break;
        ask += level.price * level.size;
    }

    return { bid, ask };
}

function pressure(bid: number, ask: number): number {
    const denom = bid + ask;
    return denom > 0 ? (bid - ask) / denom : 0;
}

function walkBook(levels: L2BookLevel[], notionalUsd: number, referencePrice: number, side: "buy" | "sell"): number | null {
    let remaining = notionalUsd;
    let baseFilled = 0;
    let quoteSpent = 0;

    for (const level of levels) {
        const levelNotional = level.price * level.size;
        const takeNotional = Math.min(remaining, levelNotional);
        const takeSize = takeNotional / level.price;
        baseFilled += takeSize;
        quoteSpent += takeNotional;
        remaining -= takeNotional;
        if (remaining <= 1e-9) break;
    }

    if (remaining > 1e-6 || baseFilled <= 0 || quoteSpent <= 0) return null;
    const avgFill = quoteSpent / baseFilled;
    return side === "buy"
        ? 10000 * (avgFill / referencePrice - 1)
        : 10000 * (1 - avgFill / referencePrice);
}

function costBps(takerFeeBps: number, spreadBps: number, entrySlip: number | null, exitSlip: number | null): number | null {
    if (entrySlip === null || exitSlip === null) return null;
    return (2 * takerFeeBps) + spreadBps + entrySlip + exitSlip;
}

function addRollingFeatures(rows: MarketFeatureRow[]): void {
    rows.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    const stepMs = medianStepMs(rows);
    const mids = rows.map(row => row.mid_price);
    const shortReturns: number[] = [];

    for (let i = 0; i < rows.length; i++) {
        rows[i].ret_1m = returnAt(rows, i, 60_000, stepMs);
        rows[i].ret_5m = returnAt(rows, i, 5 * 60_000, stepMs);
        rows[i].ret_15m = returnAt(rows, i, 15 * 60_000, stepMs);
        rows[i].ret_1h = returnAt(rows, i, 60 * 60_000, stepMs);
        rows[i].ret_4h = returnAt(rows, i, 4 * 60 * 60_000, stepMs);

        if (i > 0 && mids[i - 1] > 0) {
            shortReturns[i] = Math.log(mids[i] / mids[i - 1]);
        } else {
            shortReturns[i] = 0;
        }

        const vol5m = stddev(lastN(shortReturns, i, Math.max(2, Math.round((5 * 60_000) / stepMs))));
        const vol1h = stddev(lastN(shortReturns, i, Math.max(2, Math.round((60 * 60_000) / stepMs))));
        rows[i].realized_vol_5m = vol5m;
        rows[i].realized_vol_1h = vol1h;
        rows[i].vol_ratio_5m_vs_1h = vol1h && vol1h > 0 ? vol5m / vol1h : null;

        const ret5Distribution = rollingWindow(rows, i, 60 * 60_000)
            .map(row => row.ret_5m)
            .filter((value): value is number => value !== null && Number.isFinite(value));
        const ret5 = rows[i].ret_5m;
        if (ret5 !== null && ret5Distribution.length >= 10) {
            const mean = average(ret5Distribution);
            const sd = stddev(ret5Distribution);
            rows[i].ret_sigma_5m_vs_1h = sd > 0 ? (ret5 - mean) / sd : null;
        } else if (ret5 !== null && vol1h > 0) {
            rows[i].ret_sigma_5m_vs_1h = ret5 / vol1h;
        }

        const score = trendScore(rows[i]);
        rows[i].trend_alignment_score = score;
        rows[i].trend_side = score > 0.5 ? "long" : score < -0.5 ? "short" : "neutral";
    }
}

function medianStepMs(rows: MarketFeatureRow[]): number {
    if (rows.length < 2) return 10_000;
    const diffs: number[] = [];
    for (let i = 1; i < rows.length; i++) diffs.push(rows[i].ts.getTime() - rows[i - 1].ts.getTime());
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)] || 10_000;
}

function returnAt(rows: MarketFeatureRow[], index: number, lookbackMs: number, stepMs: number): number | null {
    const target = rows[index].ts.getTime() - lookbackMs;
    let lo = 0;
    let hi = index - 1;
    let best = -1;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (rows[mid].ts.getTime() <= target) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best < 0 || rows[best].mid_price <= 0) return null;
    if (Math.abs(rows[best].ts.getTime() - target) > stepMs * 2) return null;
    return rows[index].mid_price / rows[best].mid_price - 1;
}

function lastN(values: number[], endIndex: number, count: number): number[] {
    return values.slice(Math.max(0, endIndex - count + 1), endIndex + 1);
}

function rollingWindow(rows: MarketFeatureRow[], index: number, lookbackMs: number): MarketFeatureRow[] {
    const cutoff = rows[index].ts.getTime() - lookbackMs;
    const result: MarketFeatureRow[] = [];
    for (let i = index; i >= 0; i--) {
        if (rows[i].ts.getTime() < cutoff) break;
        result.push(rows[i]);
    }
    return result;
}

function average(values: number[]): number {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = average(values);
    const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
}

function trendScore(row: MarketFeatureRow): number {
    const signs = [row.ret_1m, row.ret_5m, row.ret_15m]
        .filter((value): value is number => value !== null && Math.abs(value) > 0)
        .map(Math.sign);
    if (signs.length === 0) return 0;
    return signs.reduce((sum, sign) => sum + sign, 0) / signs.length;
}

function toPerpSymbol(symbol: string): string {
    return symbol.endsWith("-PERP") ? symbol : `${symbol}-PERP`;
}
