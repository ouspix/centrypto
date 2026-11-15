type Candle = { t: number; T: number; c: string; h: string; l: string };
export type DecisionLevel = { label: string; price: number };

/** Same observations, different clocks. No confirmation rule or trading verdict. */
export function reconcilePriceEvidence(rows: Candle[], sampledAt: number,
    quote: { bid: number; ask: number; time: number }, levels: DecisionLevel[] = [], now = Date.now()) {
    if (levels.length > 6 || levels.some(l => !l.label?.trim() || !Number.isFinite(l.price) || l.price <= 0))
        throw new Error("Supply at most six named positive decision levels.");
    const ordered = [...rows].sort((a, b) => a.t - b.t);
    const completed = ordered.filter(c => c.T < sampledAt);
    const closed = completed.at(-1);
    const forming = ordered.filter(c => c.t <= sampledAt && c.T >= sampledAt).at(-1);
    const valid = Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && quote.bid > 0 && quote.ask >= quote.bid &&
        Number.isFinite(quote.time) && quote.time <= now + 1000 && now - quote.time <= 5000;
    const relation = (lo: number, hi: number, level: number) => lo > level ? "above" : hi < level ? "below" : "touching_or_straddling";
    return {
        observedAt: new Date(now).toISOString(), candleSnapshotAt: new Date(sampledAt).toISOString(),
        lastCompleted: closed ? { openedAt: new Date(closed.t).toISOString(), closedAt: new Date(closed.T).toISOString(), close: +closed.c, low: +closed.l, high: +closed.h } : null,
        forming: forming ? { openedAt: new Date(forming.t).toISOString(), observedAt: new Date(sampledAt).toISOString(), close: +forming.c, low: +forming.l, high: +forming.h, final: false } : null,
        recentCompletedRelations: completed.slice(-3).map(c => ({ closedAt: new Date(c.T).toISOString(), close: +c.c,
            liveSide: valid ? relation(quote.bid, quote.ask, +c.c) : null,
            bidVsCloseBps: valid && +c.c > 0 ? (quote.bid / +c.c - 1) * 10000 : null })),
        live: { status: valid ? "fresh" : "unavailable", at: Number.isFinite(quote.time) ? new Date(quote.time).toISOString() : null, bid: valid ? quote.bid : null, ask: valid ? quote.ask : null,
            bidVsCompletedBps: valid && closed && +closed.c > 0 ? (quote.bid / +closed.c - 1) * 10000 : null,
            askVsCompletedBps: valid && closed && +closed.c > 0 ? (quote.ask / +closed.c - 1) * 10000 : null },
        levels: levels.map(l => {
            const completedSide = closed ? relation(+closed.c, +closed.c, l.price) : null;
            const liveSide = valid ? relation(quote.bid, quote.ask, l.price) : null;
            return { ...l, completedSide, liveSide, oppositeSides: !!completedSide && !!liveSide &&
                ((completedSide === "above" && liveSide === "below") || (completedSide === "below" && liveSide === "above")) };
        }),
        instruction: "Completed candles establish past retention; live bid/ask establish current executable location. Weigh both on the thesis horizon. A forming candle is provisional, not nonexistent. Explain disagreement and what would change the choice; neither signal automatically wins. Fresh quotes and existing execution checks are still required for any order.",
    };
}
