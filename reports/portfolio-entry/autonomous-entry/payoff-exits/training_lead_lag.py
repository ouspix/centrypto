"""Measure lead and lag correlations of Nasdaq-100, BTC and ETH training-period returns."""

import csv
from datetime import datetime, time
from itertools import combinations
import re
from urllib.request import urlopen
from zoneinfo import ZoneInfo

import numpy as np

import train_positive_edge as model
from training_correlations import FRED, OUTPUT


def daily_closes():
    with urlopen(FRED, timeout=20) as source:
        closes = dict(re.findall(r"(\d{4}-\d{2}-\d{2})\|([0-9]+(?:\.[0-9]+)?)", source.read().decode()))
    eastern = ZoneInfo("America/New_York")
    early = {"2025-11-28", "2025-12-24"}
    close_times, prices = [], []
    for session, price in sorted(closes.items()):
        day = datetime.fromisoformat(session).date()
        close = datetime.combine(day, time(13 if session in early else 16), eastern)
        stamp = round(close.timestamp() * 1000)
        if model.BEGIN <= stamp < model.TEACH:
            close_times.append(model.minute(stamp))
            prices.append(float(price))
    return np.array(close_times), np.array(prices)


def crypto_closes(market, symbol, ends):
    # An archive minute is timestamped at its start. This is the last completed close.
    return market.raw[model.SYMBOLS.index(symbol), ends - 1, 3]


def corr_rows(left, right):
    left = left - left.mean(axis=-1, keepdims=True)
    right = right - right.mean(axis=-1, keepdims=True)
    return (left * right).sum(axis=-1) / np.sqrt((left ** 2).sum(axis=-1) * (right ** 2).sum(axis=-1))


def block_indices(n):
    rng = np.random.default_rng(401)
    block = 5
    starts = rng.integers(0, n, size=(10000, (n + block - 1) // block))
    return ((starts[:, :, None] + np.arange(block)) % n).reshape(len(starts), -1)[:, :n]


def score(series, left_name, right_name, lag, left, right, *, bootstrap=False):
    joint = np.isfinite(left) & np.isfinite(right)
    x, y = left[joint], right[joint]
    lo, hi = "", ""
    if bootstrap:
        blocks = block_indices(len(x))
        lo, hi = np.percentile(corr_rows(x[blocks], y[blocks]), [2.5, 97.5])
    return dict(series=series, left=left_name, right=right_name, lag=lag, pearson=float(corr_rows(x, y)),
                paired_observations=len(x), bootstrap_low=lo, bootstrap_high=hi)


def lagged(series, left_name, right_name, x, y, radius, *, bootstrap=False):
    anchors = np.arange(radius, len(x) - radius)
    return [score(series, left_name, right_name, lag, x[anchors], y[anchors + lag], bootstrap=bootstrap)
            for lag in range(-radius, radius + 1)]


def main():
    market = model.prior.Market()
    ends, ndx = daily_closes()
    assert len(ends) and np.all(np.diff(ends) > 0)
    symbols = ("BTC", "ETH")
    levels = {"NDX": ndx, **{coin: crypto_closes(market, coin, ends) for coin in symbols}}
    daily = {name: np.diff(np.log(prices)) for name, prices in levels.items()}
    records = []
    for left, right in combinations(levels, 2):
        records.extend(lagged("cash_close_to_close_session", left, right, daily[left], daily[right], 2, bootstrap=True))
    for coin in symbols:
        for horizon in (60, 240):
            start, end = ends[1:] + 5, ends[1:] + 5 + horizon
            future = np.log(crypto_closes(market, coin, end) / crypto_closes(market, coin, start))
            records.append(score("after_cash_close_start_plus_5_minutes", "NDX", coin, horizon,
                                 daily["NDX"], future, bootstrap=True))

    points = np.arange(model.minute(model.BEGIN) + 5, model.minute(model.TEACH) + 1, 5)
    btc, eth = (np.diff(np.log(crypto_closes(market, coin, points))) for coin in symbols)
    records.extend(lagged("five_minute", "BTC", "ETH", btc, eth, 3))

    # A positive lag means the left series leads the right by the stated interval.
    # Compare both one-session lead directions over identical NDX anchor days.
    for coin in symbols:
        x, early, late = daily["NDX"][1:-1], daily[coin][:-2], daily[coin][2:]
        joint = np.isfinite(x) & np.isfinite(early) & np.isfinite(late)
        x, early, late = x[joint], early[joint], late[joint]
        samples = block_indices(len(x))
        diff = corr_rows(x[samples], late[samples]) - corr_rows(x[samples], early[samples])
        lo, hi = np.percentile(diff, [2.5, 97.5])
        records.append(dict(series="ndx_lead_minus_crypto_lead_one_session", left="NDX", right=coin, lag=1,
                            pearson=float(corr_rows(x, late) - corr_rows(x, early)), paired_observations=len(x),
                            bootstrap_low=lo, bootstrap_high=hi))

    OUTPUT.mkdir(exist_ok=True)
    with (OUTPUT / "lead-lag.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(records[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(records)
    print(f"{len(ends)} Nasdaq cash closes, {len(points):,} five-minute crypto endpoints")
    for r in records:
        print(r["series"], r["left"], r["right"], r["lag"],
              round(r["pearson"], 4), r["paired_observations"],
              tuple(round(v, 4) for v in (r["bootstrap_low"], r["bootstrap_high"]) if v != ""))


if __name__ == "__main__":
    main()
