"""Compare signed-direction ridge inputs and constant controls on the original replay."""
from collections import Counter, defaultdict
from pathlib import Path
import csv
import gzip
import json
import sqlite3
import sys

import joblib
import numpy as np
from sklearn.base import clone

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import CACHE, DAY, GATE, MARK_STOP, MINUTE, RISK_SEEDS, ROLES, SLOTS, TAIL_START, file_hash, iso
from diagnostics import coefficients
from entry_policy import ENTRY_COLUMNS, joiner
from features import AVAIL
from portfolio import allocate
from run_replay import prepare, stable_tie
from shared_direction_model import LOCK, MODEL, OUT, load_model
from source_data import DB, TAIL


def datasets(lock):
    news = joiner()
    chunks = defaultdict(list)
    for path in sorted((CACHE / "targets").glob("*.joblib")):
        assert file_hash(path) == lock["partitions"][path.name]
        part = joblib.load(path)
        for side, stages in part["sides"].items():
            for stage, p in stages.items():
                keep = np.ones(len(p["y"]), dtype=bool) if stage == "test" else np.isfinite(p["y"])
                t, y, market = p["decision"][keep], p["y"][keep], p["x"][keep]
                if not len(t):
                    continue
                names = np.full(len(t), part["symbol"])
                stories = news.join(t, names, market, ENTRY_COLUMNS)
                direction = np.full(len(t), ROLES[side][0])
                x = np.column_stack((market, stories, direction))
                chunks[stage].append((x, y, t, names, direction, p["setup"][keep]))
    return {k: tuple(np.concatenate(v) for v in zip(*parts)) for k, parts in chunks.items()}


def dated_news(data):
    x, _, times, names, _, _ = data
    days = times // DAY
    asset = x[:, len(ENTRY_COLUMNS) + AVAIL.index("processed_asset_4h")].astype(bool)
    available = x[:, len(ENTRY_COLUMNS) + AVAIL.index("recent_archive")].astype(bool)
    return dict(rows=len(x), days=int(len(np.unique(days))), asset_mentions=int(asset.sum()),
                recent_archive=int(available.sum()), by_asset={str(name): [int((names == name).sum()),
                    int(asset[names == name].sum())] for name in np.unique(names)}, daily={
                    iso(int(d * DAY))[:10]: [int((days == d).sum()), int(asset[days == d].sum()),
                                              int(available[days == d].sum())] for d in np.unique(days)})


def scores(bundle, data, cutoff):
    train_x, train_y, *_ = data["train"]
    x_cal, y_cal, _, _, cal_side, _ = data["cal"]
    x_test, y_test, _, _, test_side, _ = data["test"]
    cols = list(range(cutoff)) + [-1]
    estimator = clone(bundle["estimator"]).fit(train_x[:, cols], train_y)
    raw_cal = estimator.predict(x_cal[:, cols])
    raw_test = estimator.predict(x_test[:, cols])
    cal = {}
    values = {}
    for name, sign in (("pooled", 0), ("long", 1), ("short", -1)):
        mask = cal_side == sign if sign else np.ones(len(y_cal), dtype=bool)
        fit = coefficients(raw_cal[mask], y_cal[mask])
        cal[name] = {k: fit[k] for k in ("slope", "intercept", "raw_target_correlation")}
        values[name] = fit["intercept"] + fit["slope"] * raw_test
    by_side = np.where(test_side == 1, values["long"], values["short"])
    raw_diagnostics = {}
    for side, (sign, *_) in ROLES.items():
        mask = (test_side == sign) & np.isfinite(y_test)
        r, y = raw_test[mask], y_test[mask]
        lo, hi = np.quantile(r, [.1, .9])
        raw_diagnostics[side] = dict(correlation=float(np.corrcoef(r, y)[0, 1]),
                                     lowest_decile_bps=float(y[r <= lo].mean()),
                                     highest_decile_bps=float(y[r >= hi].mean()))
    return raw_test, values["pooled"], by_side, cal, raw_diagnostics


def ranked_replay(rows, value, index, seed=None):
    candidates = []
    for row in rows:
        score = value[index[row["id"]]]
        priority = score if seed is None else stable_tie(row, seed)
        if score > GATE:
            candidates.append((row, priority, -np.inf))
    chosen, _ = allocate(candidates, SLOTS, MARK_STOP)
    pnl = sum(r["net"] for r in chosen) if all(r["status"] == "priced" for r in chosen) else None
    by_side = {side: sum(r["net"] for r in chosen if r["side"] == side) for side in ROLES} if pnl is not None else None
    return dict(trades=len(chosen), sides=dict(Counter(r["side"] for r in chosen)),
                net=pnl, net_by_side=by_side), {r["id"] for r in chosen}


def receipt_check(rows, allocated):
    # This checks the final minute used in each candidate's last completed five-minute bar.
    tail = joblib.load(TAIL)
    select = """SELECT received_at, recorded_at, o, h, l, c, v FROM candle_observation
                WHERE symbol=? AND open_at=? AND received_at<=? AND recorded_at<=?
                ORDER BY received_at, recorded_at, id"""
    counts = Counter()
    mismatches = []
    with sqlite3.connect(DB.as_uri() + "?mode=ro", uri=True) as db:
        db.execute("BEGIN")
        for row in rows:
            decision = row["decision"]
            bar = decision - MINUTE - 5000
            if bar < TAIL_START:
                continue
            sym = row["symbol"]
            expected = tail[sym][np.searchsorted(tail[sym][:, 0], bar)]
            assert expected[0] == bar
            observations = db.execute(select, (sym, bar, decision, decision)).fetchall()
            matches = [v for v in observations if np.allclose(v[2:], expected[1:], rtol=1e-10, atol=1e-10)]
            counts["candidates"] += 1
            counts["allocated"] += row["id"] in allocated
            counts["matched_as_of"] += bool(matches)
            counts["matched_with_postclose_receipt"] += any(v[0] >= bar + MINUTE for v in matches)
            if not matches:
                mismatches.append(dict(id=row["id"], symbol=sym, decision=iso(decision), allocated=row["id"] in allocated,
                                       frozen_close=float(expected[4]), frozen_volume=float(expected[5]),
                                       latest_timely_observation=observations[-1] if observations else None))
    return dict(counts=counts, mismatches=mismatches)


def main():
    bundle = load_model()
    lock = json.loads(LOCK.read_text())
    data = datasets(lock)
    print("Loaded matched features and labels", flush=True)
    test_x, _, times, symbols, directions, setups = data["test"]
    lookup = {(int(t), symbol, "long" if sign == 1 else "short", f"{symbol}/{setup}"): i
              for i, (t, symbol, sign, setup) in enumerate(zip(times, symbols, directions, setups))}
    assert len(lookup) == len(test_x)
    rows, *_ = prepare()
    index = {r["id"]: lookup[r["decision"], r["symbol"], r["side"], r["setup"]] for r in rows["base"]}
    assert len(index) == len(lookup)
    published = {}
    with gzip.open(OUT / "trade-ledgers.jsonl.gz", "rt") as fp:
        for line in fp:
            r = json.loads(line)
            if r["policy"].startswith("combined/"):
                published.setdefault((r["execution"], r["policy"]), set()).add(r["id"])
    out = dict(model_sha256=file_hash(MODEL), source_lock_sha256=file_hash(LOCK),
               daily_news_columns=["candidates", "four_hour_asset_match", "archive_in_last_hour"],
               coverage={stage: dated_news(x) for stage, x in data.items()}, fits={}, seeded_pooled_constant={})
    x_cal, y_cal, cal_times, cal_syms, cal_sign, cal_setups = data["cal"]
    days = cal_times // DAY
    raw_cal = bundle["estimator"].predict(x_cal)
    raw_test = bundle["estimator"].predict(test_x)
    out["calibration_episodes"] = len(set(zip(cal_syms, cal_sign, cal_setups)))
    out["calibration_day_influence"] = {}
    for day in np.unique(days):
        keep = days != day
        fit = coefficients(raw_cal[keep], y_cal[keep])
        passes = (fit["intercept"] + fit["slope"] * raw_test) > GATE
        out["calibration_day_influence"][iso(int(day * DAY))[:10]] = dict(
            rows=int((~keep).sum()), mean_bps=float(y_cal[~keep].mean()),
            slope_without=fit["slope"], intercept_without=fit["intercept"],
            passes_without=int(passes.sum()))
    for name, cutoff in (("market", len(ENTRY_COLUMNS)), ("availability", len(ENTRY_COLUMNS) + len(AVAIL)),
                         ("content", test_x.shape[1] - 1)):
        raw, pooled, sided, calibration, diagnostics = scores(bundle, data, cutoff)
        if name == "content":
            with gzip.open(OUT / "predictions.csv.gz", "rt") as fp:
                preds = list(csv.DictReader(fp))
            assert len(preds) == len(index) == len({int(r["candidate_id"]) for r in preds})
            for r in preds:
                i = index[int(r["candidate_id"])]
                assert (r["decision_utc"], r["symbol"], r["direction"]) == (
                    iso(int(times[i])), symbols[i], "long" if directions[i] == 1 else "short")
            for arr, col in ((raw, "raw_net_bps"), (pooled, "pooled_expected_net_bps"),
                             (sided, "direction_calibrated_net_bps")):
                ixs = [index[int(r["candidate_id"])] for r in preds]
                np.testing.assert_allclose(arr[ixs], [float(r[col]) for r in preds], atol=1e-8, rtol=1e-11)
        arms = {}
        for arm, value in (("pooled", pooled), ("by_side", sided)):
            expected = "combined/shared" if arm == "pooled" else "combined/shared_side_calibration"
            arms[arm] = dict(passing={s: int(((directions == k[0]) & (value > GATE)).sum())
                                      for s, k in ROLES.items()}, replay={})
            for mode, tape in rows.items():
                result, ids = ranked_replay(tape, value, index)
                if name == "content":
                    assert ids == published[mode, expected]
                arms[arm]["replay"][mode] = result
        out["fits"][name] = dict(calibration=calibration, holdout_raw=diagnostics, arms=arms)
    constant = np.full(len(times), data["cal"][1].mean())
    for mode, tape in rows.items():
        reference, ids = ranked_replay(tape, constant, index)
        assert ids == published[mode, "combined/shared"]
        out.setdefault("pooled_constant", {})[mode] = reference
        out["seeded_pooled_constant"][mode] = {
            s: ranked_replay(tape, constant, index, s)[0] for s in RISK_SEEDS}
    out["local_last_minute_receipts"] = receipt_check(rows["base"], published["base", "combined/shared"])
    target = OUT / "review-controls.json"
    target.with_suffix(".tmp").write_text(json.dumps(out, indent=2, allow_nan=False) + "\n")
    target.with_suffix(".tmp").replace(target)
    print("Verified the original predictions and compared market, availability, content and constant policies.")


if __name__ == "__main__":
    main()
