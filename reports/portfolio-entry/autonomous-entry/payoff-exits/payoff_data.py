"""Counterfactual bracket outcomes on the autonomous decision tape."""
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import sys

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from autonomous_data import BEGIN, NEWS_BEGIN, NEWS_TEST, VALIDATION, Dataset
from autonomous_replay import (CAPITAL, COST_RATE, LIMITS, MIN_NOTIONAL, PARTICIPATION,
                               FirstPassage, Market, minute)
from settings import FEE, MINUTE, MODES, START, SYMBOLS, TEST_START, WORK, file_hash, iso, load, ms, save_json

CACHE = WORK / "payoff-exits"
TEACH = ms("2026-03-01T00:00:00Z")
NEWS_TEACH = ms("2026-11-08T00:00:00Z")
MODES = tuple(MODES.items())
SIGNS = (1, -1)
PAIRS = 16
VOL_COLUMN = "volatility_pct_60m"
VOL_FLOOR = 1e-5
BRACKET_SEED = 738
WINDOWS = {
    "teacher": (BEGIN, TEACH),
    "development": (BEGIN, VALIDATION),
    "final": (BEGIN, TEST_START),
    "news-teacher": (NEWS_BEGIN, NEWS_TEACH),
    "news": (NEWS_BEGIN, NEWS_TEST),
}


def volatility(data, rows):
    col = data.manifest["columns"].index(VOL_COLUMN)
    return realized_volatility(data.market[rows, col])


def realized_volatility(five_minute_sigma_pct):
    # The archived feature is the standard deviation of five-minute percent returns.
    values = np.asarray(five_minute_sigma_pct, dtype="f8") * (np.sqrt(12) / 100)
    return np.maximum(np.nan_to_num(values, nan=0.), VOL_FLOOR).astype("f4")


def bracket_samples(n):
    """One continuous pair from each cell of a stratified log-distance grid."""
    rng = np.random.default_rng(BRACKET_SEED)
    cells = np.stack(np.unravel_index(np.arange(PAIRS), (4, 4)), axis=-1)
    unit = (cells + rng.random((n, len(SIGNS), PAIRS, 2), dtype="f4")) / 4
    return (np.log(.25) + unit * np.log(16. / .25)).astype("f4")


def stop_fraction(distance, sign):
    return np.where(sign == 1, -np.expm1(-distance), np.expm1(distance))


def initial_size(turnover, stop, sign):
    fraction = stop_fraction(stop, sign) + COST_RATE
    return np.minimum.reduce(np.broadcast_arrays(
        turnover * PARTICIPATION, LIMITS["maxRiskPerTradeUsd"] / fraction,
        LIMITS["maxOpenRiskUsd"] / fraction,
        LIMITS["maxOrderUsd"], LIMITS["maxInstrumentUsd"],
        CAPITAL * LIMITS["maxGrossLeverage"] / (1 + FEE),
    ))


def counterfactual(tape, flow, entries, reference, turnover, dist, sign, slip, absolute_begin, cutoff, up, down):
    """Vectorized equivalent of Market.execute with an independent order per row."""
    exit_cut = cutoff - absolute_begin
    tp_tree, sl_tree = (up, down) if sign == 1 else (down, up)
    result = np.zeros(dist.shape[:-1], dtype="f4")
    starts = entries - absolute_begin
    opens = tape[np.minimum(starts, exit_cut - 1), 0]
    paid = opens * (1 + sign * slip)
    size = initial_size(turnover[:, None], dist[..., 1], sign)
    executable = (starts < exit_cut) & np.isfinite(paid) & (paid > 0)
    executable &= sign * (paid / reference - 1) * 10000 <= LIMITS["maxSlippageBps"]
    row, bracket = np.nonzero(executable[:, None] & (size >= MIN_NOTIONAL))
    if not len(row):
        return result
    ent = starts[row]
    price = paid[row]
    targets = price * np.exp(sign * dist[row, bracket, 0])
    stops = price * np.exp(-sign * dist[row, bracket, 1])
    t_hit = tp_tree.hit(ent, sign * targets)
    s_hit = sl_tree.hit(ent, -sign * stops)
    earliest = np.minimum(t_hit, s_hit)
    closed = earliest < exit_cut
    gap = tape[np.minimum(earliest, exit_cut - 1), 0]
    stop_price = np.minimum(stops, gap) if sign == 1 else np.maximum(stops, gap)
    known = np.flatnonzero(np.isfinite(tape[:, 3]) & (tape[:, 3] > 0))
    assert len(known) and (ent[~closed] <= known[-1]).all()
    trigger = np.where(closed, np.where(s_hit <= t_hit, stop_price, targets), tape[known[-1], 3])
    sold = trigger * (1 - sign * slip)
    end = np.where(closed, earliest + 1, exit_cut) + absolute_begin
    funded = end - (end == cutoff)
    start_hour = entries[row] // 60 + 1
    end_hour = funded // 60 + 1
    funding = -sign * (flow[end_hour] - flow[start_hour]) / price
    result[row, bracket] = sign * (sold / price - 1) - FEE * (1 + sold / price) + funding
    return result


def label_worker(asset):
    ids = np.flatnonzero(ROWS["asset"] == asset)
    if not len(ids):
        return 0
    entries = (ROWS["at"][ids] - START) // MINUTE + 1
    asset_tape = MARKET.raw[asset, FIRST:CUTOFF]
    up, down = FirstPassage(asset_tape[:, 1]), FirstPassage(-asset_tape[:, 2])
    _, flow, _ = MARKET.asset(asset)
    for section in np.array_split(ids, max(1, (len(ids) + 2047) // 2048)):
        entry = (ROWS["at"][section] - START) // MINUTE + 1
        dist = VOL[section, None, None, None] * np.exp(BRACKETS[section])
        for side, sign in enumerate(SIGNS):
            for m, (_, (delay, slip)) in enumerate(MODES):
                LABELS[section, side, :, m] = counterfactual(
                    asset_tape, flow, entry + delay, ROWS["reference"][section], ROWS["turnover"][section],
                    dist[:, side], sign, slip, FIRST, CUTOFF, up, down,
                )
    return len(entries)


def paths(name):
    return CACHE / f"{name}-brackets.npy", CACHE / f"{name}-outcomes.npy", CACHE / f"{name}-labels.json"


def build(name):
    global MARKET, ROWS, BRACKETS, VOL, FIRST, CUTOFF, LABELS
    CACHE.mkdir(parents=True, exist_ok=True)
    brackets, outcomes, manifest = paths(name)
    sources = dict(data=file_hash(HERE.parent / "dataset.json"), labels=file_hash(__file__))
    if manifest.exists():
        existing = load(manifest)
        if existing["sources"] == sources:
            assert existing["brackets"] == file_hash(brackets) and existing["outcomes"] == file_hash(outcomes)
            return
        manifest.unlink()
    begin, cutoff = WINDOWS[name]
    data, MARKET = Dataset(), Market()
    span = data.span(begin, cutoff)
    ROWS, VOL = data.decisions[span], volatility(data, span)
    FIRST, CUTOFF = minute(begin), minute(cutoff)
    BRACKETS = bracket_samples(len(ROWS))
    np.save(brackets, BRACKETS)
    LABELS = np.lib.format.open_memmap(outcomes, mode="w+", dtype="f4",
                                       shape=(len(ROWS), len(SIGNS), PAIRS, len(MODES)))
    with ProcessPoolExecutor(max_workers=5) as workers:
        count = 0
        for asset, n in enumerate(workers.map(label_worker, range(len(SYMBOLS)))):
            count += n
            if (asset + 1) % 50 == 0:
                print(f"{name} labels: {asset + 1}/{len(SYMBOLS)} assets", flush=True)
    LABELS.flush()
    assert count == len(ROWS) and np.isfinite(LABELS).all()
    save_json(manifest, dict(begin=iso(begin), cutoff=iso(cutoff), rows=count, pairs=PAIRS, sources=sources,
                             brackets=file_hash(brackets), outcomes=file_hash(outcomes)))
    print(f"{name}: {count:,} decision rows with 16 brackets per side", flush=True)


if __name__ == "__main__":
    for window in sys.argv[1:] or WINDOWS:
        build(window)
