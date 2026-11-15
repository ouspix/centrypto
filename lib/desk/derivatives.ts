import { hyperliquidInfoUrl } from "@/lib/hyperliquid-info";
import { hyperliquidInfoPost } from "@/lib/rate-limit/hyperliquid-limiter";
import type { DeskInstrument } from "./instruments";

export const FUNDING_SOURCE = "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding";
export const FUNDING_CONVENTION = {
    intervalHours: 1,
    rateUnit: "decimal per hour; 0.0000125 = 0.00125% per hour",
    positiveRate: "longs pay shorts",
    paymentBasis: "venue position quantity * oracle price * hourly rate; do not divide the API rate by eight",
    forecast: "Current rate is indicative, not a guaranteed future payment or convergence deadline.",
    source: FUNDING_SOURCE,
} as const;

export type FundingContext = {
    funding?: unknown; markPx?: unknown; oraclePx?: unknown; openInterest?: unknown; premium?: unknown;
};
type FundingSnapshot = [{ universe: { name: string }[] }, FundingContext[]];

// Use a separate cache key: the general market helper can serve stale-on-error
// data without its original timestamp. ShiftReads owns freshness for desk reads.
export async function deskFundingSnapshot(testnet: boolean) {
    const data = await hyperliquidInfoPost<FundingSnapshot>(
        "hl:info:deskAssetCtxs", hyperliquidInfoUrl(testnet), { type: "metaAndAssetCtxs" },
        { ttlMs: 0, staleMs: 0, allowStale: false },
    );
    if (!Array.isArray(data?.[0]?.universe) || !Array.isArray(data?.[1]))
        throw new Error("Funding data unavailable.");
    return { universe: data[0].universe, assetCtxs: data[1] };
}

function numeric(value: unknown): number | null {
    if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function positive(value: unknown): number | null {
    const n = numeric(value);
    return n !== null && n > 0 ? n : null;
}
type Quote = { bid: number; ask: number };

export function fundingMetrics(ctx: FundingContext, multiplier: number, perp: Quote | null, spot: Quote | null) {
    const rate = numeric(ctx.funding), mark = positive(ctx.markPx), oracle = positive(ctx.oraclePx);
    const oi = numeric(ctx.openInterest), premium = numeric(ctx.premium);
    if (rate === null || mark === null || oracle === null || !(multiplier > 0 && Number.isFinite(multiplier)))
        throw new Error("Invalid funding rate or reference prices.");
    const quoteValid = (q: Quote | null): q is Quote => !!q &&
        Number.isFinite(q.bid) && Number.isFinite(q.ask) && q.bid > 0 && q.ask >= q.bid;
    const cash = quoteValid(spot) ? spot : null, future = quoteValid(perp) ? perp : null;
    return {
        fundingRate: rate,
        fundingConvention: FUNDING_CONVENTION,
        hourlyFundingBps: rate * 1e4,
        shortFundingPerHourPerVenueUnit: oracle * rate,
        longFundingPerHourPerVenueUnit: -oracle * rate,
        mark, oracle,
        premiumBps: premium === null ? null : premium * 1e4,
        openInterest: oi !== null && oi >= 0 ? oi : null,
        openInterestUnit: "venue quantity; multiply by contractMultiplier for underlying units",
        openInterestNotionalAtOracle: oi !== null && oi >= 0 ? oi * oracle : null,
        contractMultiplier: multiplier,
        basisBps: cash ? (mark / multiplier / ((cash.bid + cash.ask) / 2) - 1) * 1e4 : null,
        basisReference: "indicative mark / contractMultiplier versus spot midpoint; not executable profit",
        entryBasis: cash && future ? {
            longSpotShortPerpBps: (future.bid / multiplier / cash.ask - 1) * 1e4,
            shortSpotLongPerpBps: (cash.bid / (future.ask / multiplier) - 1) * 1e4,
            qualification: "Top of book, non-atomic, before fees, size impact, exit basis, borrow, conversion and leg risk. Neither spread is locked-in convergence profit.",
        } : null,
    };
}

export function spotBasisCandidates(perp: DeskInstrument, items: DeskInstrument[]) {
    // A ticker match is discovery only, never proof of redemption or token identity.
    return items.filter(i => i.kind === "spot" && i.isTestnet === perp.isTestnet &&
        i.base === perp.base && i.quoteTokenIndex === 0);
}

type FundingSample = { coin: string; fundingRate: string; premium?: string; time: number };
export function summarizeFundingHistory(rows: FundingSample[], coin: string, start: number, end: number) {
    if (!Array.isArray(rows)) throw new Error("Funding history unavailable.");
    const unique = new Map<number, { at: string; time: number; rate: number }>();
    for (const row of rows) {
        const rate = numeric(row?.fundingRate);
        if (row?.coin !== coin || rate === null || !Number.isSafeInteger(row.time) || row.time < start || row.time > end) continue;
        unique.set(row.time, { at: new Date(row.time).toISOString(), time: row.time, rate });
    }
    const samples = [...unique.values()].sort((a, b) => a.time - b.time);
    const sum = samples.reduce((s, r) => s + r.rate, 0);
    return {
        fundingConvention: FUNDING_CONVENTION,
        from: new Date(start).toISOString(), through: new Date(end).toISOString(),
        sampleCount: samples.length,
        firstAt: samples[0]?.at ?? null, lastAt: samples.at(-1)?.at ?? null,
        missingHourlySamples: Math.max(0, Math.floor(end / 3600000) - Math.floor(start / 3600000) +
            (start % 3600000 === 0 ? 1 : 0) - samples.length),
        positiveHours: samples.filter(s => s.rate > 0).length,
        negativeHours: samples.filter(s => s.rate < 0).length,
        meanHourlyRate: samples.length ? sum / samples.length : null,
        sumHourlyRates: samples.length ? sum : null,
        minHourlyRate: samples.length ? Math.min(...samples.map(s => s.rate)) : null,
        maxHourlyRate: samples.length ? Math.max(...samples.map(s => s.rate)) : null,
        recent: samples.slice(-8).map(({ at, rate }) => ({ at, rate })),
        limitation: "Observed settlements only; missing hours are not zero. Sum of rates is not realized PnL because oracle notional changes. History does not guarantee persistence.",
    };
}

export async function deskFundingHistory(testnet: boolean, coin: string, hours: number, end = Date.now()) {
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw new Error("Choose 1 to 72 hours of funding history.");
    const start = end - hours * 3600000;
    const rows = await hyperliquidInfoPost<FundingSample[]>(
        "hl:info:fundingHistory", hyperliquidInfoUrl(testnet),
        { type: "fundingHistory", coin, startTime: start, endTime: end },
        { ttlMs: 0, staleMs: 0, allowStale: false },
    );
    return summarizeFundingHistory(rows, coin, start, end);
}
