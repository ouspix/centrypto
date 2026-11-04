import { hyperliquidInfoPost } from "@/lib/rate-limit/hyperliquid-limiter";
import { getL2Book, hyperliquidInfoUrl } from "@/lib/hyperliquid-info";
import type { DeskInstrument } from "@/lib/desk/instruments";

type Level = { px: string; sz: string };
type Candle = { s: string; t: number; T: number; c: string };
export type NewsMarketObservation = {
    instrumentId: string;
    referenceAt: string | null;
    referenceClose: number | null;
    bookAt: string | null;
    bid: number | null;
    ask: number | null;
    bidDepthWithin25bps: number | null;
    askDepthWithin25bps: number | null;
    moveSincePublicationBps: number | null;
    secondsToDeadline: number | null;
};
export function newsMarketObservation(
    instrument: DeskInstrument,
    baseline: Candle | undefined,
    book: { time: number; levels: Level[][] } | null,
    deadline: string | null,
    now: Date,
): NewsMarketObservation {
    const time = now.getTime();
    const close = Number(baseline?.c);
    const referenceClose = close > 0 && Number.isFinite(close) ? close : null;
    const observed: NewsMarketObservation = {
        instrumentId: instrument.id,
        referenceAt: referenceClose && baseline ? new Date(baseline.T).toISOString() : null,
        referenceClose,
        bookAt: null,
        bid: null,
        ask: null,
        bidDepthWithin25bps: null,
        askDepthWithin25bps: null,
        moveSincePublicationBps: null,
        secondsToDeadline: deadline ? Math.round((Date.parse(deadline) - time) / 1000) : null,
    };
    if (!book || !Number.isFinite(book.time) || book.time > time || time - book.time > 10_000) return observed;
    const [bids, asks] = book.levels ?? [];
    const bid = Number(bids?.[0]?.px),
        ask = Number(asks?.[0]?.px);
    if (!Number.isFinite(ask) || !(bid > 0 && ask >= bid)) return observed;
    const mid = (bid + ask) / 2;
    const depth = (levels: Level[]) =>
        levels.reduce((sum, level) => {
            const px = Number(level.px),
                sz = Number(level.sz);
            return Number.isFinite(sz) && sz > 0 && Math.abs(px / mid - 1) <= 0.0025 ? sum + px * sz : sum;
        }, 0);
    return {
        ...observed,
        bookAt: new Date(book.time).toISOString(),
        bid,
        ask,
        bidDepthWithin25bps: depth(bids),
        askDepthWithin25bps: depth(asks),
        moveSincePublicationBps: referenceClose ? (mid / referenceClose - 1) * 10_000 : null,
    };
}

// An observation for research, never an executable price promise. Compare to
// the last CLOSED minute before publication so the baseline contains no reaction.
export async function deskNewsMarketContext(
    instrument: DeskInstrument,
    event: { publishedAt: string | null; deadline: string | null },
) {
    const ts = event.publishedAt ? Date.parse(event.publishedAt) : NaN;
    const end = Math.floor(ts / 60_000) * 60_000 - 1;
    const [candles, book] = await Promise.all([
        Number.isFinite(ts)
            ? hyperliquidInfoPost<Candle[]>(
                  "hl:info:candleSnapshot",
                  hyperliquidInfoUrl(instrument.isTestnet),
                  {
                      type: "candleSnapshot",
                      req: { coin: instrument.coin, interval: "1m", startTime: end - 59_999, endTime: end },
                  },
                  { ttlMs: 60_000, maxRetries: 0 },
              ).catch(() => [])
            : [],
        getL2Book(instrument.coin, instrument.isTestnet),
    ]);
    const candle = candles.find((row) => row.s === instrument.coin && row.T <= ts && row.t === end - 59_999);
    return newsMarketObservation(instrument, candle, book, event.deadline, new Date());
}
