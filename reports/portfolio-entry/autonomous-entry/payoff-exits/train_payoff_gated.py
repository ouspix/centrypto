"""Fit a bracket-specific after-cost entry policy, then validate its frozen checkpoint."""
import argparse
from collections import Counter
from pathlib import Path

import joblib
import numpy as np

from payoff_data import (BEGIN, COST_RATE, FEE, MIN_NOTIONAL, MODES, SIGNS, TEACH, VALIDATION,
                         Dataset, FirstPassage, Market, initial_size, minute, volatility)
import lightgbm as lgb
from autonomous_data import BASE_COLUMNS, STORE
from autonomous_replay import CUTOFF, LIMITS, Schedule
from payoff_replay import replay
from settings import DAY, HOUR, MINUTE, ORIGINAL_REPORT, START, SYMBOLS, TEST_START, file_hash, load, ms, save_json
from source_data import FUNDING, GRID
from train_portfolio import WORST_NET, audited

HERE = Path(__file__).resolve().parent
OUT = HERE / "portfolio-objective/payoff-gated-v1"
SPEC = OUT / "protocol.json"
PLAN = load(SPEC)
MONTHS = [ms(date) for date in PLAN["calibration_months_utc"]]
assert (ms(PLAN["fit_start_utc"]), ms(PLAN["fit_cutoff_utc"])) == (BEGIN, TEACH)
assert (MONTHS[0], MONTHS[-1]) == (TEACH, VALIDATION)
assert [ms(date) for date in PLAN["validation_utc"]] == [VALIDATION, TEST_START]


def sources(data):
    paths = {STORE / (key + ".npy"): data.manifest["hashes"][key] for key in ("market", "decisions")}
    paths[GRID] = data.manifest["hashes"]["minute_grid"]
    paths[FUNDING] = load(ORIGINAL_REPORT / "funding.json")["funding_sha256"]
    for path, expected in paths.items():
        if file_hash(path) != expected:
            raise ValueError(f"Input digest mismatch for {path}")
    return {**{p.name: v for p, v in paths.items()}, "protocol": file_hash(SPEC),
            "trainer": file_hash(__file__), "allocator": file_hash(HERE / "payoff_replay.py"),
            "mandate": file_hash(HERE.parent.parent / "bracket-exits/desk-mandate.json")}


def distances(pair):
    fractions = np.asarray(pair, dtype="f8") / 10000
    signs = np.asarray(SIGNS)
    return np.column_stack((signs * np.log1p(signs * fractions[0]),
                            -signs * np.log1p(-signs * fractions[1])))


def conservative_net(net, size, pair, uncertain):
    charge = -size * (pair[1] / 10000 + COST_RATE)
    return np.where(uncertain, np.minimum(net, charge), net)


def features(data, ids, rates):
    rows = data.decisions[ids]
    # Use the settlement one full hour before the current hour. Missing rates stay missing.
    last = (rows["at"] // HOUR - 1) * HOUR
    funding = np.full((len(rows), 2), np.nan, dtype="f4")
    for asset in np.unique(rows["asset"]):
        which = np.flatnonzero(rows["asset"] == asset)
        hours, inverse = np.unique(last[which], return_inverse=True)
        history = rates.get(SYMBOLS[asset], {})
        lag = np.array([[history.get(int(h - n * HOUR), np.nan) for n in range(8)] for h in hours])
        funding[which] = np.column_stack((lag[:, 0], lag.mean(axis=1)))[inverse] * 10000
    return np.column_stack((data.market[ids], funding)).astype("f4")


def side_features(x, sign, scenario):
    # Orient short and long returns in the same direction for the shared estimator.
    directional = [i for i, name in enumerate(BASE_COLUMNS) if "return" in name]
    return np.column_stack((x, x[:, directional] * sign, -sign * x[:, -2:],
                            np.full(len(x), sign), np.full(len(x), scenario))).astype("f4")


def label_asset(market, rows, ids, pair, first, cutoff, sign, mode, tape, trees, gaps, last_close):
    delay, slip = dict(MODES)[mode]
    entry = (rows["at"][ids] - START) // MINUTE + 1 + delay
    side = SIGNS.index(sign)
    distance = distances(pair)[side]
    available = entry < cutoff
    ids, entry = ids[available], entry[available]
    paid = tape[entry-first, 0].astype("f8") * (1 + sign * slip)
    size = initial_size(rows["turnover"][ids], distance[1], sign)
    valid = np.isfinite(paid) & (paid > 0) & (size >= MIN_NOTIONAL)
    valid &= sign * (paid / rows["reference"][ids] - 1) * 10000 <= LIMITS["maxSlippageBps"]
    ids, entry, paid = ids[valid], entry[valid], paid[valid]
    if not len(ids):
        return ids, np.empty(0), np.empty(0, dtype=bool)
    # Use the same log distances and float64 arithmetic as the execution replay.
    target, stop = paid * np.exp(sign * distance[0]), paid * np.exp(-sign * distance[1])
    up, down = trees if sign == 1 else trees[::-1]
    target_at = up.hit(entry-first, sign * target)
    stop_at = down.hit(entry-first, -sign * stop)
    hit = np.minimum(target_at, stop_at)
    natural = hit < len(tape)
    safe = np.minimum(hit, len(tape)-1)
    gap = tape[safe, 0]
    stop_fill = np.minimum(stop, gap) if sign == 1 else np.maximum(stop, gap)
    trigger = np.where(natural, np.where(stop_at <= target_at, stop_fill, target), tape[last_close, 3])
    sold = trigger * (1 - sign * slip)
    end = np.where(natural, first + hit + 1, cutoff)
    asset = int(rows["asset"][ids[0]])
    _, flow, missing = market.asset(asset)
    a, b = entry // 60 + 1, (end - (end == cutoff)) // 60 + 1
    funding = -sign * (flow[b] - flow[a]) / paid
    net = sign * (sold / paid - 1) - FEE * (1 + sold / paid) + funding
    uncertain = (gaps[end-first] != gaps[entry-first]) | (missing[b] != missing[a])
    uncertain |= ~natural & (last_close != len(tape)-1)
    return ids, net, uncertain


def training_labels(market, rows, pairs):
    first, cutoff = minute(BEGIN), minute(TEACH)
    shape = (len(pairs), len(rows), len(SIGNS), len(MODES))
    net = np.full(shape, np.nan, dtype="f4")
    uncertain = np.zeros(shape, dtype=bool)
    for asset in np.unique(rows["asset"]):
        ids = np.flatnonzero(rows["asset"] == asset)
        tape = market.raw[asset, first:cutoff]
        valid = np.isfinite(tape[:, :4]) & (tape[:, :4] > 0)
        gaps = np.r_[0, (~valid.all(axis=1)).cumsum()]
        last_close = np.flatnonzero(valid[:, 3])[-1]
        trees = FirstPassage(tape[:, 1]), FirstPassage(-tape[:, 2])
        for k, pair in enumerate(pairs):
            for side, sign in enumerate(SIGNS):
                for m, (mode, _) in enumerate(MODES):
                    loc, value, flag = label_asset(market, rows, ids, pair, first, cutoff, sign, mode,
                                                   tape, trees, gaps, last_close)
                    net[k, loc, side, m], uncertain[k, loc, side, m] = value, flag
    return net, uncertain


def fit_models(x, net, uncertain, pair):
    blocks, targets = [], []
    for side, sign in enumerate(SIGNS):
        for m in range(len(MODES)):
            y = net[:, side, m]
            filled = np.isfinite(y)
            blocks.append(side_features(x[filled], sign, m))
            targets.append(conservative_net(y[filled], 1., pair, uncertain[filled, side, m]))
    x_fit, y_fit = np.concatenate(blocks), np.concatenate(targets)
    # Shallow trees with large leaves reduce reliance on overlapping intraday labels.
    params = dict(verbosity=-1, learning_rate=.04, num_leaves=12, max_depth=4,
                  min_data_in_leaf=600, lambda_l2=8, max_bin=63, num_threads=4,
                  deterministic=True, force_col_wise=True, seed=738)
    models = []
    for objective, response in (("binary", y_fit > 0), ("regression", 10000 * y_fit)):
        dataset = lgb.Dataset(x_fit, label=response.astype("f4"))
        models.append(lgb.train({**params, "objective": objective}, dataset, num_boost_round=100))
    return models


def predictions(x, models):
    p, edge = (np.empty((len(x), 2, 2)) for _ in range(2))
    for side, sign in enumerate(SIGNS):
        for m in range(len(MODES)):
            block = side_features(x, sign, m)
            p[:, side, m], edge[:, side, m] = (model.predict(block, num_threads=4) for model in models)
    return p.min(axis=2), edge.min(axis=2) / 10000


def scores(p, edge, pair, threshold):
    min_edge = PLAN["minimum_predicted_net_fraction_of_target"] * pair[0] / 10000
    return np.where((p >= threshold) & (edge >= min_edge), edge, 0.)


def run_book(data, market, begin, end, score, pair, *, full=False):
    span = data.span(begin, end)
    ids = np.flatnonzero((score > 0).any(axis=1))
    schedule = Schedule(data.decisions[span][ids])
    dist = np.broadcast_to(distances(pair), (len(ids), 2, 2))
    vol = volatility(data, ids + span.start)
    books, trades = {}, {}
    for mode, _ in MODES:
        books[mode], trades[mode], _ = replay(market, schedule, dist, score[ids, :, None], vol, mode,
            begin, end, close_book=True, record_plan=False, training_score_only=not full)
    return books, trades


def economics(market, trades, pair):
    net = np.array([t["net"] for t in trades])
    size = np.array([t["size"] for t in trades])
    for t in trades:
        tape = market.raw[t["asset"], t["entry"]:t["end"], :4]
        t["missing_candle_minutes"] = int((~(np.isfinite(tape) & (tape > 0)).all(axis=1)).sum())
        t["exit_quote_age_minutes"] = t["end"] - t["price_observed_minute"]
        t["uncertain"] = bool(t["missing_funding"] or t["missing_candle_minutes"] or t["exit_quote_age_minutes"])
    flag = np.array([t["uncertain"] for t in trades], dtype=bool)
    sensitivity = conservative_net(net, size, pair, flag)
    wins, losses = net[net > 0], -net[net < 0]
    natural = [t for t in trades if t["reason"] != CUTOFF]
    fees, funding = sum(t["fees"] for t in trades), sum(t["funding"] for t in trades)
    return dict(closed=len(net), wins=len(wins), net=float(net.sum()), fees=fees, funding=funding,
                executed_price_pnl_before_costs=float(net.sum() + fees - funding),
                expectancy_usd=float(net.mean()) if len(net) else None,
                average_win=float(wins.mean()) if len(wins) else None,
                average_loss_magnitude=float(losses.mean()) if len(losses) else None,
                break_even_win_rate=float(losses.mean() / (wins.mean() + losses.mean())) if len(wins) and len(losses) else None,
                missing_funding_hours=sum(t["missing_funding"] for t in trades),
                uncertain_positions=int(flag.sum()), natural_closes=len(natural),
                natural_wins=sum(t["net"] > 0 for t in natural), natural_net=sum(t["net"] for t in natural),
                cutoff_closes=len(net)-len(natural), sensitivity_net=float(sensitivity.sum()),
                sensitivity_wins=int((sensitivity > 0).sum()))


def selection_key(monthly):
    attainment, daily_net = [], []
    for (begin, end), books in zip(zip(MONTHS, MONTHS[1:]), monthly, strict=True):
        required = int(np.ceil(PLAN["qualification"]["minimum_closes"] * (end-begin) / (TEST_START-VALIDATION)))
        for b in books.values():
            rate = b["sensitivity_wins"] / max(1, b["closed"])
            attainment.extend((min(1., b["closed"] / required), min(1., rate / .95)))
            daily_net.append(b["sensitivity_net"] / ((end-begin) / DAY))
    return min(daily_net) > 0, min(attainment), min(daily_net)


def train():
    data, market, rates = Dataset(), Market(), joblib.load(FUNDING)
    provenance = sources(data)
    s = data.span(BEGIN, TEACH)
    grid = minute(data.decisions["at"][s]) % PLAN["fit_sample_minutes"] == 0
    ids = np.flatnonzero(grid) + s.start
    x = features(data, ids, rates)
    pairs = PLAN["take_profit_stop_loss_bps"]
    raw, flags = training_labels(market, data.decisions[ids], pairs)
    print(f"Built labels for {len(ids):,} fit decisions", flush=True)
    # Check both economic labels and their uncertainty flags against scalar executions.
    rng = np.random.default_rng(738)
    checked = 0
    for k, pair in enumerate(pairs):
        filled = np.argwhere(np.isfinite(raw[k]))
        picked = filled[rng.choice(len(filled), min(128, len(filled)), replace=False)]
        for i, side, m in picked:
            row = data.decisions[ids[i]]
            mode, (delay, slip) = MODES[m]
            sign, asset, stamp = SIGNS[side], int(row["asset"]), int(row["at"])
            paid = float(market.raw[asset, minute(stamp)+1+delay, 0] * (1 + sign * slip))
            target, stop = paid * np.exp(np.array([sign, -sign]) * distances(pair)[side])
            t = market.execute(asset, sign, stamp, minute(TEACH), mode, paid, 1., target, stop, None, True)
            economics(market, [t], pair)
            np.testing.assert_allclose(raw[k, i, side, m], t["net"], atol=2e-7, rtol=1e-5)
            assert flags[k, i, side, m] == t["uncertain"]
            checked += 1
    training, records, best, selected = [], [], None, None
    cal = []
    for begin, end in zip(MONTHS, MONTHS[1:]):
        s = data.span(begin, end)
        cal.append((begin, end, features(data, np.arange(s.start, s.stop), rates)))
    for k, pair in enumerate(pairs):
        models = fit_models(x, raw[k], flags[k], pair)
        forecasts = [predictions(cx, models) for _, _, cx in cal]
        training.append(dict(pair=pair, filled_labels=int(np.isfinite(raw[k]).sum()),
                             uncertain_labels=int(flags[k].sum())))
        for threshold in PLAN["minimum_predicted_win"]:
            monthly = []
            for (begin, end, _), (p, edge) in zip(cal, forecasts, strict=True):
                _, trades = run_book(data, market, begin, end, scores(p, edge, pair, threshold), pair)
                monthly.append({m: economics(market, ts, pair) for m, ts in trades.items()})
            key = selection_key(monthly)
            records.append(dict(pair=pair, threshold=threshold, months=monthly, priority=list(key)))
            if best is None or key > best:
                best = key
                selected = dict(pair=pair, threshold=threshold, models=[m.model_to_string() for m in models])
        print(f"Trained and calibrated {pair[0]}/{pair[1]} bp bracket", flush=True)
    selected.update(sources=provenance, feature_columns=BASE_COLUMNS, lightgbm=lgb.__version__)
    save_json(OUT / "checkpoint.json", selected)
    save_json(OUT / "fit.json", dict(fit_decisions=len(ids), candidate_labels=training,
        scalar_labels_checked=checked, calibration=records, selected_pair=selected["pair"],
        selected_threshold=selected["threshold"], selected_priority=list(best),
        checkpoint_sha256=file_hash(OUT / "checkpoint.json")))


def validate():
    data, market = Dataset(), Market()
    digest = file_hash(OUT / "checkpoint.json")
    fit, state = load(OUT / "fit.json"), load(OUT / "checkpoint.json")
    assert digest == fit["checkpoint_sha256"] and sources(data) == state["sources"]
    s = data.span(VALIDATION, TEST_START)
    p, edge = predictions(features(data, np.arange(s.start, s.stop), joblib.load(FUNDING)),
                          [lgb.Booster(model_str=model) for model in state["models"]])
    pair = state["pair"]
    gate = scores(p, edge, pair, state["threshold"])
    result = {}
    for name, value in (("candidate", gate), ("constant", np.ones_like(gate))):
        books, ledgers = run_book(data, market, VALIDATION, TEST_START, value, pair, full=True)
        econ = {mode: economics(market, ts, pair) for mode, ts in ledgers.items()}
        report = audited(name, market, TEST_START, True, books, ledgers, WORST_NET, OUT)
        passes = {mode: b["net"] > 0 and b["wins"]*100 >= 95*b["closed"] and b["closed"] >= 250
                  for mode, b in books.items()}
        for m, e in econ.items():
            np.testing.assert_allclose(e["net"], books[m]["net"], atol=1e-7, rtol=0)
        result[name] = dict(**report, economics=econ, passes=passes, qualified=all(passes.values()))
        print(name, passes, [(m, round(b["net"], 2), b["wins"], b["closed"]) for m,b in books.items()], flush=True)
    assert digest == file_hash(OUT / "checkpoint.json")
    save_json(OUT / "validation.json", dict(checkpoint_sha256=digest, validation_utc=PLAN["validation_utc"],
        decision_rows=len(gate), positive_by_side=(gate > 0).sum(axis=0).tolist(), **result))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["train", "validate"])
    stage = parser.parse_args().stage
    (train if stage == "train" else validate)()
