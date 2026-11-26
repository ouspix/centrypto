"""Measure pairwise Pearson correlations for the proposed 96 training inputs."""

import csv
from datetime import datetime, time, timezone
import re
from urllib.request import urlopen
from zoneinfo import ZoneInfo

import numpy as np

import train_positive_edge as model


OUTPUT = model.OUT / "training-correlations"
FRED = "https://fred.stlouisfed.org/data/NASDAQ100"
NA = np.nan

ASSET = [
    *(f"perp_return_pct_{n}m" for n in (5, 15, 60, 240, 1440)),
    *(f"volatility_pct_{n}m" for n in (15, 60, 240, 1440)),
    "vol_ratio_15m", "perp_volume_ratio_60m", "vol_ratio_240m", "vol_ratio_1440m",
    *(f"level_vs_sma_{n}" for n in (3, 8, 12, 30)),
    "sma_gap_3_12", "sma_gap_8_30", "bar_close_location", "log_quote_volume",
]
TECHNICAL = ["rsi_9", "bb_12_width", "bb_12_pct_b", "clock_sin", "clock_cos"]
BENCHMARKS = [
    *(f"{coin}_return_{n}m" for coin in ("btc", "eth") for n in (60, 240, 1440)),
    "relative_btc_return_60m", "relative_eth_return_60m",
    *(f"{name}_{h}h" for name in ("btc_log_return", "asset_minus_btc_log_return") for h in model.HOURS),
]
HISTORY = [
    f"asset_{name}_{h}h" for h in model.HOURS
    for name in ("log_return", "log_high_vs_reference", "log_low_vs_reference",
                 "valid_candle_fraction", "mean_hourly_return_sign", "rms_hourly_return")
]
FUNDING = ["funding_lag_1h_bps", "funding_mean_8h_bps"]
NDX = [
    *(f"ndx_return_{n}" for n in ("5m", "15m", "1h", "4h")),
    "ndx_return_since_previous_close", "ndx_previous_session_return",
    "ndx_volatility_1h", "ndx_market_open", "ndx_minutes_since_bar",
]
NEWS = [f"news_{scope}_{direction}_{age}" for scope in ("asset", "market")
        for direction in ("bullish", "bearish") for age in ("5m", "30m", "2h", "8h")]
VENUE = ["bid_ask_spread", "bid_depth", "ask_depth", "book_imbalance",
         "open_interest", "open_interest_change_5m", "open_interest_change_1h",
         "liquidated_long_usd_5m", "liquidated_short_usd_5m", "spot_perp_basis"]
NAMES = [*ASSET, *TECHNICAL, *BENCHMARKS, *HISTORY, *FUNDING, *NDX, *NEWS, *VENUE, "execution_scenario"]


def ndx_daily_inputs(stamps):
    with urlopen(FRED, timeout=30) as response:
        html = response.read().decode()
    observations = dict(re.findall(r"(\d{4}-\d{2}-\d{2})\|([0-9]+(?:\.[0-9]+)?)", html))
    days = np.array(sorted(observations))
    levels = np.array([float(observations[day]) for day in days])
    changes = np.r_[NA, levels[1:] / levels[:-1] - 1]
    eastern = ZoneInfo("America/New_York")
    early_closes = {"2025-11-28", "2025-12-24"}
    unique_stamps, inverse = np.unique(stamps, return_inverse=True)
    local = [datetime.fromtimestamp(int(stamp) / 1000, timezone.utc).astimezone(eastern)
             for stamp in unique_stamps]
    dates = [stamp.date().isoformat() for stamp in local]
    assert days[1] < min(dates) and days[-1] > max(dates)
    prior = days.searchsorted(dates, side="left") - 1
    cash_hours = np.array([
        day in observations and time(9, 30) <= stamp.time() < time(13 if day in early_closes else 16)
        for stamp, day in zip(local, dates, strict=True)
    ])
    return changes[prior][inverse], cash_hours[inverse].astype(float)


def features(rows, frozen):
    # Columns in the frozen design precede the scenario indicator. Publication flags
    # are outside the proposed direction-specific news schema.
    original = [*model.prior.BASE_COLUMNS, *FUNDING, *HISTORY, *BENCHMARKS[-6:]]
    archive = dict(zip(original, frozen.T, strict=True))
    prior_session, is_open = ndx_daily_inputs(rows["at"])
    archive.update(ndx_previous_session_return=prior_session, ndx_market_open=is_open)
    array = np.full((len(rows), len(NAMES)), NA, dtype="f8")
    sources = {}
    for index, name in enumerate(NAMES):
        if name in archive:
            array[:, index] = archive[name]
            sources[name] = "FRED and Nasdaq calendar" if name in NDX else "frozen training design"
        elif name in NDX:
            sources[name] = "missing historical NDX intraday bars"
        elif name in NEWS:
            sources[name] = "missing point-in-time directional news archive during training"
        elif name in VENUE:
            sources[name] = "no matched historical venue series found for the training tape"
        else:
            sources[name] = "balanced base and stress coding"
    return array, sources


def pairwise(left, right):
    """Use each pair's joint sample for both means and variances."""
    left_ok, right_ok = np.isfinite(left), np.isfinite(right)
    left = np.where(left_ok, left, 0.)
    right = np.where(right_ok, right, 0.)
    a, b = left_ok.astype(float), right_ok.astype(float)
    count = a.T @ b
    left_sum, right_sum = left.T @ b, a.T @ right
    with np.errstate(divide="ignore", invalid="ignore"):
        cross = left.T @ right - left_sum * right_sum / count
        left_squares, right_squares = (left ** 2).T @ b, a.T @ (right ** 2)
        left_var = left_squares - left_sum ** 2 / count
        right_var = right_squares - right_sum ** 2 / count
        epsilon = 16 * np.finfo(float).eps
        has_variance = ((count > 1) & (left_var > epsilon * left_squares)
                        & (right_var > epsilon * right_squares))
        result = np.where(has_variance, cross / np.sqrt(left_var * right_var), NA)
    return np.clip(result, -1., 1.), count.astype("i8")


def label_matrix(market, rows):
    labels, flags = model.prior.training_labels(market, rows, [model.PAIR])
    names, values = [], []
    for side, direction in enumerate(("long", "short")):
        for scenario, (mode, _) in enumerate(model.MODES):
            net = labels[0, :, side, scenario]
            adjusted = model.prior.conservative_net(net, 1., model.PAIR, flags[0, :, side, scenario])
            win = np.where(np.isfinite(adjusted), (adjusted > 0).astype(float), NA)
            prefix = f"{direction}_{mode}"
            names.extend(f"{prefix}_{name}" for name in model.TARGETS)
            values.extend((net, adjusted, win))
    assert np.isfinite(labels).sum(axis=(0, 1, 3)).tolist() == [341592, 341307]
    return names, np.column_stack(values)


def save_csv(name, header, rows):
    with (OUTPUT / name).open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def number(value):
    return round(value, 8) if np.isfinite(value) else ""


def main():
    data, market = model.prior.Dataset(), model.prior.Market()
    rows, frozen = model.inputs(data, market, model.BEGIN, model.TEACH)
    assert len(rows) == 184866 and len(NAMES) == len(set(NAMES)) == 96
    values, sources = features(rows, frozen)
    populated = np.isfinite(values).any(axis=0)
    corr, count = pairwise(values, values)
    np.testing.assert_allclose(corr, corr.T, atol=1e-7, rtol=0, equal_nan=True)
    np.testing.assert_array_equal(count, count.T)
    # Every decision is evaluated once per scenario using the same market vector.
    # Report support as distinct market decisions instead of counting each twice.
    scenario = NAMES.index("execution_scenario")
    variable = np.isfinite(corr.diagonal())
    corr[scenario, variable] = corr[variable, scenario] = 0.
    corr[scenario, scenario] = 1.
    count[scenario, :] = count[:, scenario] = count.diagonal().copy()
    count[scenario, scenario] = len(rows)
    populated[scenario] = True

    targets, labels = label_matrix(market, rows)
    target_corr, target_count = pairwise(values, labels)
    assert np.isnan(target_corr[scenario]).all()
    for first, second in (("perp_return_pct_5m", "perp_return_pct_15m"),
                          ("asset_log_return_168h", "log_quote_volume"),
                          ("ndx_previous_session_return", "btc_return_1440m")):
        row, col = NAMES.index(first), NAMES.index(second)
        observed = np.isfinite(values[:, row]) & np.isfinite(values[:, col])
        check = np.corrcoef(values[observed, row], values[observed, col])[0, 1]
        np.testing.assert_allclose(corr[row, col], check, atol=1e-8)

    OUTPUT.mkdir(exist_ok=True)
    save_csv("pearson-96.csv", ["input", *NAMES],
             ([name, *(number(v) for v in row)] for name, row in zip(NAMES, corr, strict=True)))
    save_csv("paired-row-counts-96.csv", ["input", *NAMES],
             ([name, *row] for name, row in zip(NAMES, count, strict=True)))
    save_csv("column-coverage.csv", ["input", "observed_rows", "total_rows", "source_or_gap"],
             ((name, n, len(rows), sources[name]) for name, n in zip(NAMES, count.diagonal(), strict=True)))
    save_csv("feature-target-pearson.csv", ["input", "target", "pearson", "paired_rows"],
             ((name, target, number(target_corr[i, j]), target_count[i, j])
              for i, name in enumerate(NAMES) for j, target in enumerate(targets)))
    print(f"Wrote {len(NAMES)} columns, {int(populated.sum())} populated, over {len(rows):,} training rows.")
    print(f"Finite unique pairs: {np.isfinite(corr[np.triu_indices(len(NAMES), 1)]).sum():,}")


if __name__ == "__main__":
    main()
