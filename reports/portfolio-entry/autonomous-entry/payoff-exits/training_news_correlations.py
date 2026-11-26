"""Relate archived news flags to subsequent returns separately for each training asset."""

import csv

import numpy as np

import train_positive_edge as model
from autonomous_data import FLAGS, STORIES
from settings import DAY, HOUR
from training_correlations import NEWS, OUTPUT


HORIZONS = (5, 15, 60, 240)


def forward_returns(tape, missing, entries, horizon):
    """Use the next minute's open and the final close of a complete price path."""
    result = np.full(len(entries), np.nan)
    eligible = np.flatnonzero(entries + horizon <= len(tape))
    start = entries[eligible]
    stop = start + horizon
    complete = missing[stop] == missing[start]
    start, stop = start[complete], stop[complete]
    result[eligible[complete]] = 10000 * np.log(tape[stop - 1, 3] / tape[start, 0])
    return result


def compare(returns, flags, days):
    usable = np.isfinite(returns)
    returns, flags, days = returns[usable], flags[usable], days[usable]
    n1 = int(flags.sum())
    n0 = len(flags) - n1
    avg1 = float(returns[flags].mean()) if n1 else None
    avg0 = float(returns[~flags].mean()) if n0 else None
    correlation, difference = None, None
    if n1 and n0:
        difference = avg1 - avg0
        spread = returns.std()
        if spread:
            correlation = difference / spread * np.sqrt(n1 * n0) / len(flags)
            np.testing.assert_allclose(correlation, np.corrcoef(flags, returns)[0, 1], atol=1e-10)
    return dict(paired_rows=len(flags), news_1_rows=n1, news_0_rows=n0,
                news_1_utc_days=len(np.unique(days[flags])), pearson=correlation,
                mean_news_1_bps=avg1, mean_news_0_bps=avg0, difference_bps=difference,
                status="measured" if correlation is not None else "insufficient variation")


def main():
    data, market = model.prior.Dataset(), model.prior.Market()
    span = data.span(model.BEGIN, model.TEACH)
    rows = data.decisions[span]
    flags = data.market[span][:, [data.manifest["columns"].index(name) for name in FLAGS]]
    assert np.isin(flags, (0, 1)).all()
    flags = flags.astype(bool)
    batches = np.load(STORIES.with_name("batches.npy"))
    batch = np.searchsorted(batches, rows["at"], side="right") - 1
    # Match the historical news pipeline's one-hour archive-liveness definition.
    covered = (batch >= 0) & (rows["at"] - batches[np.maximum(0, batch)] <= HOUR)
    origin, cutoff = model.minute(model.BEGIN), model.minute(model.TEACH)
    records = []
    for asset in np.unique(rows["asset"]):
        ids = np.flatnonzero(rows["asset"] == asset)
        known = ids[covered[ids]]
        stamp = rows["at"][known]
        entries = model.minute(stamp) + 1 - origin
        tape = market.raw[asset, origin:cutoff]
        valid = (np.isfinite(tape[:, :4]) & (tape[:, :4] > 0)).all(axis=1)
        missing = np.r_[0, (~valid).cumsum()]
        symbol = model.SYMBOLS[asset]
        for horizon in HORIZONS:
            future = forward_returns(tape, missing, entries, horizon)
            for index, flag in enumerate(FLAGS):
                stats = compare(future, flags[known, index], stamp // DAY)
                records.append(dict(asset=symbol, news_column=flag, forward_minutes=horizon,
                                    training_rows=len(ids), **stats))
            for flag in NEWS:
                records.append(dict(asset=symbol, news_column=flag, forward_minutes=horizon,
                                    training_rows=len(ids), paired_rows=0,
                                    status="directional news archive unavailable in training"))
    OUTPUT.mkdir(exist_ok=True)
    path = OUTPUT / "per-asset-news-correlations.csv"
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(records[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(records)
    print(f"{len(rows):,} asset decisions, {covered.sum():,} with a recent archive batch")
    print(f"{sum(row['status'] == 'measured' for row in records)} measured pairs in {path}")


if __name__ == "__main__":
    main()
