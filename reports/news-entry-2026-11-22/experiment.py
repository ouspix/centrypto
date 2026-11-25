"""Train paired news entry models and replay the frozen November policy."""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
import gzip
import json
import multiprocessing
from pathlib import Path
from statistics import median
import sys

import joblib
import numpy as np

HERE = Path(__file__).resolve().parent
INDICATORS = HERE.parent / "sma-rsi-bb-optimization-2026-11-21"
sys.path.insert(0, str(INDICATORS))

from train import CONFIGS, FOLD, PLAN, SOURCE, CausalData, file_hash, load_bank
from train import member_path, save_json, threadpool_limits
from economics import summarize
from exit_experiment import EXIT_THRESHOLD, inputs, reconcile
from exit_period_search import make_evaluation
from indicators import augment, build_bank
from november_gap_backfill import OUTPUT as RECOVERY
from optimize import SEEDS, SIDES
from price_network import predict
from repair_common import CACHE as REPAIR_CACHE
from repair_replay import exit_predictions_all, models_for
from rerun_backfilled_exits import RecoveredFunding

from news_inputs import AVAILABILITY, CONTENT, FeatureBank, NewsHistory, ms
from news_training import fit_entry

CACHE = HERE.parents[1] / "data/research/centrypto" / HERE.name
SNAPSHOT = CACHE / "news-snapshot.json.gz"
MANIFEST = CACHE / "news-source.json"
LOCK = CACHE / "training-lock.json"
ARMS = {"coverage_only": (101, AVAILABILITY), "news": (102, AVAILABILITY + CONTENT)}


def read_json(path):
    return json.loads(path.read_text())


def old_exit_path(side, seed):
    return REPAIR_CACHE / "models" / FOLD / f"{side}_exit_{seed}.joblib"


def training_lock(choices):
    manifest = read_json(MANIFEST)
    assert manifest["sha256"] == file_hash(SNAPSHOT)
    paths = list(HERE.glob("*.py")) + [
        INDICATORS / name for name in ("plan.json", "snapshot-hashes.json",
                                        "third-backtest-matched-rsi-bb.json")
    ] + [MANIFEST, RECOVERY, SNAPSHOT, HERE / "capture_news.cjs"]
    for side, choice in zip(SIDES, choices):
        spec = CONFIGS[choice["config"]]
        paths.extend(SOURCE / side / name for name in ("schema.json", "train.joblib", "validation.joblib"))
        from train import bank_path
        paths.extend(bank_path(kind, period) for kind, period in zip(("rsi", "bb"), spec) if period is not None)
        for seed in SEEDS:
            paths.extend((member_path(choice["config"], side, seed), old_exit_path(side, seed)))
    return {str(p): file_hash(p) for p in sorted(set(paths))}


def history_for(data):
    with gzip.open(SNAPSHOT, "rt") as stream:
        snapshot = json.load(stream)
    return NewsHistory(snapshot, {cat["symbol"] for cat in data.d.catalog})


def profile(features, events):
    return dict(rows=len(features), feed_observed=int(features[:, 0].sum()),
                analysis_observed=int(features[:, 1].sum()),
                both_observed=int((features[:, :2] == 1).all(axis=1).sum()),
                rows_with_asset_events=sum(bool(asset) for asset, _ in events),
                rows_with_market_events=sum(bool(market) for _, market in events),
                unique_asset_events=len({key for asset, _ in events for key in asset}),
                unique_market_events=len({key for _, market in events for key in market}))


def work(task):
    arm, side, config, seed, packs, names = task
    baseline = joblib.load(member_path(config, side, seed))
    take = len(ARMS[arm][1])
    prepared = {}
    for part, (original, market, news) in packs.items():
        prepared[part] = dict(original, raw=np.column_stack([market, news[:, :take]]))
    assert baseline["input_names"] == names
    model = fit_entry(prepared["train"], prepared["validation"], baseline, ARMS[arm][1])
    print(f"Trained {arm} {side} seed {seed}", flush=True)
    return arm, side, model


def train(choices, sources):
    if LOCK.exists():
        if read_json(LOCK) != sources:
            raise ValueError("Training inputs changed. Use a new run directory.")
    else:
        save_json(LOCK, sources)
    data = CausalData()
    history = history_for(data)
    bank = FeatureBank(data, history)
    coverage = {}
    tasks = []
    for side, choice in zip(SIDES, choices):
        spec = CONFIGS[choice["config"]]
        indicators = load_bank([spec])
        names = read_json(SOURCE / side / "schema.json")["names"]
        packs = {}
        coverage[side] = {}
        for part in ("train", "validation"):
            pack = joblib.load(SOURCE / side / f"{part}.joblib", mmap_mode="r")
            ids = pack["ids"]
            np.testing.assert_array_equal(pack["rows"], data.c["row"][ids])
            np.testing.assert_array_equal(pack["raw"], data.entry_rows(ids))
            cutoff = PLAN["validation_start"] if part == "train" else f"{FOLD}T00:00:00Z"
            assert int(data.completion[ids].max()) + 86_400_000 < ms(cutoff)
            market, extras = augment(pack["raw"], indicators, ids, spec)
            features, events = bank.inputs(ids, pack["raw"])
            packs[part] = (pack, market, features)
            coverage[side][part] = dict(profile(features, events), episodes=len(pack["index"]))
        for arm in ARMS:
            tasks.extend((arm, side, choice["config"], seed, packs, names + extras) for seed in SEEDS)
    print(json.dumps({"training_coverage": coverage, "event_audit": history.audit}), flush=True)
    models = {arm: defaultdict(list) for arm in ARMS}
    with ProcessPoolExecutor(max_workers=6, mp_context=multiprocessing.get_context("fork")) as executor:
        for arm, side, model in executor.map(work, tasks):
            models[arm][side].append(model)
    exits = models_for(FOLD)
    artifacts = {}
    diagnostics = {}
    for arm, by_side in models.items():
        roles = {}
        diagnostics[arm] = {}
        for side, choice in zip(SIDES, choices):
            entries = by_side[side]
            assert [m["seed"] for m in entries] == SEEDS
            roles[side] = {
                "entry": {"members": entries},
                "exit": {"members": [m[side]["exit"] for m in exits]},
                "setting": choice,
            }
            diagnostics[arm][side] = [
                dict(seed=m["seed"], curve=m["curve"], features=m["news_preprocessing"]) for m in entries
            ]
        path = HERE / f"{arm}-four-models.joblib"
        tmp = path.with_suffix(".tmp")
        joblib.dump(dict(roles=roles, feature_names=ARMS[arm][1], exit_threshold=EXIT_THRESHOLD,
                         bar_minutes=5, max_holding_minutes=1440, research_only=True), tmp, compress=3)
        restored = joblib.load(tmp)
        for side in SIDES:
            _, market, features = next(t[4] for t in tasks if t[1] == side)["validation"]
            x = np.column_stack([market[:512], features[:512, :len(ARMS[arm][1])]])
            np.testing.assert_array_equal(predict(roles[side]["entry"], x),
                                          predict(restored["roles"][side]["entry"], x))
        tmp.replace(path)
        artifacts[arm] = dict(file=path.name, sha256=file_hash(path))
    save_json(HERE / "training.json", dict(news_source=read_json(MANIFEST), lock_sha256=file_hash(LOCK),
              event_audit=dict(history.audit), coverage=coverage, diagnostics=diagnostics, bundles=artifacts))


def stats(trades, days):
    return {
        "overall": summarize(trades, days),
        "by_side": {side: summarize([t for t in trades if t["side"] == side], days) for side in SIDES},
        "median_holding_minutes": median(t["holding_minutes"] for t in trades) if trades else None,
    }


def event_totals(trades, events):
    asset = defaultdict(list)
    for trade in trades:
        direct, _ = events[trade["candidate_id"]]
        for key in direct:
            asset[key].append(trade)
    top = []
    for key, matched in asset.items():
        rest = [t for t in trades if key not in events[t["candidate_id"]][0]]
        known_net = sum(t["net"] for t in matched if t["net"] is not None)
        top.append(dict(event_key=key, trades=len(matched), known_net=known_net,
                        net_excluding_overlapping_trades=sum(t["net"] for t in rest)
                        if all(t["net"] is not None for t in rest) else None))
    return dict(asset_event_trades=sum(bool(events[t["candidate_id"]][0]) for t in trades),
                market_event_trades=sum(bool(events[t["candidate_id"]][1]) for t in trades),
                asset_events=len(asset), top_asset_events=sorted(top, key=lambda r: -r["known_net"])[:5])


def compare(choices, saved, sources):
    from forward import ForwardData
    from train import CACHE as MARKET_CACHE
    for name, expected in read_json(INDICATORS / "snapshot-hashes.json").items():
        assert file_hash(MARKET_CACHE / "snapshots" / name) == expected
    assert sources == read_json(LOCK)
    audit = read_json(HERE / "training.json")
    bundles = {}
    for arm, manifest in audit["bundles"].items():
        path = HERE / manifest["file"]
        assert file_hash(path) == manifest["sha256"]
        bundles[arm] = joblib.load(path)
    data = ForwardData()
    evaluation = make_evaluation(data, PLAN["test_start"], PLAN["test_market_end"], choices)
    evaluation.costs = RecoveredFunding(data, read_json(RECOVERY))
    baseline = evaluation.ledger(choices)
    assert baseline == saved["trades"]["rsi_bb_entries"]
    print(f"Reproduced all {len(baseline)} baseline trades", flush=True)
    feature_bank = FeatureBank(data, history_for(data))
    specs = [CONFIGS[c["config"]] for c in choices]
    bank = build_bank(data, specs)
    exits = models_for(FOLD)
    evaluation_coverage = {}
    events_by_candidate = {}
    for side, sign, choice, spec in zip(SIDES, (1, -1), choices, specs):
        ids = evaluation.ids[side]
        raw = data.entry_rows(ids)
        market, extras = augment(raw, bank, ids, spec)
        news, events = feature_bank.inputs(ids, raw)
        events_by_candidate.update(zip(map(int, ids), events))
        pair = evaluation.pair_masks[side] == choice["pair"]
        evaluation_coverage[side] = profile(news[pair], [e for e, keep in zip(events, pair) if keep])
        baseline_scores = evaluation.scores[(side, choice["config"])]
        used = baseline_scores.max(axis=0) >= choice["threshold"]
        exit_members = [model[side]["exit"] for model in exits]
        for arm, (index, fields) in ARMS.items():
            roles = bundles[arm]["roles"][side]
            for member, frozen in zip(roles["exit"]["members"], exit_members):
                assert member["input_names"] == frozen["input_names"]
                for actual, expected in zip(member["model"].params, frozen["model"].params):
                    np.testing.assert_array_equal(actual, expected)
            x = np.column_stack([market, news[:, :len(fields)]])
            assert all(m["input_names"] == data.entry_names + extras + fields
                       for m in roles["entry"]["members"])
            seed_scores = np.array([predict(member, x) for member in roles["entry"]["members"]])
            evaluation.scores[(side, index)] = np.vstack([seed_scores, seed_scores.mean(axis=0)])
            used |= seed_scores.max(axis=0) >= choice["threshold"]
        rows = np.unique(data.c["row"][ids[used & pair]])
        evaluation.exits[side] = exit_predictions_all(data, exit_members, rows, sign, [EXIT_THRESHOLD], True)[-1]
    assert evaluation.ledger(choices) == baseline
    arms = {"no_news": choices} | {
        arm: [dict(choice, config=index) for choice in choices] for arm, (index, _) in ARMS.items()
    }
    trades = {arm: evaluation.ledger(policy) for arm, policy in arms.items()}
    verified = {arm: reconcile(rows) for arm, rows in trades.items()}
    assert all(verified[arm] == sum(t["net"] is not None for t in rows) for arm, rows in trades.items())
    comparison = {arm: stats(rows, evaluation.days) for arm, rows in trades.items()}
    for arm, rows in trades.items():
        for t in rows:
            if t["net"] is not None:
                np.testing.assert_allclose(t["net"], t["gross"] - t["fees"] - t["slippage"] - t["funding"],
                                           atol=1e-10, rtol=0)
        comparison[arm]["event_concentration"] = event_totals(rows, events_by_candidate)
        comparison[arm]["shared_baseline_entries"] = len(
            {t["candidate_id"] for t in rows} & {t["candidate_id"] for t in baseline})
        comparison[arm]["by_seed"] = {
            str(seed): stats(evaluation.ledger(arms[arm], index), evaluation.days)
            for index, seed in enumerate(SEEDS)
        }
        net = comparison[arm]["overall"]["net"]
        comparison[arm]["delta_vs_baseline"] = net - comparison["no_news"]["overall"]["net"] if net is not None else None
    result = dict(period=saved["period"], cost_model=saved["cost_model"], settings=saved["settings"],
                  baseline_exact=True, independently_priced_trades=verified, comparison=comparison,
                  test_news_coverage=evaluation_coverage, training_coverage=audit["coverage"],
                  training_sha256=file_hash(HERE / "training.json"), newly_used_funding_proxies={
                      arm: sorted(set(evaluation.costs.used_by(rows))) for arm, rows in trades.items()},
                  trades=trades, trade_news_events={arm: [
                      dict(candidate_id=t["candidate_id"], asset=events_by_candidate[t["candidate_id"]][0],
                           market=events_by_candidate[t["candidate_id"]][1]) for t in rows
                  ] for arm, rows in trades.items()},
                  holdout_status="Chronological test, previously examined in earlier experiments.")
    save_json(HERE / "comparison.json", result)
    print(json.dumps({arm: info["overall"] for arm, info in comparison.items()}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("train", "replay", "all"))
    stage = parser.parse_args().stage
    with threadpool_limits(limits=1):
        choices, saved = inputs()
        sources = training_lock(choices)
        if stage in ("train", "all"):
            train(choices, sources)
        if stage in ("replay", "all"):
            compare(choices, saved, sources)
