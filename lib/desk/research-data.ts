export type ResearchCandle = {
    openTime: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};
const minute = 60_000;

/** Keep closed, valid, deduplicated observations; gaps are never filled with invented prices. */
export function candleCoverage(rows: ResearchCandle[], now = Date.now()) {
    const end = Math.floor(now / minute) * minute;
    const byTime = new Map<number, ResearchCandle>();
    for (const r of rows) {
        const at = +r.openTime;
        if (
            !Number.isFinite(at) ||
            at >= end ||
            at % minute ||
            ![r.open, r.high, r.low, r.close, r.volume].every(
                Number.isFinite,
            ) ||
            r.low <= 0 ||
            r.volume < 0 ||
            r.high < Math.max(r.open, r.close) ||
            r.low > Math.min(r.open, r.close)
        )
            continue;
        byTime.set(at, r);
    }
    const candles = [...byTime.values()].sort(
        (a, b) => +a.openTime - +b.openTime,
    );
    let contiguous = candles.length ? 1 : 0;
    for (
        let i = candles.length - 1;
        i > 0 && +candles[i].openTime - +candles[i - 1].openTime === minute;
        i--
    )
        contiguous++;
    const last = candles.at(-1);
    const ageSeconds = last
        ? Math.max(0, (now - (+last.openTime + minute)) / 1000)
        : null;
    return {
        candles,
        contiguous,
        count: candles.length,
        ageSeconds,
        fresh: ageSeconds !== null && ageSeconds <= 180,
        tradedCandles: candles.filter((c) => c.volume > 0).length,
        contiguousTradedCandles: candles
            .slice(-contiguous)
            .filter((c) => c.volume > 0).length,
        latestClosedAt: last
            ? new Date(+last.openTime + minute).toISOString()
            : null,
        missingMinutes: candles.length
            ? Math.max(
                  0,
                  (+last!.openTime - +candles[0].openTime) / minute +
                      1 -
                      candles.length,
              )
            : 0,
    };
}

/** Non-overlapping historical samples. These are descriptive sensitivities, not fair values or calibrated forecasts. */
export function historicalMoveStudy(
    rows: ResearchCandle[],
    horizonMinutes: number,
    lookbackMinutes: number,
    direction: "any" | "up" | "down",
    minimumMoveBps: number,
    now = Date.now(),
) {
    const c = candleCoverage(rows, now);
    const byTime = new Map(c.candles.map((r) => [+r.openTime, r]));
    const outcomes: number[] = [];
    let nextEligible = -Infinity;
    for (const row of c.candles) {
        const at = +row.openTime,
            before = byTime.get(at - lookbackMinutes * minute),
            after = byTime.get(at + horizonMinutes * minute);
        if (at < nextEligible || !before || !after || row.volume <= 0) continue;
        let complete = true;
        for (
            let t = at - lookbackMinutes * minute;
            t <= at + horizonMinutes * minute;
            t += minute
        )
            if (!byTime.has(t)) {
                complete = false;
                break;
            }
        if (!complete) continue;
        const move = (row.close / before.close - 1) * 10000;
        if (
            Math.abs(move) < minimumMoveBps ||
            (direction === "up" && move <= 0) ||
            (direction === "down" && move >= 0)
        )
            continue;
        outcomes.push((after.close / row.close - 1) * 10000);
        nextEligible = at + horizonMinutes * minute;
    }
    outcomes.sort((a, b) => a - b);
    const quantile = (q: number) => {
        const p = (outcomes.length - 1) * q,
            lo = Math.floor(p);
        return (
            outcomes[lo] + (outcomes[Math.ceil(p)] - outcomes[lo]) * (p - lo)
        );
    };
    return {
        observedAt: new Date(now).toISOString(),
        latestClosedAt: c.latestClosedAt,
        coverage: {
            count: c.count,
            missingMinutes: c.missingMinutes,
            tradedCandles: c.tradedCandles,
        },
        horizonMinutes,
        condition: { lookbackMinutes, direction, minimumMoveBps },
        samples: outcomes.length,
        status:
            outcomes.length >= 20
                ? "descriptive_sample"
                : "insufficient_sample",
        forwardReturnBps:
            outcomes.length >= 20
                ? {
                      p10: quantile(0.1),
                      median: quantile(0.5),
                      p90: quantile(0.9),
                      min: outcomes[0],
                      max: outcomes.at(-1),
                  }
                : null,
        limitations: [
            "Historical, non-overlapping samples; regime and selection bias remain.",
            "No probabilities, fair value or expected profit inferred.",
            "Returns exclude spread, fees, funding, borrow and execution constraints.",
        ],
    };
}
