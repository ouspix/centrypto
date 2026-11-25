"""Evaluate the pooled entry ridge with the original side-specific exits and allocator."""
from collections import Counter, defaultdict
import csv
import gzip
import json

import joblib
import numpy as np

from config import CACHE, HERE, GATE, ROLES, SLOTS, NOTIONAL, file_hash, iso, load, save_json
from entry_policy import ENTRY_COLUMNS, joiner
from diagnostics import summary
from run_replay import key, markings, prepare, totals
from shared_direction_model import LOCK, MODEL, OUT, load_model, predict

POLICIES = ("shared", "shared_side_calibration")
REFERENCES = ("constant", "news", "relative_news", "news_90d", "availability")

def score_candidates(rows, model, lock):
    row_index = {(r["side"], r["symbol"], r["decision"], r["setup"]): key(r) for r in rows}
    assert len(row_index) == len(rows)
    signals = {arm: {} for arm in POLICIES}
    raw = {}
    news = joiner()
    for path in sorted((CACHE / "targets").glob("*.joblib")):
        assert file_hash(path) == lock["partitions"][path.name]
        pack = joblib.load(path)
        symbol = pack["symbol"]
        for side in ROLES:
            p = pack["sides"][side]["test"]
            at = p["decision"]
            if not len(at):
                continue
            x = p["x"]
            joined = news.join(at, np.full(len(at), symbol), x, ENTRY_COLUMNS)
            feats = np.column_stack([x, joined])
            keys = [row_index[side, symbol, time, f"{symbol}/{setup}"]
                    for time, setup in zip(at, p["setup"], strict=True)]
            raw_values, scores = predict(model, side, feats)
            _, by_side = predict(model, side, feats, calibration="by_side")
            assert np.isfinite(scores).all() and np.isfinite(by_side).all()
            raw.update(zip(keys, raw_values, strict=True))
            signals["shared"].update((k, (s, s)) for k, s in zip(keys, scores, strict=True))
            signals["shared_side_calibration"].update((k, (s, s)) for k, s in zip(keys, by_side, strict=True))
    assert len(raw) == len(rows)
    for arm in POLICIES:
        assert len(signals[arm]) == len(rows)
    return signals, raw

def forecast_diagnostics(rows, scores):
    out = {}
    for side in ROLES:
        subset = [r for r in rows if r["side"] == side]
        ranked = np.array([scores[key(r)][0] for r in subset])
        y = np.array([r["net"] * (10_000 / NOTIONAL) if r["net"] is not None else np.nan for r in subset])
        admitted = ranked > GATE
        valid = np.isfinite(y)
        out[side] = dict(eligible=len(y), admitted=int(admitted.sum()), distinct_scores=len(np.unique(ranked)),
            all=summary(ranked[valid], y[valid]), passed=summary(ranked[admitted & valid], y[admitted & valid]))
    return out

def write_predictions(rows, scores, raw, allocated):
    with gzip.open(OUT / "predictions.csv.gz", "wt", newline="") as fp:
        w = csv.writer(fp)
        w.writerow(["decision_utc", "symbol", "direction", "candidate_id", "setup",
                    "raw_net_bps", "pooled_expected_net_bps", "direction_calibrated_net_bps",
                    "pooled_passes_15_bps", "direction_calibrated_passes_15_bps", "allocated_in_pooled_combined_base"])
        for r in sorted(rows, key=lambda row: (row["decision"], row["side"], row["id"])):
            k = key(r)
            value = scores["shared"][k][0]
            side_value = scores["shared_side_calibration"][k][0]
            w.writerow([iso(r["decision"]), r["symbol"], r["side"], r["id"], r["setup"],
                        raw[k], value, side_value, int(value > GATE), int(side_value > GATE), int(k in allocated)])

def verify_ledgers(results):
    pnl = defaultdict(float)
    counts = Counter()
    with gzip.open(OUT / "trade-ledgers.jsonl.gz", "rt") as fp:
        for line in fp:
            r = json.loads(line)
            scope, arm = r["policy"].split("/", 1)
            assert scope == "combined" or scope == r["side"]
            assert r["score"] > GATE
            k = scope, r["execution"], arm
            counts[k] += 1
            if r["status"] == "priced":
                sign = ROLES[r["side"]][0]
                funding = sum(v for _, v, _ in r["funding_flows"])
                value = sign * r["qty"] * (r["sold"] - r["paid"]) + funding - r["fees"]
                np.testing.assert_allclose(value, r["net"], atol=1e-8)
                pnl[k] += value
    for (scope, mode, program), n in counts.items():
        metrics = results[scope][mode][program]
        assert n == metrics["trades"]
        if metrics["net"] is not None:
            np.testing.assert_allclose(pnl[scope, mode, program], metrics["net"], atol=1e-8)
    return int(sum(counts.values()))

def run():
    model = load_model()
    lock = load(LOCK)
    combined = load(HERE / "results.json")
    solo = load(HERE / "side-only/results.json")
    assert file_hash(HERE / "verification.json") == lock["source_lock_sha256"]
    receipt = load(HERE / "verification.json")
    assert file_hash(HERE / "results.json") == receipt["manifests"]["results.json"]
    assert file_hash(HERE / "results.json") == solo["combined_results_sha256"]
    assert combined["exit_sha256"] == solo["exit_sha256"] == lock["exit_sha256"]
    assert combined["entry_sha256"] == solo["entry_sha256"]
    by_mode, markets, reference_scores, _ = prepare()
    base = by_mode["base"]
    scores, raw = score_candidates(base, model, lock)
    diagnostics = {arm: forecast_diagnostics(base, sc) for arm, sc in
                   (("news", reference_scores["news"]), *scores.items())}
    carry, index = markings(markets)
    results = {}
    predicted_fills = set()
    with gzip.open(OUT / "trade-ledgers.jsonl.gz", "wt") as trade_log, (OUT / "daily-equity.csv").open("w", newline="") as fp:
        writer = csv.writer(fp)
        writer.writerow(["utc_date", "scope", "execution", "policy", "marked_net_change_usd", "equity_usd"])
        for scope in ("combined", *ROLES):
            results[scope] = {}
            for mode, rows in by_mode.items():
                rr = rows if scope == "combined" else [r for r in rows if r["side"] == scope]
                comparison = combined["modes"][mode] if scope == "combined" else solo["sides"][scope][mode]
                if scope == "combined" and mode == "base":
                    tied, _ = totals(rr, "news", reference_scores["news"], markets, carry, index, [], None)
                    np.testing.assert_allclose([tied[k] for k in ("net", "full_drawdown", "trades")],
                                              [comparison["news"][k] for k in ("net", "full_drawdown", "trades")], atol=1e-8)
                metrics = {arm: comparison[arm] for arm in REFERENCES}
                for arm, sc in scores.items():
                    daily = []
                    stats, picked = totals(rr, f"{scope}/{arm}", sc, markets, carry, index, daily, trade_log)
                    writer.writerows([d, scope, mode, name.split("/")[1], *rest] for d, name, *rest in daily)
                    metrics[arm] = stats
                    if scope == "combined" and mode == "base" and arm == "shared":
                        predicted_fills = picked
                    print(scope, mode, arm, stats["trades"], stats["net"], stats["qualifying"], flush=True)
                results[scope][mode] = metrics
    write_predictions(base, scores, raw, predicted_fills)
    checked = verify_ledgers(results)
    save_json(OUT / "results.json", dict(entry_window=combined["entry_window"], valuation_at=combined["valuation_at"],
        settings=dict(hurdle_bps=GATE, slots=SLOTS, notional_usd=NOTIONAL), candidates=combined["decisions_by_side"],
        model_sha256=file_hash(MODEL), exit_sha256=lock["exit_sha256"], forecast_diagnostics=diagnostics, scopes=results,
        verification=dict(repriced_trade_records=checked, separate_combined_news_reproduced=True,
            predictions_sha256=file_hash(OUT / "predictions.csv.gz"), ledgers_sha256=file_hash(OUT / "trade-ledgers.jsonl.gz"))))

if __name__ == "__main__":
    run()
