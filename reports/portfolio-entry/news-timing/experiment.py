"""Retrain and replay the pinned ridge and neural architectures with publication timing."""
import argparse
from datetime import datetime, timezone
import gzip
import json
import sys

import joblib
import numpy as np

from publication_news import CACHE, HERE, write_json
from settings import (DAY, FEE, GATE, MARK_STOP, MINUTE, MODES, MONTHS, PURGE, START, TEST_START,
                      TEST_STOP, WORK, file_hash, iso, load, ms)
from book import Tape, replay
from train_policy import calibrate, fit_entry as fit_ridge, inputs, monthly_map, predict_raw, split_fold

PARENT = HERE.parent
sys.path.insert(0, str(PARENT/"deep-learning"))
from challenger import fit_entry as fit_neural, forecast_quality, gate_diagnostics, predict, verify_sources

FAMILIES = ("ridge", "neural")
LOCK = HERE/"fit.json"


def dataset():
    parent_lock = verify_sources()
    baseline = load(PARENT/"deep-learning/fit.json")
    assert file_hash(PARENT/"deep-learning/challenger.py") == baseline["script"]
    manifest = load(HERE/"dataset.json")
    assert file_hash(WORK/"candidates.joblib") == manifest["candidates"]
    assert file_hash(CACHE/"features.npy") == manifest["features"]
    assert file_hash(HERE/"news-inputs.json") == manifest["archive_manifest"]
    frame = joblib.load(WORK/"candidates.joblib")
    return parent_lock, frame, np.load(CACHE/"features.npy", mmap_mode="r")


def fit_one(family, x, frame, ids):
    if family == "neural":
        return fit_neural(x[ids], frame.iloc[ids])
    head = fit_ridge(x, frame, ids)
    info = {key: head[key] for key in ("rows", "dates", "first", "last", "matured_at")}
    return head, info


def forecast(family, head, x):
    scores = predict(head, x) if family == "neural" else predict_raw(head,x)
    assert np.isfinite(scores).all()
    return scores


def train_family(family, x, frame):
    maps, history = {}, []
    signs = frame.sign.to_numpy()
    raw = np.full((len(frame), 3), np.nan)
    calibrated = np.full_like(raw, np.nan)
    for begin, stop in zip(MONTHS, MONTHS[1:]+[TEST_START]):
        train_ids, val = split_fold(frame, begin, stop)
        head, info = fit_one(family, x, frame, train_ids)
        assert ms(info["matured_at"]) < begin
        raw[val] = forecast(family, head, x[val])
        calibrated[val] = calibrate(raw[val], signs[val], list(maps.values()))
        month = iso(begin)[:7]
        maps[month] = monthly_map(frame, raw, val)
        history.append(dict(month=month, fit=info))
        print(family, month, info["rows"], flush=True)

    final_ids = np.flatnonzero(frame.decision.to_numpy() < TEST_START-PURGE)
    head, info = fit_one(family, x, frame, final_ids)
    assert ms(info["matured_at"]) < TEST_START
    return dict(head=head, maps=maps), calibrated, dict(folds=history, final=info, calibration=maps)


def choose_size(tape, frame, scores, risk):
    trials = []
    for size in (0., 50., 100.):
        blocks = []
        for begin, stop in zip(MONTHS[3:], MONTHS[4:]+[TEST_START]):
            _, val = split_fold(frame, begin, stop)
            month = iso(begin)[:7]
            discounts = [risk["risk_aversion"] * v for v in risk["folds"][month]["coefficients"]]
            action = (size, *discounts)
            modes = {mode: replay(tape, val, scores, mode, action, begin, stop)[0] for mode in MODES}
            utility = (min(m["net"]-.25*m["max_drawdown"] for m in modes.values())/((stop-begin)/DAY)
                       if all(m["complete"] for m in modes.values()) else None)
            blocks.append(dict(month=month, modes=modes, utility=utility))
        objective = (float(np.mean([b["utility"] for b in blocks]))
                     if all(b["utility"] is not None for b in blocks) else None)
        trials.append(dict(size=size, objective=objective, blocks=blocks))
    best = max((trial for trial in trials if trial["objective"] is not None), key=lambda t: t["objective"])
    return best["size"], trials


def train(family):
    if LOCK.exists() or (HERE/f"{family}.joblib").exists():
        raise FileExistsError("This fit already exists")
    _, full, features = dataset()
    train = full[full.decision < TEST_START]
    assert np.array_equal(train.index, np.arange(len(train)))
    x = inputs(features[:len(train)], train.sign.to_numpy(), "news")
    bundle, oof, fit = train_family(family, x, train)
    risk = load(PARENT/"risk-training.json")
    bundle["size"], trials = choose_size(Tape(train), train, oof, risk)
    model = HERE/f"{family}.joblib"
    joblib.dump(bundle, model, compress=3)
    write_json(HERE/f"{family}-training.json", dict(**fit, model=file_hash(model),
                dataset=file_hash(HERE/"dataset.json"), selected_size=bundle["size"], development=trials))
    print(family, "selected size", bundle["size"], flush=True)


def seal():
    if LOCK.exists():
        raise FileExistsError(LOCK)
    models = {}
    for family in FAMILIES:
        fit = load(HERE/f"{family}-training.json")
        assert fit["model"] == file_hash(HERE/f"{family}.joblib")
        assert fit["dataset"] == file_hash(HERE/"dataset.json")
        assert ms(fit["final"]["matured_at"]) < TEST_START
        models[family] = file_hash(HERE/f"{family}-training.json")
    write_json(LOCK, dict(sealed_utc=datetime.now(timezone.utc).isoformat(), fits=models,
              dataset=file_hash(HERE/"dataset.json"), protocol=file_hash(HERE/"protocol.json"),
              script=file_hash(HERE/"experiment.py"), extractor=file_hash(HERE/"publication_news.py"),
              builder=file_hash(HERE/"rebuild.py"), portfolio_policy=file_hash(PARENT/"risk-lock.json"),
              ridge_baseline=file_hash(PARENT/"model.joblib"),
              neural_baseline=file_hash(PARENT/"deep-learning/fit.json")))


def compare():
    lock = load(LOCK)
    for key,name in (("dataset","dataset.json"), ("protocol","protocol.json"), ("script","experiment.py"),
                     ("extractor","publication_news.py"), ("builder","rebuild.py")):
        assert file_hash(HERE/name) == lock[key]
    assert file_hash(PARENT/"risk-lock.json") == lock["portfolio_policy"]
    parent_lock, full, features = dataset()
    for name, digest in parent_lock["asset_files"].items():
        assert file_hash(WORK/"assets"/name) == digest
    rows = np.flatnonzero(full.decision.to_numpy() >= TEST_START)
    frame = full.iloc[rows].reset_index(drop=True)
    assert frame.decision.max() < TEST_STOP
    for mode in MODES:
        assert START+frame["end_"+mode].max()*MINUTE < MARK_STOP
    x = inputs(features[rows], frame.sign.to_numpy(), "news")
    previous = np.load(WORK/"features.npy", mmap_mode="r")[rows]
    previous = inputs(previous, frame.sign.to_numpy(), "news")
    assert file_hash(PARENT/"model.joblib") == lock["ridge_baseline"]
    previous_neural_fit = load(PARENT/"deep-learning/fit.json")
    assert file_hash(PARENT/"deep-learning/fit.json") == lock["neural_baseline"]
    assert file_hash(PARENT/"deep-learning/model.joblib") == previous_neural_fit["model"]
    old = {"ridge": joblib.load(PARENT/"model.joblib")["models"]["news"],
           "neural": joblib.load(PARENT/"deep-learning/model.joblib")}
    risk = load(PARENT/"risk-training.json")
    discounts = tuple(risk["risk_aversion"] * v for v in risk["coefficients"])
    forecasts, quality, gate, plans = {}, {}, {}, {}
    for family in FAMILIES:
        manifest = HERE/f"{family}-training.json"
        assert file_hash(manifest) == lock["fits"][family]
        path = HERE/f"{family}.joblib"
        assert file_hash(path) == load(manifest)["model"]
        for version, bundle, data in (("immediate", joblib.load(path), x), ("old", old[family], previous)):
            key = f"{family}_{version}"
            raw = forecast(family, bundle["head"], data)
            forecasts[key] = calibrate(raw, frame.sign.to_numpy(), list(bundle["maps"].values()))
            quality[key] = forecast_quality(frame, raw)
            gate[key] = gate_diagnostics(frame, forecasts[key][:,0])
            plans[key] = (key, (100., *discounts))
            if version == "immediate":
                plans[key+"_entry_only"] = (key, (100., 0., 0.))
                plans[key+"_selected"] = (key, (bundle["size"], *discounts))
    plans["cash"] = ("ridge_old", (0., 0., 0.))
    tape, ids = Tape(frame), np.arange(len(frame))
    results, checked = {}, 0
    with gzip.open(HERE/"trade-ledgers.jsonl.gz", "wt") as output:
        for mode in MODES:
            results[mode] = {}
            for key, (model, action) in plans.items():
                r, trades, _ = replay(tape, ids, forecasts[model], mode, action, TEST_START, MARK_STOP, export=True)
                results[mode][key] = r
                for trade in trades:
                    assert trade["utility_bps"] > GATE
                    assert trade["gross_at_order"]+trade["size"]*(1+FEE) <= trade["equity_at_order"]+1e-8
                    if trade["net"] is not None:
                        net = trade["sign"]*trade["qty"]*(trade["sold"]-trade["paid"])-trade["fees"]+trade["funding"]
                        np.testing.assert_allclose(net, trade["net"], atol=1e-8)
                        checked += 1
                    output.write(json.dumps(dict(mode=mode, policy=key, **trade), allow_nan=False)+"\n")
                print(mode, key, r["trades"], r["net"], flush=True)
    write_json(HERE/"results.json", dict(lock=file_hash(LOCK), entries=[iso(TEST_START), iso(TEST_STOP)],
              valuation=iso(MARK_STOP), candidates=len(frame), gate=gate, raw_quality=quality, modes=results,
              priced_trades_checked=checked, ledger=file_hash(HERE/"trade-ledgers.jsonl.gz")))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=(*FAMILIES, "seal", "backtest"))
    command = parser.parse_args().command
    if command in FAMILIES:
        train(command)
    elif command == "seal":
        seal()
    else:
        compare()
