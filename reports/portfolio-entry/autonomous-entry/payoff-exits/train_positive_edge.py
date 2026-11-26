"""Train directional return models and test one frozen positive-edge policy."""
import argparse
from pathlib import Path

import numpy as np

import train_payoff_gated as prior
import recalibrate_payoff_gate as calibration
from payoff_data import BEGIN, MODES, SIGNS, TEACH, VALIDATION, minute
from settings import SYMBOLS, TEST_START, file_hash, load, ms, save_json

OUT = Path(__file__).resolve().parent / "portfolio-objective/payoff-gated-v3"
SPEC = OUT / "protocol.json"
PLAN = load(SPEC)
PAIR = PLAN["brackets_bps"]
HOURS = (24, 72, 168)
TARGETS = ("net", "sensitivity_net", "win")
assert [ms(d) for d in PLAN["fit_utc"]] == [BEGIN, TEACH]
assert [ms(d) for d in PLAN["selection_utc"]] == [TEACH, VALIDATION]
assert [ms(d) for d in PLAN["validation_utc"]] == [VALIDATION, TEST_START]


def hour_statistics(candles, ends):
    """One feature vector per hour boundary, excluding every candle at or after it."""
    hourly = candles.reshape(-1, 60, candles.shape[-1])
    opening, close = hourly[:, 0, 0], hourly[:, -1, 3]
    high = np.fmax.reduce(hourly[:, :, 1], axis=1)
    low = np.fmin.reduce(hourly[:, :, 2], axis=1)
    coverage = (np.isfinite(hourly[:, :, :4]) & (hourly[:, :, :4] > 0)).all(axis=2).mean(axis=1)
    change = np.log(close / opening)
    result = []
    for h in HOURS:
        idx = ends[:, None] - np.arange(h, 0, -1)
        assert idx.min() >= 0 and idx.max() < len(close)
        returns = change[idx]
        observed = np.isfinite(returns)
        count = np.maximum(1, observed.sum(axis=1))
        result.extend((np.log(close[ends-1] / opening[ends-h]),
                       np.fmax.reduce(high[idx], axis=1), np.fmin.reduce(low[idx], axis=1),
                       coverage[idx].mean(axis=1), np.where(observed, np.sign(returns), 0).sum(axis=1) / count,
                       np.sqrt(np.nansum(returns ** 2, axis=1) / count)))
    return np.column_stack(result)


def completed_history(market, asset, stamps, reference):
    ends, inverse = np.unique(minute(stamps) // 60, return_inverse=True)
    first = int(ends[0] - max(HOURS))
    if first < 0:
        raise ValueError("Insufficient trailing market history")
    tape = market.raw[asset, first*60:int(ends[-1])*60]
    result = hour_statistics(tape, ends-first)[inverse]
    for column in (1, 2):
        result[:, column::6] = np.log(result[:, column::6] / reference[:, None])
    return result


def inputs(data, market, begin, end):
    # These historical windows all precede the switch to timestamped candle receipts.
    assert end <= load(prior.HERE.parent.parent / "receipts.json")["begin_ms"]
    span = data.span(begin, end)
    ids = np.arange(span.start, span.stop)
    rows = data.decisions[span]
    x = prior.features(data, ids, prior.joblib.load(prior.FUNDING))
    history = np.empty((len(rows), 6*len(HOURS)), dtype="f4")
    for asset in np.unique(rows["asset"]):
        idx = np.flatnonzero(rows["asset"] == asset)
        history[idx] = completed_history(market, int(asset), rows["at"][idx], rows["reference"][idx])
    # Benchmark returns use the same completed hours, even at timestamps where BTC is ineligible.
    stamps, inverse = np.unique(rows["at"] // 3600000, return_inverse=True)
    btc = completed_history(market, SYMBOLS.index("BTC"), stamps * 3600000, np.ones(len(stamps)))[:, ::6]
    benchmark = btc[inverse].astype("f4")
    x = np.column_stack((x, history, benchmark, history[:, ::6] - benchmark))
    assert not np.isinf(x).any()
    return rows, x


def with_scenario(x, mode):
    return np.column_stack((x, np.full(len(x), mode, dtype="f4")))


def fit_side(x, net, flags):
    blocks, values, adjusted = [], [], []
    for m in range(len(MODES)):
        filled = np.isfinite(net[:, m])
        y = net[filled, m]
        blocks.append(with_scenario(x[filled], m))
        values.append(y)
        adjusted.append(prior.conservative_net(y, 1., PAIR, flags[filled, m]))
    design = np.concatenate(blocks)
    raw, conservative = np.concatenate(values), np.concatenate(adjusted)
    params = dict(learning_rate=.045, num_leaves=31, max_depth=6, min_data_in_leaf=420, lambda_l2=12,
                  max_bin=63, num_threads=4, deterministic=True, force_col_wise=True, seed=738, verbosity=-1)
    models = {}
    for name, y in zip(TARGETS, (raw*10000, conservative*10000, conservative > 0), strict=True):
        params["objective"] = "binary" if name == "win" else "regression"
        models[name] = prior.lgb.train(params, prior.lgb.Dataset(design, label=y.astype("f4")),
                                       num_boost_round=max(PLAN["rounds"]))
    return models


def predictions(x, models, rounds):
    result = np.empty((len(x), len(SIGNS), len(MODES), len(TARGETS)))
    for scenario in range(len(MODES)):
        design = with_scenario(x, scenario)
        for side, family in enumerate(models):
            for j, name in enumerate(TARGETS):
                value = family[name].predict(design, num_iteration=rounds, num_threads=4)
                result[:, side, scenario, j] = value if name == "win" else value / 10000
    return result


def entry_scores(pred, edge_bps, min_probability):
    if edge_bps < 0 or not 0 <= min_probability <= 1:
        raise ValueError("Invalid admission threshold")
    edge = pred[..., :2].min(axis=(2, 3))
    probability = pred[..., 2].min(axis=2)
    admitted = np.isfinite(pred).all(axis=(2, 3)) & (edge > edge_bps/10000) & (probability >= min_probability)
    return np.where(admitted, edge, 0.)


def run(data, market, begin, end, rows, pred, gate, *, full=False):
    score = entry_scores(pred, gate["edge_bps"], gate["min_probability"])
    books, ledgers = prior.run_book(data, market, begin, end, score, PAIR, full=full)
    econ = {m: prior.economics(market, trades, PAIR) for m, trades in ledgers.items()}
    active = np.flatnonzero((score > 0).any(axis=1))
    lookup = {(int(rows[i]["at"]), int(rows[i]["asset"])): i for i in active}
    accuracy = {}
    for scenario, (mode, _) in enumerate(MODES):
        trades = ledgers[mode]
        expected = 0.
        min_edge = None
        for t in trades:
            i, side = lookup[t["decision"], t["asset"]], SIGNS.index(t["sign"])
            action = pred[i, side]
            worst = float(action[:, :2].min())
            if not (worst > gate["edge_bps"]/10000 and np.isfinite(action).all()
                    and action[:, 2].min() >= gate["min_probability"]):
                raise AssertionError("A fill failed the signed forecast gate")
            expected += float(action[scenario, 0]) * t["size"]
            min_edge = worst if min_edge is None else min(min_edge, worst)
            if full:
                t["forecasts"] = {name: dict(net_bps=float(a[0]*10000), sensitivity_net_bps=float(a[1]*10000),
                                             win_probability=float(a[2]))
                                  for (name, _), a in zip(MODES, action, strict=True)}
        accuracy[mode] = dict(fills_checked=len(trades), lowest_admitted_bps=None if min_edge is None else min_edge*10000,
                              predicted_net_usd=expected, realized_net_usd=econ[mode]["net"])
    return books, ledgers, dict(economics=econ, forecasts_on_fills=accuracy,
                                admitted_by_side=(score > 0).sum(axis=0).tolist())


def selection_key(economics, monthly):
    # The existing rule supplies turnover, win and net diagnostics; give joint feasibility first priority.
    volume, joint, positive, win, sensitivity, net = calibration.priority(economics, monthly)
    return joint, volume, positive, win, sensitivity, net


def provenance(data):
    return dict(inputs=prior.sources(data), calibration_code=file_hash(calibration.__file__),
                implementation=file_hash(__file__), protocol=file_hash(SPEC), lightgbm=prior.lgb.__version__)


def train():
    data, market = prior.Dataset(), prior.Market()
    sources = provenance(data)
    rows, x = inputs(data, market, BEGIN, TEACH)
    raw, flags = prior.training_labels(market, rows, [PAIR])
    models, sample = [], {}
    for side, sign in enumerate(SIGNS):
        y = raw[0, :, side, :]
        valid = np.isfinite(y)
        sample[str(sign)] = dict(filled_labels=int(valid.sum()), uncertain_labels=int(flags[0, :, side].sum()),
                                 recorded_nonwinners=int((y[valid] <= 0).sum()))
        print(f"Training side {sign} on {valid.sum():,} executable labels", flush=True)
        models.append(fit_side(x, y, flags[0, :, side, :]))
    rows_cal, x_cal = inputs(data, market, TEACH, VALIDATION)
    records = []
    for rounds in PLAN["rounds"]:
        pred = predictions(x_cal, models, rounds)
        for edge in PLAN["edge_floors_bps"]:
            for probability in PLAN["win_floors"]:
                gate = dict(edge_bps=edge, min_probability=probability)
                _, trades, stats = run(data, market, TEACH, VALIDATION, rows_cal, pred, gate)
                monthly = calibration.natural_month_counts(trades)
                records.append(dict(rounds=rounds, gate=gate, **stats, monthly_natural=monthly,
                                    priority=selection_key(stats["economics"], monthly)))
        print(f"Scored {rounds}-round checkpoint on March-April portfolios", flush=True)
    winner = max(records, key=lambda r: r["priority"])
    chosen = winner["rounds"]
    saved = [{name: tree.model_to_string(num_iteration=chosen) for name, tree in family.items()} for family in models]
    checkpoint = dict(pair=PAIR, gate=winner["gate"], rounds=chosen, models=saved, sources=sources)
    save_json(OUT / "checkpoint.json", checkpoint)
    save_json(OUT / "fit.json", dict(checkpoint_sha256=file_hash(OUT / "checkpoint.json"), fit_rows=len(rows),
        fit_labels=sample, calibration_rows=len(rows_cal), selection_index=records.index(winner), records=records))
    print("Frozen", chosen, winner["gate"], winner["monthly_natural"], flush=True)


def validate():
    data, market = prior.Dataset(), prior.Market()
    digest = file_hash(OUT / "checkpoint.json")
    state, fit = load(OUT / "checkpoint.json"), load(OUT / "fit.json")
    winner = max(fit["records"], key=lambda r: r["priority"])
    assert state["sources"] == provenance(data) and digest == fit["checkpoint_sha256"] and state["pair"] == PAIR
    assert state["rounds"] == winner["rounds"] and state["gate"] == winner["gate"]
    models = [{name: prior.lgb.Booster(model_str=s) for name, s in family.items()} for family in state["models"]]
    rows, x = inputs(data, market, VALIDATION, TEST_START)
    pred = predictions(x, models, state["rounds"])
    books, trades, stats = run(data, market, VALIDATION, TEST_START, rows, pred, state["gate"], full=True)
    audited = prior.audited("candidate", market, TEST_START, True, books, trades, prior.WORST_NET, OUT)
    passes = {m: calibration.passes(b, PLAN["qualification"]["minimum_closes"]) for m, b in books.items()}
    assert digest == file_hash(OUT / "checkpoint.json")
    save_json(OUT / "validation.json", dict(checkpoint_sha256=digest, validation_utc=PLAN["validation_utc"],
        decision_rows=len(rows), **audited, **stats, passes=passes, qualified=all(passes.values())))
    for mode, b in books.items():
        print(mode, b["wins"], b["closed"], b["net"], passes[mode], flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("train", "validate"))
    if parser.parse_args().stage == "train":
        train()
    else:
        validate()
