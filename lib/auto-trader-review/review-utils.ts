import crypto from "crypto";
import {
    AutoTraderAttributionMethod,
    AutoTraderAttributionStatus,
    AutoTraderFillType,
    AutoTraderMfeCoverage,
    AutoTraderMfeSource,
    AutoTraderNetwork,
    AutoTraderOrderStatus,
    DEFAULT_REVIEW_THRESHOLDS,
    LifecycleInputFill,
    NormalizedFill,
    ReconstructedLifecycle,
    ReviewThresholds
} from "@/types/auto-trader-review";

export const AUTO_TRADER_RECONSTRUCTION_VERSION = "v1";

export function attachCloidEnabled(): boolean {
    return process.env.AUTO_TRADER_ATTACH_CLOID !== "false";
}

export function generateCloid(): `0x${string}` {
    return `0x${crypto.randomBytes(16).toString("hex")}`;
}

export function normalizeCoinToPerp(rawCoin: unknown): string {
    const coin = String(rawCoin ?? "").trim();
    if (!coin) return "UNKNOWN-PERP";
    return coin.endsWith("-PERP") ? coin : `${coin}-PERP`;
}

export function normalizeHyperliquidFill(
    fill: any,
    input: {
        accountAddress: string;
        agentWalletAddress?: string | null;
        network: AutoTraderNetwork;
    }
): NormalizedFill {
    const rawCoin = String(fill?.coin ?? fill?.rawCoin ?? "UNKNOWN");
    const px = numberFrom(fill?.px);
    const sz = Math.abs(numberFrom(fill?.sz));
    const closedPnl = numberFrom(fill?.closedPnl);
    const fee = Math.abs(numberFrom(fill?.fee));
    const timeMs = numberFrom(fill?.time);
    const time = Number.isFinite(timeMs) && timeMs > 0 ? new Date(timeMs) : new Date(0);
    const oid = nullableString(fill?.oid);
    const hash = nullableString(fill?.hash);
    const tid = nullableString(fill?.tid);
    const cloid = nullableString(fill?.cloid);
    const side = nullableString(fill?.side);
    const dir = nullableString(fill?.dir);

    return {
        accountAddress: input.accountAddress,
        agentWalletAddress: input.agentWalletAddress ?? null,
        network: input.network,
        rawCoin,
        normalizedSymbol: normalizeCoinToPerp(rawCoin),
        px,
        sz,
        side,
        dir,
        closedPnl,
        fee,
        hash,
        oid,
        cloid,
        tid,
        time,
        fillType: fillTypeFromDir(dir),
        dedupeKey: fillDedupeKey({
            accountAddress: input.accountAddress,
            network: input.network,
            tid,
            hash,
            oid,
            rawCoin,
            side,
            px,
            sz,
            time
        }),
        rawJson: JSON.stringify(fill)
    };
}

export function fillDedupeKey(input: {
    accountAddress: string;
    network: AutoTraderNetwork;
    tid?: string | null;
    hash?: string | null;
    oid?: string | null;
    rawCoin: string;
    side?: string | null;
    px: number;
    sz: number;
    time: Date;
}): string {
    if (input.tid) return `${input.accountAddress}:${input.network}:tid:${input.tid}`;
    return [
        input.accountAddress,
        input.network,
        input.hash ?? "no-hash",
        input.oid ?? "no-oid",
        input.rawCoin,
        input.side ?? "no-side",
        input.px.toString(),
        input.sz.toString(),
        input.time.getTime().toString()
    ].join(":");
}

export function fillTypeFromDir(dir: string | null | undefined): AutoTraderFillType {
    const text = String(dir ?? "").toLowerCase();
    if (text.includes("open")) return "OPEN";
    if (text.includes("close") || text.includes("liquidation")) return "CLOSE";
    return "UNKNOWN";
}

export function sideFromFillDir(dir: string | null | undefined): "long" | "short" | null {
    const text = String(dir ?? "").toLowerCase();
    if (text.includes("long")) return "long";
    if (text.includes("short")) return "short";
    return null;
}

export function reconstructTradeLifecycles(input: {
    accountAddress: string;
    network: AutoTraderNetwork;
    fills: LifecycleInputFill[];
}): ReconstructedLifecycle[] {
    const lifecycles: ReconstructedLifecycle[] = [];
    const openQueues: Record<string, ReconstructedLifecycle[]> = {};

    const sorted = [...input.fills].sort((a, b) => a.time.getTime() - b.time.getTime());

    for (const fill of sorted) {
        if (!Number.isFinite(fill.px) || fill.px <= 0 || !Number.isFinite(fill.sz) || fill.sz <= 0) continue;
        const lifecycleSide = sideFromFillDir(fill.dir);
        if (!lifecycleSide) continue;

        const fillType = fillTypeFromDir(fill.dir);
        const queueKey = `${fill.normalizedSymbol}:${lifecycleSide}`;
        if (!openQueues[queueKey]) openQueues[queueKey] = [];

        if (fillType === "OPEN") {
            const lifecycle: ReconstructedLifecycle = {
                accountAddress: input.accountAddress,
                network: input.network,
                symbol: fill.normalizedSymbol,
                side: lifecycleSide,
                openedAt: fill.time,
                closedAt: null,
                status: "OPEN",
                openFillIds: [fill.id],
                closeFillIds: [],
                attributedDecisionIds: uniqueNullable([fill.decisionId]),
                attributedOrderAttemptIds: uniqueNullable([fill.orderAttemptId]),
                entryPrice: fill.px,
                exitPrice: null,
                sizeOpened: fill.sz,
                sizeClosed: 0,
                grossRealizedPnl: 0,
                fees: fill.fee,
                netRealizedPnl: -fill.fee,
                attributionMethod: lifecycleAttributionMethod([fill]),
                rawDebugJson: { openFills: [fill.id], closeAllocations: [] }
            };
            lifecycles.push(lifecycle);
            openQueues[queueKey].push(lifecycle);
            continue;
        }

        if (fillType !== "CLOSE") continue;

        let remaining = fill.sz;
        const queue = openQueues[queueKey];
        while (remaining > 1e-9 && queue.length > 0) {
            const lifecycle = queue[0];
            const openRemaining = Math.max(0, lifecycle.sizeOpened - lifecycle.sizeClosed);
            const matchedSize = Math.min(openRemaining, remaining);
            if (matchedSize <= 1e-9) {
                queue.shift();
                continue;
            }

            const ratio = matchedSize / fill.sz;
            const allocatedPnl = fill.closedPnl * ratio;
            const allocatedFee = fill.fee * ratio;
            const previousClosed = lifecycle.sizeClosed;
            const newClosed = previousClosed + matchedSize;
            lifecycle.exitPrice = weightedAverage(
                lifecycle.exitPrice,
                previousClosed,
                fill.px,
                matchedSize
            );
            lifecycle.sizeClosed = round6(newClosed);
            lifecycle.grossRealizedPnl = round8(lifecycle.grossRealizedPnl + allocatedPnl);
            lifecycle.fees = round8(lifecycle.fees + allocatedFee);
            lifecycle.netRealizedPnl = round8(lifecycle.grossRealizedPnl - lifecycle.fees);
            lifecycle.closeFillIds = unique([...lifecycle.closeFillIds, fill.id]);
            lifecycle.attributedDecisionIds = unique([...lifecycle.attributedDecisionIds, ...uniqueNullable([fill.decisionId])]);
            lifecycle.attributedOrderAttemptIds = unique([...lifecycle.attributedOrderAttemptIds, ...uniqueNullable([fill.orderAttemptId])]);
            lifecycle.attributionMethod = strongestAttribution(lifecycle.attributionMethod, lifecycleAttributionMethod([fill]));
            lifecycle.rawDebugJson = {
                ...lifecycle.rawDebugJson,
                closeAllocations: [
                    ...((lifecycle.rawDebugJson.closeAllocations as unknown[]) ?? []),
                    { fillId: fill.id, matchedSize, allocatedPnl, allocatedFee }
                ]
            };

            remaining -= matchedSize;
            if (lifecycle.sizeClosed >= lifecycle.sizeOpened - 1e-8) {
                lifecycle.status = "CLOSED";
                lifecycle.closedAt = fill.time;
                queue.shift();
            }
        }
    }

    return lifecycles;
}

export function computeMfeMaeFromCandles(input: {
    side: "long" | "short";
    entryPrice: number;
    candles: Array<{ high: number; low: number }>;
    expectedMinutes?: number;
}): { mfeBps: number | null; maeBps: number | null; source: AutoTraderMfeSource; coverage: AutoTraderMfeCoverage } {
    if (!input.candles.length || input.entryPrice <= 0) {
        return { mfeBps: null, maeBps: null, source: "UNKNOWN", coverage: "NONE" };
    }

    const highs = input.candles.map(c => c.high).filter(value => Number.isFinite(value));
    const lows = input.candles.map(c => c.low).filter(value => Number.isFinite(value));
    if (!highs.length || !lows.length) return { mfeBps: null, maeBps: null, source: "UNKNOWN", coverage: "NONE" };

    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    const mfeBps = input.side === "long"
        ? ((maxHigh - input.entryPrice) / input.entryPrice) * 10000
        : ((input.entryPrice - minLow) / input.entryPrice) * 10000;
    const maeBps = input.side === "long"
        ? ((minLow - input.entryPrice) / input.entryPrice) * 10000
        : ((input.entryPrice - maxHigh) / input.entryPrice) * 10000;
    const expected = input.expectedMinutes ?? input.candles.length;
    const coverage: AutoTraderMfeCoverage = expected <= 0 || input.candles.length >= expected * 0.9 ? "FULL" : "PARTIAL";

    return {
        mfeBps: round4(mfeBps),
        maeBps: round4(maeBps),
        source: "CANDLE_1M",
        coverage
    };
}

export function computeMfeMaeFromMarks(input: {
    side: "long" | "short";
    entryPrice: number;
    marks: number[];
}): { mfeBps: number | null; maeBps: number | null; source: AutoTraderMfeSource; coverage: AutoTraderMfeCoverage } {
    const marks = input.marks.filter(value => Number.isFinite(value) && value > 0);
    if (!marks.length || input.entryPrice <= 0) {
        return { mfeBps: null, maeBps: null, source: "UNKNOWN", coverage: "NONE" };
    }
    const maxMark = Math.max(...marks);
    const minMark = Math.min(...marks);
    const mfeBps = input.side === "long"
        ? ((maxMark - input.entryPrice) / input.entryPrice) * 10000
        : ((input.entryPrice - minMark) / input.entryPrice) * 10000;
    const maeBps = input.side === "long"
        ? ((minMark - input.entryPrice) / input.entryPrice) * 10000
        : ((input.entryPrice - maxMark) / input.entryPrice) * 10000;
    return {
        mfeBps: round4(mfeBps),
        maeBps: round4(maeBps),
        source: "POSITION_SNAPSHOT",
        coverage: "PARTIAL"
    };
}

export function computeReviewFlags(input: {
    mfeBps: number | null;
    entryPrice: number;
    sizeOpened: number;
    netRealizedPnl: number;
    status?: "OPEN" | "CLOSED" | string | null;
    thresholds?: ReviewThresholds;
}): { observedGreenToRed: boolean; lateGiveback: boolean; givebackPct: number | null } {
    const thresholds = input.thresholds ?? DEFAULT_REVIEW_THRESHOLDS;
    if (input.status && input.status !== "CLOSED") {
        return { observedGreenToRed: false, lateGiveback: false, givebackPct: null };
    }
    if (input.mfeBps === null || input.mfeBps <= 0 || input.entryPrice <= 0 || input.sizeOpened <= 0) {
        return { observedGreenToRed: false, lateGiveback: false, givebackPct: null };
    }

    const mfePnl = input.entryPrice * input.sizeOpened * (input.mfeBps / 10000);
    if (mfePnl <= 0) return { observedGreenToRed: false, lateGiveback: false, givebackPct: null };
    const givebackPct = Math.max(0, ((mfePnl - input.netRealizedPnl) / mfePnl) * 100);
    return {
        observedGreenToRed: input.mfeBps >= thresholds.greenToRedMinMfeBps && input.netRealizedPnl < 0,
        lateGiveback: input.mfeBps >= thresholds.lateGivebackMinMfeBps && givebackPct >= thresholds.lateGivebackPct,
        givebackPct: round4(givebackPct)
    };
}

export function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify({ unserializable: true });
    }
}

export function hashJson(value: unknown): string {
    return crypto.createHash("sha256").update(safeJson(value)).digest("hex");
}

export function extractOrderStatusOid(status: any): string | null {
    if (!status) return null;
    const candidates = [
        status?.oid,
        status?.order?.oid,
        status?.order?.order?.oid,
        status?.response?.data?.statuses?.[0]?.resting?.oid,
        status?.response?.data?.statuses?.[0]?.filled?.oid,
        status?.response?.data?.statuses?.[0]?.oid
    ];
    for (const candidate of candidates) {
        const value = nullableString(candidate);
        if (value) return value;
    }
    return null;
}

export function extractOrderResponseStatus(response: any, index: number): { status: AutoTraderOrderStatus; oid: string | null; reason: string | null } {
    const item = response?.response?.data?.statuses?.[index];
    if (!item) {
        return response?.status === "ok"
            ? { status: "SUBMITTED", oid: null, reason: null }
            : { status: "FAILED", oid: null, reason: nullableString(response?.response) };
    }
    if (item.error) return { status: "FAILED", oid: null, reason: String(item.error) };
    if (item.filled) return { status: "FILLED", oid: nullableString(item.filled.oid), reason: null };
    if (item.resting) return { status: "RESTING", oid: nullableString(item.resting.oid), reason: null };
    return { status: "SUBMITTED", oid: nullableString(item.oid), reason: null };
}

function lifecycleAttributionMethod(fills: LifecycleInputFill[]): AutoTraderAttributionMethod {
    let method: AutoTraderAttributionMethod = "UNMATCHED";
    for (const fill of fills) {
        method = strongestAttribution(method, normalizeAttributionMethod(fill.attributionMethod));
        if (fill.attributionStatus === "UNMATCHED") method = strongestAttribution(method, "UNMATCHED");
    }
    return method;
}

function normalizeAttributionMethod(method: string | null | undefined): AutoTraderAttributionMethod {
    if (method === "ORDER_ID" || method === "CLOID" || method === "CLOID_TO_OID" || method === "FALLBACK") return method;
    return "UNMATCHED";
}

function strongestAttribution(a: AutoTraderAttributionMethod, b: AutoTraderAttributionMethod): AutoTraderAttributionMethod {
    const rank: Record<AutoTraderAttributionMethod, number> = {
        ORDER_ID: 5,
        CLOID_TO_OID: 4,
        CLOID: 3,
        FALLBACK: 2,
        UNMATCHED: 1
    };
    return rank[b] > rank[a] ? b : a;
}

function numberFrom(value: unknown): number {
    const parsed = typeof value === "number" ? value : parseFloat(String(value ?? "0"));
    return Number.isFinite(parsed) ? parsed : 0;
}

function nullableString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value);
    return text.length ? text : null;
}

function unique<T>(values: T[]): T[] {
    return Array.from(new Set(values));
}

function uniqueNullable(values: Array<string | null | undefined>): string[] {
    return unique(values.filter((value): value is string => !!value));
}

function weightedAverage(currentValue: number | null, currentWeight: number, nextValue: number, nextWeight: number): number {
    if (!currentValue || currentWeight <= 0) return nextValue;
    return ((currentValue * currentWeight) + (nextValue * nextWeight)) / (currentWeight + nextWeight);
}

function round4(value: number): number {
    return Math.round(value * 10000) / 10000;
}

function round6(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
}

function round8(value: number): number {
    return Math.round(value * 100_000_000) / 100_000_000;
}
