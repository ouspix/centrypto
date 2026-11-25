"""Audit trade outcomes directly against source candles and funding."""
from collections import defaultdict
import gzip
import json
import math

import numpy as np
from scipy.special import log_softmax

from autonomous_data import (BASE_COLUMNS, HERE, MARK_STOP, MINUTE, NEWS_MARK,
                             NEWS_TEST, WORK, Dataset)
from autonomous_network import EXIT_NOISE, forward, gradient, initialize
from autonomous_replay import CUTOFF, Market, Passage, minute
from desk_replay import CAPITAL, COST_RATE, LIMITS, MIN_NOTIONAL
from settings import FEE, MODES, TEST_START, file_hash, iso, load, save_json


def first_hit(samples):
    found = np.flatnonzero(samples)
    return int(found[0]) if len(found) else len(samples)


def assert_passage():
    rng = np.random.default_rng(101)
    prices = rng.normal(size=1887)
    prices[31:80] = np.nan
    index = Passage(prices)
    for _ in range(4000):
        start = int(rng.integers(len(prices)))
        stop = int(rng.integers(start + 1, len(prices) + 1))
        threshold = rng.normal() + 1
        assert index.first(start, stop, threshold) == start + first_hit(prices[start:stop] >= threshold)
    return 4000


def assert_gradient():
    class Batch:
        def inputs(self, selection, scale, with_news):
            return inputs[selection]

    rng = np.random.default_rng(102)
    inputs = rng.normal(size=(6, 9)).astype("f4")
    params = initialize(9, 9, rng)
    chosen = np.array([0, 1, 2, 0, 2, 1])
    noise = rng.normal(size=(6, 2)).astype("f4") * EXIT_NOISE
    advantage = rng.normal(size=6)
    row = np.flatnonzero(chosen)
    exit_col = np.where(chosen[row] == 1, 3, 5)[:, None] + np.arange(2)
    fixed_sample = forward(inputs, params)[1][row[:, None], exit_col] + noise[row]
    grads = gradient(Batch(), slice(0, 6), None, params, False, chosen, noise, advantage)

    def score():
        pred = forward(inputs, params)[1].astype("f8")
        nll = -log_softmax(pred[:, :3], axis=1)[np.arange(6), chosen]
        nll[row] += np.sum(((fixed_sample - pred[row[:, None], exit_col]) / EXIT_NOISE)**2 / 2, axis=1)
        return nll @ advantage

    for layer in range(len(params)):
        for part, weight in enumerate(params[layer]):
            grad = grads[layer][part]
            ranks = np.argsort(np.abs(grad).ravel())[-3:]
            for rank in ranks:
                coord = np.unravel_index(rank, weight.shape)
                value = float(weight[coord])
                step = 0.001
                weight[coord] = value + step
                plus = score()
                weight[coord] = value - step
                minus = score()
                weight[coord] = value
                np.testing.assert_allclose((plus - minus) / (2 * step), grad[coord], rtol=.015, atol=.00025)
    return 30


def assert_decisions(data, market):
    rows = data.decisions
    stamps = rows["at"]
    assert (stamps[1:] >= stamps[:-1]).all()
    same = stamps[1:] == stamps[:-1]
    assert (rows["asset"][1:][same] > rows["asset"][:-1][same]).all()
    assert (stamps % (5 * MINUTE) == 5000).all()
    receipt_info = load(HERE.parent / "receipts.json")
    receipt_times = np.load(WORK / "receipt-times.npy", mmap_mode="r")
    receipts = np.load(WORK / "receipts.npy", mmap_mode="r")
    switch = minute(receipt_info["begin_ms"])
    rng = np.random.default_rng(103)
    sampled = np.r_[rng.choice(len(rows), size=400, replace=False),
                    rng.integers(np.searchsorted(stamps, receipt_info["begin_ms"] + 5 * MINUTE), len(rows), size=100)]
    for row in rows[sampled]:
        last, asset = minute(int(row["at"])), int(row["asset"])
        candles = market.raw[asset, last - 5:last]
        if last - 5 >= switch:
            slot = slice(last - 5 - switch, last - switch)
            candles = receipts[asset, slot]
            times = receipt_times[asset, slot]
            assert ((0 < times) & (times <= row["at"])).all()
        np.testing.assert_allclose(row["reference"], candles[-1, 3])
        np.testing.assert_allclose(row["turnover"], candles[-1, 3] * candles[:, 4].sum())
    assert (data.market[:, -4:-1] <= data.market[:, -3:]).all()
    span = slice(0, 8)
    width = len(BASE_COLUMNS)
    scale = (np.zeros(width), np.ones(width))
    assert not data.inputs(span, scale, True)[:, width:].any()
    first = data.manifest["news_offset"]
    assert not data.inputs(slice(first, first + 100), scale, False)[:, width:].any()
    return len(sampled)


def check_trade(trade, market, cutoff, training):
    mode, asset, sign = (trade[key] for key in ("mode", "asset", "sign"))
    delay, slip = MODES[mode]
    entry, end, paid, qty, size = (trade[key] for key in ("entry", "end", "paid", "qty", "size"))
    assert sign in (-1, 1) and entry == minute(trade["decision"]) + 1 + delay
    assert entry < cutoff and (end is None or entry < end <= cutoff)
    assert not training or end is not None
    np.testing.assert_allclose(paid, market.raw[asset, entry, 0] * (1 + sign * slip))
    target, stop = trade["target"], trade["stop"]
    assert sign * (target - paid) > 0 and sign * (paid - stop) > 0
    np.testing.assert_allclose(qty * paid, size)
    assert MIN_NOTIONAL <= size <= min(LIMITS["maxOrderUsd"], LIMITS["maxInstrumentUsd"]) + 1e-8
    risk = size * (abs(stop / paid - 1) + COST_RATE)
    np.testing.assert_allclose(risk, trade["planned_risk"])
    assert risk <= LIMITS["maxRiskPerTradeUsd"] + 1e-8
    assert trade["open_risk_before"] + risk <= LIMITS["maxOpenRiskUsd"] + 1e-8
    assert trade["occupied_before"] < LIMITS["maxConcurrentPositions"]
    assert trade["gross_before"] + size * (1 + FEE) <= min(trade["equity_before"], CAPITAL) * LIMITS["maxGrossLeverage"] + 1e-8
    effective = cutoff if end is None else end
    tape = market.raw[asset, entry:effective]
    high, low = tape[:, 1], tape[:, 2]
    target_hit = first_hit(high >= target if sign == 1 else low <= target)
    stop_hit = first_hit(low <= stop if sign == 1 else high >= stop)
    hit = min(target_hit, stop_hit)
    reason = trade["reason"]
    if hit < len(tape):
        observed = entry + hit + 1
        assert reason == (1 if stop_hit <= target_hit else 2)
        assert end == observed
        opening = tape[hit, 0]
        trigger = (min(opening, stop) if sign == 1 else max(opening, stop)) if reason == 1 else target
    elif training:
        assert reason == CUTOFF and end == cutoff
        quoted = np.flatnonzero(np.isfinite(tape[:, 3]) & (tape[:, 3] > 0))[-1]
        observed, trigger = entry + int(quoted) + 1, tape[quoted, 3]
    else:
        assert reason == 0 and end is None
        observed, trigger = None, None
    assert trade["price_observed_minute"] == observed
    funded_through = effective - int(training and effective == cutoff)
    _, flow, missing = market.asset(asset)
    start_hour, end_hour = entry // 60 + 1, funded_through // 60 + 1
    funding = -sign * qty * np.diff(flow[start_hour:end_hour + 1]).sum()
    assert trade["missing_funding"] == missing[end_hour] - missing[start_hour]
    np.testing.assert_allclose(trade["funding"], funding, atol=1e-12)
    if trigger is None:
        assert trade["sold"] is None and trade["net"] is None
        np.testing.assert_allclose(trade["fees"], FEE * size)
    else:
        sold = trigger * (1 - sign * slip)
        fees = FEE * (size + qty * sold)
        np.testing.assert_allclose(trade["sold"], sold)
        np.testing.assert_allclose(trade["fees"], fees)
        np.testing.assert_allclose(trade["net"], sign * qty * (sold - paid) - fees + funding, atol=1e-10)


def verify_ledger(market, file, cutoff, training, metrics=None):
    by_book = defaultdict(list)
    with gzip.open(file, "rt") as stream:
        for line in stream:
            trade = json.loads(line)
            check_trade(trade, market, minute(cutoff), training)
            by_book[trade["experiment"], trade["mode"]].append(trade)
    summary = {}
    for (name, mode), trades in by_book.items():
        active = {}
        for row in trades:
            active = {asset: end for asset, end in active.items() if end > row["entry"]}
            assert len(active) < LIMITS["maxConcurrentPositions"] and row["asset"] not in active
            active[row["asset"]] = row["end"] or minute(cutoff)
        closed = [t["net"] for t in trades if t["net"] is not None]
        wins = sum(value > 0 for value in closed)
        if metrics is not None:
            record = metrics[name][mode]
            assert record["fills"] == len(trades)
            assert record["closed"] == len(closed) and record["wins"] == wins
            assert record["ending_open"] == len(trades) - len(closed)
            assert record["win_rate"] == (wins / len(closed) if closed else None)
            np.testing.assert_allclose(record["net"], math.fsum(closed) + record["open_marked_pnl"], atol=1e-7)
        summary[f"{name}:{mode}"] = dict(fills=len(trades), closed=len(closed), wins=wins,
                                       cutoff=sum(t["reason"] == CUTOFF for t in trades))
    return summary


def main():
    market, data = Market(), Dataset()
    fit = load(HERE / "fit.json")
    news_fit = load(HERE / "news-fit.json")
    backtest = load(HERE / "results.json")
    news_backtest = load(HERE / "news-results.json")
    cases = (
        ("training-trades.jsonl.gz", TEST_START, True, fit["final_training_ledger"], None),
        ("news-training-trades.jsonl.gz", NEWS_TEST, True, news_fit["news_training_ledger"], None),
        ("backtest-trades.jsonl.gz", MARK_STOP, False, backtest["ledger"], backtest["policies"]),
        ("news-backtest-trades.jsonl.gz", NEWS_MARK, False, news_backtest["ledger"], news_backtest["policies"]),
    )
    save = dict(barrier_queries=assert_passage(), gradient_coordinates=assert_gradient(),
                audited_decisions=assert_decisions(data, market), ledgers={})
    for file, cutoff, training, expected, metrics in cases:
        assert file_hash(HERE / file) == expected
        save["ledgers"][file] = dict(cutoff=iso(cutoff), books=verify_ledger(market, HERE / file, cutoff, training, metrics))
    for records in [fit["development"], fit["final"], *news_fit["records"].values()]:
        for step in records:
            assert step["closed"] == sum(r["closed"] for draw in step["rollouts"] for r in draw.values())
            assert all(r["closed"] == r["fills"] for draw in step["rollouts"] for r in draw.values())
    save_json(HERE / "verification.json", save)
    print(f"Verified {sum(b['fills'] for f in save['ledgers'].values() for b in f['books'].values()):,} ledger positions")


if __name__ == "__main__":
    main()
