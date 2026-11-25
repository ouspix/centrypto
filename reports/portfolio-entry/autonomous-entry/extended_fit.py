"""Run a fixed update budget and keep the previously frozen experiment intact."""
import argparse
import importlib.util
import json

import joblib

from autonomous_data import BEGIN, HERE, VALIDATION, Dataset
from autonomous_replay import Market
from settings import MARK_STOP, TEST_START, TEST_STOP, file_hash, iso, save_json
from verify_autonomous import verify_ledger

spec = importlib.util.spec_from_file_location("centrypto_autonomous_experiment", HERE / "experiment.py")
experiment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(experiment)


def main(steps, development):
    output = HERE / f"iterations-{steps}"
    output.mkdir(exist_ok=True)
    name = "validation" if development else "backtest"
    if (output / f"{name}.json").exists():
        raise FileExistsError(output / f"{name}.json")
    dataset, market = Dataset(), Market()
    cutoff = VALIDATION if development else TEST_START
    train_manifest = output / ("development-fit.json" if development else "fit.json")
    model_file = output / ("development.joblib" if development else "main.joblib")
    sources = experiment.provenance()
    sources["autonomous-entry/extended_fit.py"] = file_hash(__file__)
    if train_manifest.exists():
        manifest = json.loads(train_manifest.read_text())
        assert manifest["provenance"] == sources and file_hash(model_file) == manifest["model"]
        model = joblib.load(model_file)
    else:
        model, records, training = experiment.fit(dataset, market, BEGIN, cutoff, steps)
        assert len(records) == steps
        training_file = output / f"{model_file.stem}-training-trades.jsonl.gz"
        experiment.export_ledger(training_file, [(f"training_draw_{i + 1}", books) for i, books in enumerate(training)])
        temp = model_file.with_suffix(".partial")
        joblib.dump(model, temp, compress=3)
        temp.replace(model_file)
        save_json(train_manifest, dict(
            iterations=steps, begin=iso(BEGIN), cutoff=iso(cutoff), provenance=sources,
            model=file_hash(model_file), ledger=file_hash(training_file), records=records,
        ))
    start, end, mark = (VALIDATION, TEST_START, TEST_START) if development else (TEST_START, TEST_STOP, MARK_STOP)
    metrics, ledgers = experiment.evaluate(dataset, market, model["parameters"], model["scale"], False, start, end, mark)
    ledger = output / f"{name}-trades.jsonl.gz"
    experiment.export_ledger(ledger, [(f"iterations_{steps}", ledgers)])
    audit = verify_ledger(market, ledger, mark, False, {f"iterations_{steps}": metrics})
    target = {
        mode: dict(win_rate=r["closed"] > 0 and 100 * r["wins"] >= 95 * r["closed"],
                   fills=r["fills"] >= experiment.MIN_FILLS, profit=r["net"] > 0)
        for mode, r in metrics.items()
    }
    save_json(output / f"{name}.json", dict(
        iterations=steps, entries=[iso(start), iso(end)], valuation=iso(mark), modes=metrics,
        target=target, target_met=all(all(checks.values()) for checks in target.values()),
        ledger=file_hash(ledger), verification=audit,
    ))
    print(name, {mode: (r["wins"], r["closed"], r["fills"], r["net"]) for mode, r in metrics.items()}, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("iterations", type=int)
    parser.add_argument("--development", action="store_true")
    args = parser.parse_args()
    if args.iterations < 1:
        parser.error("iterations must be positive")
    main(args.iterations, args.development)
