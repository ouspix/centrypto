"""Train paired entries, then freeze their bundle and the fresh test dates."""
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, time, timedelta, timezone
import json
import multiprocessing

import joblib
import numpy as np

from run_common import (
    BASE_CACHE, CACHE, CONFIGS, HERE, PARTS, PRIOR, PRIOR_CACHE, RECOVERY, SEEDS, SIDES, SOURCE,
    exit_path, file_hash, inputs, load, member_path, old_entries, old_exits, prepared, save_json,
)
from indicators import augment
from price_network import fit as fit_price, predict
from train import bank_path, load_bank, threadpool_limits
from value_network import fit_value

LABELS = CACHE / "labels.joblib"
LOCK = HERE / "experiment-lock.json"
BUNDLE = HERE / "net-value-models.joblib"


def matched_pack(pack, values):
    lookup = [values[int(row)] for row in pack["rows"]]
    net = np.array([outcome[0] if outcome[0] is not None else np.nan for outcome in lookup])
    missing = Counter(reason for _, reason in lookup if reason != "priced")
    index, mask = pack["index"], pack["mask"]
    finite = np.isfinite(net[index]) | ~mask
    keep = finite.all(axis=1)
    if not keep.any():
        raise ValueError("No fully priced episodes")
    retained = index[keep][mask[keep]]
    assert np.array_equal(retained, np.sort(np.unique(retained)))
    remapped = np.zeros_like(index[keep])
    remapped[mask[keep]] = np.arange(len(retained))
    matched = {key: pack[key][retained] for key in ("raw", "ids", "rows")}
    matched.update({key: pack[key][keep] for key in ("mask", "cost", "skip", "success", "groups")})
    matched.update(net=net[retained], index=remapped)
    np.testing.assert_array_equal(matched["rows"][matched["index"][matched["mask"]]], pack["rows"][retained])
    summary = dict(original_episodes=len(index), retained_episodes=int(keep.sum()), original_rows=len(net),
                   retained_rows=len(retained), unpriced_candidate_reasons=dict(missing),
                   mean_target_usd=float(net[retained].mean()))
    return matched, summary


def train_one(task):
    arm, side, seed, packs, names = task
    if arm == "net_value":
        model = fit_value(packs["train"], packs["validation"], names, seed, side)
    else:
        model, _ = fit_price(packs["train"], packs["validation"], names, seed, side)
    print(f"Trained {arm} {side} seed {seed}", flush=True)
    return arm, side, model


def training_sources(choices):
    paths = [LABELS, RECOVERY, PRIOR / "plan.json", PRIOR / "selection.json",
             PRIOR / "snapshot-hashes.json", PRIOR / "third-backtest-matched-rsi-bb.json"]
    paths.extend(HERE.glob("*.py"))
    paths.extend((CACHE / "funding").glob("*.json"))
    paths.extend((PRIOR_CACHE / "snapshots").glob("*.json.gz"))
    paths.extend((BASE_CACHE / "candles").glob("*/*.json.gz"))
    paths.append(BASE_CACHE / "market.npy")
    rebuilt = BASE_CACHE.parent / "two-stage-rebuild-2026-11-14"
    paths.extend(rebuilt / name for name in ("state.npy", "sma.npy"))
    for kind in ("market", "spot"):
        paths.extend((BASE_CACHE.parent / "rally-signals-2026-11-17" / kind).glob("*.json.gz"))
    for side, choice in zip(SIDES, choices):
        paths.extend(SOURCE / side / name for name in ("schema.json", "train.joblib", "validation.joblib"))
        paths.extend(bank_path(kind, period)
                     for kind, period in zip(("rsi", "bb"), CONFIGS[choice["config"]]) if period is not None)
        for seed in SEEDS:
            paths.extend((member_path(choice["config"], side, seed), exit_path(side, seed)))
    return {str(path): file_hash(path) for path in sorted(paths)}


def freeze(choices):
    if LOCK.exists():
        raise FileExistsError("The experiment is frozen. Run a replay stage against the existing lock.")
    sources = training_sources(choices)
    artifact = joblib.load(LABELS)
    coverage = {}
    reference = {}
    models = defaultdict(lambda: defaultdict(list))
    tasks = []
    for side, choice in zip(SIDES, choices):
        config = CONFIGS[choice["config"]]
        bank = load_bank([config])
        names = load(SOURCE / side / "schema.json")["names"]
        coverage[side] = {}
        packs = {}
        for part in PARTS:
            pack, summary = matched_pack(prepared(side, part), artifact["labels"][side])
            pack["raw"], extra = augment(pack["raw"], bank, pack["ids"], config)
            packs[part] = pack
            coverage[side][part] = summary
        old = old_entries(side, choice)
        assert all(member["input_names"] == names + extra for member in old)
        models["saved_price_error"][side] = old
        reference[side] = packs["validation"]["raw"][:512]
        tasks.extend(("net_value", side, seed, packs, names + extra) for seed in SEEDS)
        counts = coverage[side]["train"]
        if counts["retained_rows"] != counts["original_rows"]:
            tasks.extend(("matched_price_error", side, seed, packs, names + extra) for seed in SEEDS)
        else:
            models["matched_price_error"][side] = old
    print(json.dumps({"training_coverage": coverage, "label_audit": artifact["audit"]}), flush=True)
    with ProcessPoolExecutor(max_workers=6, mp_context=multiprocessing.get_context("fork")) as pool:
        for arm, side, model in pool.map(train_one, tasks):
            models[arm][side].append(model)
    payload = dict(
        entries={arm: dict(members) for arm, members in models.items()},
        exits={side: old_exits(side) for side in SIDES},
        exit_threshold=.5, choices=choices, seeds=SEEDS,
        research_only=True, bar_minutes=5, max_holding_minutes=1440,
    )
    temp = BUNDLE.with_suffix(".tmp")
    joblib.dump(payload, temp, compress=3)
    restored = joblib.load(temp)
    for arm, sides in payload["entries"].items():
        for side, members in sides.items():
            assert [member["seed"] for member in members] == SEEDS
            np.testing.assert_array_equal(predict({"members": members}, reference[side]),
                                          predict({"members": restored["entries"][arm][side]}, reference[side]))
    temp.replace(BUNDLE)
    assert training_sources(choices) == sources
    frozen_at = datetime.now(timezone.utc)
    start = datetime.combine(frozen_at.date() + timedelta(days=1), time(), timezone.utc)
    entry_end = start + timedelta(days=7)
    market_end = entry_end + timedelta(hours=25)
    lock = dict(
        frozen_at=frozen_at.isoformat(),
        fresh=dict(test_start=start.isoformat(), test_entry_end=entry_end.isoformat(),
                   test_market_end=market_end.isoformat()),
        hashes=sources, bundle_sha256=file_hash(BUNDLE),
        choices=choices, exit_threshold=.5, label_audit=artifact["audit"], coverage=coverage,
        training_curves={a: {s: [m["curve"] for m in members] for s, members in sides.items()}
                         for a, sides in payload["entries"].items()},
    )
    save_json(LOCK, lock)
    print(json.dumps({"frozen_at": lock["frozen_at"], "fresh": lock["fresh"]}), flush=True)


if __name__ == "__main__":
    with threadpool_limits(limits=1):
        choices, _ = inputs()
        freeze(choices)
