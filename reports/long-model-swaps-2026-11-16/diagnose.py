"""Swap one long-side component at a time using the archived model and policy snapshots."""

import concurrent.futures
import itertools
import multiprocessing
import sys
from pathlib import Path

REPORTS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPORTS / "mixed-feature-replay-2026-11-16"))
import replay as mixed


BASELINE = mixed.BASELINE
SPOT_ENTRY = "long_entry_core_plus_spot"
DERIVATIVES_REMOVED_ENTRY = "long_entry_full_minus_derivatives"
SCENARIOS = {
    BASELINE: (BASELINE, BASELINE, BASELINE),
    "core_plus_spot_entry_only": (SPOT_ENTRY, BASELINE, BASELINE),
    "full_minus_derivatives_entry_only": (DERIVATIVES_REMOVED_ENTRY, BASELINE, BASELINE),
    "position_history_exit_only": (BASELINE, SPOT_ENTRY, BASELINE),
    "core_plus_spot_mix_thresholds_only": (BASELINE, BASELINE, SPOT_ENTRY),
    "full_minus_derivatives_mix_thresholds_only": (BASELINE, BASELINE, DERIVATIVES_REMOVED_ENTRY),
    "core_plus_spot_mix_long_side": (SPOT_ENTRY, SPOT_ENTRY, SPOT_ENTRY),
    "full_minus_derivatives_mix_long_side": (
        DERIVATIVES_REMOVED_ENTRY, DERIVATIVES_REMOVED_ENTRY, DERIVATIVES_REMOVED_ENTRY,
    ),
}
OUTPUT = mixed.CACHE.parent / Path(__file__).resolve().parent.name


def run(task):
    plan, seed, snapshots = task
    fold = plan["start"]
    start, end = mixed.ms(fold), mixed.ms(plan["end"])
    data = mixed.DATA
    runs = []
    with mixed.threadpool_limits(limits=1):
        models = {}
        for name, snapshot in snapshots.items():
            weights, details = mixed.load_models(mixed.MODEL_SOURCES[name], seed, fold)
            assert details == snapshot["models"], (fold, seed, name)
            models[name] = weights
        assert snapshots[SPOT_ENTRY]["models"]["long_exit"] == snapshots[DERIVATIVES_REMOVED_ENTRY]["models"]["long_exit"]

        baseline = snapshots[BASELINE]
        short_policy = baseline["policies"]["short"]
        short_predictions = mixed.prepare(
            data,
            {
                "long": {"untrained": True},
                "short": {"untrained": True} if short_policy["cash"] else models[BASELINE]["short"],
            },
            start,
            end,
            {"short": [short_policy["exit_threshold"]]},
        )
        long_predictions = {}
        for name, (entry_source, exit_source, policy_source) in SCENARIOS.items():
            long_policy = snapshots[policy_source]["policies"]["long"]
            policies = {"long": long_policy, "short": short_policy}
            prepared = short_predictions
            if not long_policy["cash"]:
                key = (entry_source, exit_source)
                if key not in long_predictions:
                    long_predictions[key] = mixed.prepare(
                        data,
                        {
                            "long": {
                                "entry": models[entry_source]["long"]["entry"],
                                "exit": models[exit_source]["long"]["exit"],
                            },
                            "short": {"untrained": True},
                        },
                        start,
                        end,
                    )
                prepared = {**short_predictions, **long_predictions[key]}
            trades, meta = mixed.replay(data, prepared, policies, fold, name)
            stats = {**mixed.totals(trades), **meta}
            by_side = {side: mixed.totals([r for r in trades if r["side"] == side]) for side in mixed.SIDES}
            assert not long_policy["cash"] or by_side["long"]["trades"] == 0
            if name == BASELINE:
                archived = mixed.archived_run(BASELINE, seed, fold)
                assert (policies, stats, trades) == (archived["policies"], archived["test"], archived["trades"]), (seed, fold)
            runs.append({
                "variant": name, "seed": seed, "fold": fold, "end": plan["end"],
                "policies": policies, "test": stats, "by_side": by_side, "trades": trades,
                "weights": {
                    "long_entry": snapshots[entry_source]["models"]["long_entry"],
                    "long_exit": snapshots[exit_source]["models"]["long_exit"],
                    "short_entry": baseline["models"]["short_entry"],
                    "short_exit": baseline["models"]["short_exit"],
                },
            })
    return runs


def subtract(left, right):
    return left - right if left is not None and right is not None else None


def compare(runs, original, seeds, folds):
    records = {(r["seed"], r["fold"], r["variant"]): r for r in runs}
    original_long = {}
    for seed, source in itertools.product(seeds, (SPOT_ENTRY, DERIVATIVES_REMOVED_ENTRY)):
        original_long[seed, source] = mixed.totals([
            trade for fold in folds for trade in original[seed, fold, source]["trades"]
            if trade["side"] == "long"
        ])
    comparisons = []
    for seed in seeds:
        baseline = mixed.totals([
            trade for fold in folds for trade in records[seed, fold, BASELINE]["trades"]
            if trade["side"] == "long"
        ])
        for name, (_, _, policy_source) in SCENARIOS.items():
            selected = [records[seed, fold, name] for fold in folds]
            longs = [t for r in selected for t in r["trades"] if t["side"] == "long"]
            stats = mixed.totals(longs)
            opens_where_baseline_cash = [
                trade for r in selected if records[seed, r["fold"], BASELINE]["policies"]["long"]["cash"]
                for trade in r["trades"] if trade["side"] == "long"
            ]
            result = {
                "seed": seed, "variant": name, "long": stats,
                "long_delta_vs_baseline_usd": subtract(stats["gross_pnl_usd"], baseline["gross_pnl_usd"]),
                "longs_where_baseline_was_in_cash": mixed.totals(opens_where_baseline_cash),
            }
            if name.endswith("_long_side"):
                original_stats = original_long[seed, policy_source]
                result["original_mix_long"] = original_stats
                result["long_delta_when_swapping_in_mixed_shorts_usd"] = subtract(
                    original_stats["gross_pnl_usd"], stats["gross_pnl_usd"],
                )
            comparisons.append(result)
    return comparisons


def main():
    frozen = mixed.read_json(mixed.SWEEP / "experiment-lock.json")
    assert mixed.lock() == frozen["files"]
    assert mixed.sha256(mixed.CACHE / "candidates.npy") == frozen["candidate_hash"]
    assert mixed.sha256(mixed.CACHE / "setups.npy") == frozen["setup_hash"]
    source = mixed.read_json(mixed.OUTPUT / "results.json")
    plans, seeds = source["fold_plan"], source["seeds"]
    assert plans == mixed.read_json(mixed.SWEEP / "fold-plan.json")
    assert seeds == mixed.read_json(mixed.SWEEP / "experiment.json")["seeds"]
    assert source["notional_usd"] == mixed.CFG["notional_usd"] == 100
    assert all(source[k] == 0 for k in ("fees", "funding_payments", "slippage"))
    original = {}
    for plan, seed, name in itertools.product(plans, seeds, mixed.MODEL_SOURCES):
        fold = plan["start"]
        filename = f"{name}__{seed}__{fold[:10]}.json"
        row = mixed.read_json(mixed.OUTPUT / "runs" / filename)
        assert (row["seed"], row["fold"], row["variant"]) == (seed, fold, name)
        original[seed, fold, name] = row
    tasks = [
        (plan, seed, {name: {
            "models": original[seed, plan["start"], name]["models"],
            "policies": original[seed, plan["start"], name]["policies"],
        } for name in mixed.MODEL_SOURCES})
        for plan, seed in itertools.product(plans, seeds)
    ]
    all_runs = []
    with concurrent.futures.ProcessPoolExecutor(
        max_workers=8, mp_context=multiprocessing.get_context("spawn"), initializer=mixed.initialize,
    ) as pool:
        futures = [pool.submit(run, task) for task in tasks]
        for future in concurrent.futures.as_completed(futures):
            batch = future.result()
            all_runs.extend(batch)
            print(f"{len(all_runs)}/{len(tasks) * len(SCENARIOS)} replays complete ({batch[0]['fold'][:10]}, {batch[0]['seed']})", flush=True)

    all_runs.sort(key=lambda r: (r["fold"], r["seed"], list(SCENARIOS).index(r["variant"])))
    priced = mixed.verify_payoffs(all_runs)
    assert priced == sum(run["test"]["priced"] for run in all_runs)
    folds = [plan["start"] for plan in plans]
    complete = [f for f in folds if not any(r["by_side"]["long"]["censored"] for r in all_runs if r["fold"] == f)]
    assert len(all_runs) == len(tasks) * len(SCENARIOS)
    summary = {
        "scenario_sources": {
            name: dict(zip(("long_entry", "long_exit", "long_policy"), sources))
            for name, sources in SCENARIOS.items()
        },
        "short_side_source": BASELINE,
        "fold_plan": plans, "seeds": seeds, "notional_usd": 100,
        "fees": 0, "funding_payments": 0, "slippage": 0,
        "baseline_replays_matched": sum(r["variant"] == BASELINE for r in all_runs),
        "native_payoffs_verified": priced,
        "all_windows": compare(all_runs, original, seeds, folds),
        "common_complete_long_windows": (
            {"included": complete, "excluded": [f for f in folds if f not in complete],
             "comparison": compare(all_runs, original, seeds, complete)}
            if complete and complete != folds else None
        ),
        "runs": [{k: v for k, v in r.items() if k != "trades"} for r in all_runs],
    }
    (OUTPUT / "runs").mkdir(parents=True, exist_ok=True)
    for row in all_runs:
        filename = f"{row['variant']}__{row['seed']}__{row['fold'][:10]}.json"
        mixed.write_json(OUTPUT / "runs" / filename, row)
    mixed.write_json(OUTPUT / "results.json", summary)
    print(f"Wrote {len(all_runs)} replays and verified {priced} priced trades at {OUTPUT}", flush=True)


if __name__ == "__main__":
    main()
