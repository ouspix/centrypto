"""Measure whether newly visible news precedes sustained future price trends."""

import csv
import gzip

import numpy as np

from training_news_trends import MIN_R_SQUARED, OUTPUT, TREND_NAMES, model, news_flags, write_csv
from settings import BAR, DAY, iso


HORIZONS = (5, 10, 15, 30, 60, 240)
MIN_SIGN_AGREEMENT = .60
MIN_VOLATILITY_UNITS = .75


def sustained_trend(tape, missing, starts, horizon, volatility):
    """Score a complete path on fitted slope, direction across bars and move size."""
    labels = np.full(len(starts), np.nan)
    ends = starts + horizon
    eligible = np.flatnonzero((starts >= 0) & (ends <= len(tape))
                              & np.isfinite(volatility) & (volatility > 0))
    eligible = eligible[missing[starts[eligible]] == missing[ends[eligible]]]
    loc = starts[eligible]
    sample_minutes = 1 if horizon < 30 else 5
    closes = tape[loc[:, None] + np.arange(sample_minutes - 1, horizon, sample_minutes), 3]
    prices = np.column_stack((tape[loc, 0], closes))
    path = np.log(prices / prices[:, :1])
    steps = horizon // sample_minutes
    time = np.arange(steps + 1) - steps / 2
    projection = path @ time
    direction = np.sign(projection)
    variation = np.square(path - path.mean(axis=1, keepdims=True)).sum(axis=1)
    time_energy = time @ time
    agreement = (np.sign(np.diff(path, axis=1)) == direction[:, None]).mean(axis=1)
    fitted_move = np.abs(projection) / time_energy * steps
    # The historical volatility input is in five-minute return units at every horizon.
    horizon_volatility = volatility[eligible] * np.sqrt(horizon / 5)
    sustained = ((np.square(projection) >= MIN_R_SQUARED * time_energy * variation)
                 & (agreement >= MIN_SIGN_AGREEMENT)
                 & (fitted_move >= MIN_VOLATILITY_UNITS * horizon_volatility))
    labels[eligible] = np.where(sustained, direction, 0.)
    return labels


def news_onsets(stamps, flags, covered):
    """A fresh flag requires a recorded zero at the immediately preceding decision."""
    return np.r_[False, (np.diff(stamps) == BAR) & covered[:-1] & covered[1:] & ~flags[:-1] & flags[1:]]


def nonoverlapping(indices, minutes, horizon):
    accepted = []
    next_minute = -1
    for index in indices:
        if minutes[index] >= next_minute:
            accepted.append(index)
            next_minute = minutes[index] + horizon
    return np.array(accepted, dtype=int)


def day_resamples(days):
    rng = np.random.default_rng(523)
    block = 3
    starts = rng.integers(0, days, size=(1000, (days + block - 1) // block))
    selected = ((starts[:, :, None] + np.arange(block)) % days).reshape(len(starts), -1)[:, :days]
    weights = np.zeros((len(selected), days))
    np.add.at(weights, (np.arange(len(selected))[:, None], selected), 1)
    return weights


def pearson(moments):
    cross, news_var, trend_var = moments.T
    scale = np.sqrt(np.maximum(0, news_var * trend_var))
    return np.divide(cross, scale, out=np.full_like(scale, np.nan), where=scale > 0)


def trend_association(minutes, days, prior, future, flags, onsets, covered, horizon, resamples):
    """Compare first-onset rows with no-flag rows on the same UTC date and prior trend."""
    valid = covered & np.isfinite(prior) & np.isfinite(future)
    controls = np.flatnonzero(valid & ~flags)
    starts = np.flatnonzero(valid & onsets)
    stats = dict(priced_onsets=len(starts), matched_onsets=0, matched_control_rows=0,
                 onset_dates=0, adjusted_pearson=None, block_95_low=None, block_95_high=None,
                 uptrend_change_pp=None, downtrend_change_pp=None, flat_prior_onsets=0,
                 flat_prior_uptrend_change_pp=None, flat_prior_downtrend_change_pp=None)
    if not len(starts) or not len(controls):
        return stats

    known = np.flatnonzero(valid)
    groups = np.zeros(len(prior), dtype=int)
    groups[known] = days[known] * 3 + prior[known].astype(int) + 1
    size = resamples.shape[1] * 3
    n0 = np.bincount(groups[controls], minlength=size)
    starts = nonoverlapping(starts[n0[groups[starts]] > 0], minutes, horizon)
    n1 = np.bincount(groups[starts], minlength=size)
    active = n1 > 0
    if not active.any():
        return stats

    controls = controls[active[groups[controls]]]
    # Count down, flat and up outcomes within each matched stratum.
    counts = []
    for subset in (controls, starts):
        cells = groups[subset] * 3 + future[subset].astype(int) + 1
        counts.append(np.bincount(cells, minlength=size*3).reshape(size, 3)[active])
    c0, c1 = counts
    a, b = n0[active], n1[active]
    n = a + b
    trend_sum = (c0 + c1) @ np.array([-1, 0, 1])
    trend_squared_sum = (c0 + c1) @ np.array([1, 0, 1])
    exposed_trend_sum = c1 @ np.array([-1, 0, 1])
    moments = np.column_stack((exposed_trend_sum - b * trend_sum / n, a * b / n,
                               trend_squared_sum - trend_sum ** 2 / n))
    result = float(pearson(moments.sum(axis=0)))
    delta = c1 / b[:, None] - c0 / a[:, None]
    group_ids = np.flatnonzero(active)
    date_count = len(np.unique(group_ids // 3))
    stats.update(matched_onsets=len(starts), matched_control_rows=len(controls), onset_dates=date_count,
                 adjusted_pearson=result if np.isfinite(result) else None)

    for prefix, included in (("", np.ones(len(b), dtype=bool)), ("flat_prior_", group_ids % 3 == 1)):
        exposure = int(b[included].sum())
        if prefix:
            stats["flat_prior_onsets"] = exposure
        if exposure:
            lift = 100 * np.average(delta[included], weights=b[included], axis=0)
            stats[f"{prefix}downtrend_change_pp"] = float(lift[0])
            stats[f"{prefix}uptrend_change_pp"] = float(lift[2])

    if len(starts) >= 20 and date_count >= 10 and np.isfinite(result):
        daily = np.zeros((resamples.shape[1], 3))
        np.add.at(daily, group_ids // 3, moments)
        draws = pearson(resamples @ daily)
        low, high = np.nanquantile(draws, [.025, .975])
        stats.update(block_95_low=float(low), block_95_high=float(high))
    return stats


def write_labels(rows, labels):
    with gzip.open(OUTPUT / "sustained-trend-labels.csv.gz", "wt", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(["decision_utc", "asset", *labels])
        for row, values in zip(rows, zip(*labels.values(), strict=True), strict=True):
            writer.writerow([iso(int(row["at"])), model.SYMBOLS[row["asset"]],
                             *("" if not np.isfinite(v) else TREND_NAMES[int(v)+1] for v in values)])


def main():
    data, market = model.prior.Dataset(), model.prior.Market()
    span = data.span(model.BEGIN, model.TEACH)
    rows = data.decisions[span]
    news, covered, _ = news_flags(rows)
    vol_col = data.manifest["columns"].index("volatility_pct_240m")
    volatility = data.market[span, vol_col].astype(float) / 100
    origin, cutoff = model.minute(model.BEGIN), model.minute(model.TEACH)
    days = rows["at"] // DAY - model.BEGIN // DAY
    resamples = day_resamples(int(days.max()) + 1)
    labels = {f"sustained_{side}_trend_{h}m": np.full(len(rows), np.nan)
              for h in HORIZONS for side in ("prior", "future")}
    records = []
    for asset in np.unique(rows["asset"]):
        ids = np.flatnonzero(rows["asset"] == asset)
        stamps = rows["at"][ids]
        minutes = model.minute(stamps) - origin
        tape = market.raw[asset, origin:cutoff]
        valid = (np.isfinite(tape[:, :4]) & (tape[:, :4] > 0)).all(axis=1)
        missing = np.r_[0, (~valid).cumsum()]
        visible = covered[ids]
        topics = {name: flags[ids] for name, flags in news.items()}
        onsets = {name: news_onsets(stamps, flags, visible) for name, flags in topics.items()}
        for h in HORIZONS:
            prior = sustained_trend(tape, missing, minutes - h, h, volatility[ids])
            future = sustained_trend(tape, missing, minutes + 1, h, volatility[ids])
            labels[f"sustained_prior_trend_{h}m"][ids] = prior
            labels[f"sustained_future_trend_{h}m"][ids] = future
            for topic, flags in topics.items():
                stats = trend_association(minutes, days[ids], prior, future, flags, onsets[topic],
                                          visible, h, resamples)
                records.append(dict(asset=model.SYMBOLS[asset], news_column=topic, future_minutes=h, **stats))
    OUTPUT.mkdir(exist_ok=True)
    write_labels(rows, labels)
    write_csv(OUTPUT / "per-asset-news-future-trend-correlations.csv", list(records[0]),
              (r.values() for r in records))
    print(f"Built {len(labels)} price-trend columns for {len(rows):,} decision rows")
    print(f"Measured {sum(r['adjusted_pearson'] is not None for r in records):,} of {len(records):,} combinations")


if __name__ == "__main__":
    main()
