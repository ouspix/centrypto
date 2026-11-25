"""Fit, freeze and replay the autonomous entry policy."""
import argparse
import gzip
import json

import joblib
import numpy as np

from autonomous_data import (BASE_COLUMNS, BEGIN, HERE, NEWS_BEGIN, NEWS_END, NEWS_MARK, NEWS_TEST,
                  NEWS_WIDTH, PARENT, VALIDATION, Dataset)
from autonomous_network import HIDDEN, Adam, gradient, initialize, policy
from autonomous_replay import CAPITAL, CUTOFF, Market, Schedule, run
from settings import MARK_STOP, MINUTE, MODES, START, TEST_START, TEST_STOP, file_hash, iso, load, save_json

STEPS = 16
NEWS_STEPS = 8
SEED = 92
LEARNING_RATE = .0012
NEWS_LEARNING_RATE = .0005
MIN_FILLS = 250


def outcomes(ledger):
    values = np.array([t["net"] for t in ledger if t["net"] is not None], dtype="f8")
    wins = values[values > 0]
    losses = values[values < 0]
    return dict(fills=len(ledger), closed=len(values), wins=len(wins), losses=len(losses),
                break_even=len(values) - len(wins) - len(losses),
                win_rate=len(wins) / len(values) if len(values) else None,
                average_win=float(wins.mean()) if len(wins) else None,
                average_loss=float(losses.mean()) if len(losses) else None,
                realized_net=float(values.sum()))


def summarize(ledger, inventory, result):
    return dict(**result, **outcomes(ledger), ending_open=len(inventory), ending_inventory=inventory,
                open_marked_pnl=sum(mark["pnl"] for mark in inventory),
                missing_funding_hours=sum(t["missing_funding"] for t in ledger),
                by_side={name: outcomes([t for t in ledger if t["sign"] == sign])
                         for sign, name in ((1, "long"), (-1, "short"))})


def future_reward(ledger, decisions, rate):
    times = (decisions - START) // MINUTE
    ordered = sorted(ledger, key=lambda trade: trade["end"])
    ends = np.array([trade["end"] for trade in ordered], dtype="i8")
    rewards = np.array([(trade["net"] > 0) - rate for trade in ordered])
    tail = np.r_[rewards[::-1].cumsum()[::-1], 0.]
    return tail[np.searchsorted(ends, times, side="right")]


def evaluate(dataset, market, parameters, scale, with_news, begin, end, mark):
    span = dataset.span(begin, end)
    schedule = Schedule(dataset.decisions[span])
    prediction = policy(dataset, span, scale, parameters, with_news)
    metrics, ledgers = {}, {}
    for mode in MODES:
        ledger, inventory, result = run(market, schedule, prediction, mode, begin, mark)
        metrics[mode] = summarize(ledger, inventory, result)
        ledgers[mode] = ledger
    return metrics, ledgers


def fit(dataset, market, begin, cutoff, steps, with_news=False, parent=None, validate=False):
    span = dataset.span(begin, cutoff)
    schedule = Schedule(dataset.decisions[span])
    rng = np.random.default_rng(SEED)
    if parent is None:
        scale = dataset.scale(span)
        parameters = initialize(len(BASE_COLUMNS) + NEWS_WIDTH, len(BASE_COLUMNS), rng)
    else:
        scale = parent["scale"]
        parameters = [[value.copy() for value in layer] for layer in parent["parameters"]]
    optimizer = Adam(parameters, NEWS_LEARNING_RATE if parent else LEARNING_RATE)
    records = []
    last_rollouts = None
    for step in range(1, steps + 1):
        # Paired independent action samples provide a same-time baseline for long rollouts.
        rollouts = []
        for draw in range(2):
            prediction = policy(dataset, span, scale, parameters, with_news, rng)
            books = {mode: run(market, schedule, prediction, mode, begin, cutoff, training=True) for mode in MODES}
            rollouts.append((prediction, books))
        paths = [item[0] for _, books in rollouts for item in books.values()]
        closed = sum(map(len, paths))
        wins = sum(t["net"] > 0 for ledger in paths for t in ledger)
        total_gradient = [[np.zeros_like(value) for value in layer] for layer in parameters]
        if closed:
            rate = wins / closed
            for i, (prediction, books) in enumerate(rollouts):
                other = rollouts[1 - i][1]
                advantage = np.zeros(len(schedule.at), dtype="f8")
                for mode, (ledger, trace, _) in books.items():
                    advantage += trace * (future_reward(ledger, schedule.at, rate) -
                                          future_reward(other[mode][0], schedule.at, rate)) / closed
                gradients = gradient(dataset, span, scale, parameters, with_news, prediction[0], prediction[3], advantage)
                for summed, estimate in zip(total_gradient, gradients, strict=True):
                    summed[0] += estimate[0]
                    summed[1] += estimate[1]
        norm = optimizer.update(parameters, total_gradient)
        record = dict(step=step, loss=1 - wins / closed if closed else None,
                      wins=wins, closed=closed, gradient_norm=norm, rollouts=[])
        for _, books in rollouts:
            record["rollouts"].append({
                mode: dict(**outcomes(ledger), cutoff_closes=outcomes([t for t in ledger if t["reason"] == CUTOFF]),
                           missing_funding_hours=sum(t["missing_funding"] for t in ledger), rejects=dict(counts))
                for mode, (ledger, _, counts) in books.items()
            })
        last_rollouts = [{mode: item[0] for mode, item in books.items()} for _, books in rollouts]
        if validate and (step == 1 or step % 2 == 0 or step == steps):
            record["validation"] = evaluate(dataset, market, parameters, scale, with_news,
                                            cutoff, TEST_START, TEST_START)[0]
        records.append(record)
        val = {m: (round(r["win_rate"] or 0., 3), r["fills"], round(r["net"], 2))
               for m, r in record.get("validation", {}).items()}
        print(f"Fit {iso(cutoff)} news={with_news} step={step}/{steps} wins={wins}/{closed} validation={val}", flush=True)
    bundle = dict(parameters=parameters, scale=scale, with_news=with_news)
    return bundle, records, last_rollouts


def select_checkpoint(records):
    candidates = [r for r in records if "validation" in r]

    def key(record):
        modes = list(record["validation"].values())
        volume = min(r["fills"] for r in modes)
        rate = min(r["win_rate"] or 0. for r in modes)
        profit = min(r["net"] for r in modes)
        if volume >= MIN_FILLS:
            return (2 if profit > 0 else 1), rate, profit, -record["step"]
        return 0, volume, rate, -record["step"]

    selected = max(candidates, key=key)
    basis = ("volume_and_profit", "volume_only", "most_active")[2 - key(selected)[0]]
    return selected["step"], basis


def export_ledger(path, batches):
    with gzip.open(path, "wt", encoding="utf-8") as stream:
        for label, by_mode in batches:
            for mode, ledger in by_mode.items():
                for trade in ledger:
                    stream.write(json.dumps(dict(experiment=label, mode=mode, **trade), allow_nan=False) + "\n")


def model_path(name):
    return HERE / f"{name}.joblib"


def save_model(name, model):
    target = model_path(name)
    temp = target.with_suffix(".partial")
    joblib.dump(model, temp, compress=3)
    temp.replace(target)
    return file_hash(target)


def get_model(name, manifest):
    assert file_hash(model_path(name)) == manifest["models"][name]
    return joblib.load(model_path(name))


def provenance():
    inputs = [HERE / f"{name}.py" for name in ("autonomous_data", "autonomous_network", "autonomous_replay", "experiment")]
    inputs += [HERE / "dataset.json", PARENT / "bracket-exits/desk-mandate.json",
               PARENT / "receipts.json", PARENT / "news-timing/news-inputs.json",
               PARENT / "news-intelligence/dataset.json"]
    return {str(path.relative_to(PARENT)): file_hash(path) for path in inputs}


def train_main(dataset, market):
    path = HERE / "fit.json"
    if path.exists():
        raise FileExistsError(path)
    _, development, _ = fit(dataset, market, BEGIN, VALIDATION, STEPS, validate=True)
    selected, basis = select_checkpoint(development)
    model, records, ledgers = fit(dataset, market, BEGIN, TEST_START, selected)
    ledger_path = HERE / "training-trades.jsonl.gz"
    export_ledger(ledger_path, [(f"final_training_draw_{i + 1}", books) for i, books in enumerate(ledgers)])
    save_json(path, dict(models={"main": save_model("main", model)}, provenance=provenance(),
                         hidden=HIDDEN, seed=SEED, learning_rate=LEARNING_RATE,
                         selected=selected, selection_basis=basis, development=development, final=records,
                         final_training_ledger=file_hash(ledger_path)))


def train_news(dataset, market):
    path = HERE / "news-fit.json"
    if path.exists():
        raise FileExistsError(path)
    main = load(HERE / "fit.json")
    assert main["provenance"] == provenance()
    parent = get_model("main", main)
    models, records, audit = {}, {}, []
    for name, has_intelligence in (("intelligence", True), ("masked", False)):
        model, records[name], ledgers = fit(dataset, market, NEWS_BEGIN, NEWS_TEST, NEWS_STEPS,
                                           with_news=has_intelligence, parent=parent)
        models[name] = save_model(name, model)
        audit += [(f"{name}_training_draw_{i + 1}", books) for i, books in enumerate(ledgers)]
    ledger_path = HERE / "news-training-trades.jsonl.gz"
    export_ledger(ledger_path, audit)
    save_json(path, dict(models=models, provenance=provenance(), parent=main["models"]["main"],
                         learning_rate=NEWS_LEARNING_RATE, steps=NEWS_STEPS, records=records,
                         news_training_ledger=file_hash(ledger_path)))


def baseline(market, path, field, label):
    groups = {mode: [] for mode in MODES}
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        for line in stream:
            trade = json.loads(line)
            if trade[field] == label:
                groups[trade["mode"]].append(trade)
    output = {}
    for mode, ledger in groups.items():
        equity, _, inventory, _ = market.valuation(ledger, TEST_START, MARK_STOP)
        for mark in inventory:
            mark["age_minutes"] = (MARK_STOP - START) // MINUTE - mark["entry"]
        output[mode] = summarize(ledger, inventory, dict(
            net=float(equity[-1] - CAPITAL), max_drawdown=float((np.maximum.accumulate(equity) - equity).max())))
    return output


def backtest(dataset, market, news=False):
    main = load(HERE / "fit.json")
    assert main["provenance"] == provenance()
    manifest = load(HERE / "news-fit.json") if news else main
    assert manifest["provenance"] == provenance()
    if news:
        begin, end, mark = NEWS_TEST, NEWS_END, NEWS_MARK
        variants = [("main", main), ("intelligence", manifest), ("masked", manifest)]
        prefix = "news-"
    else:
        begin, end, mark = TEST_START, TEST_STOP, MARK_STOP
        variants = [("main", main)]
        prefix = ""
    metrics, output = {}, []
    for name, fit_manifest in variants:
        model = get_model(name, fit_manifest)
        stats, ledgers = evaluate(dataset, market, model["parameters"], model["scale"], model["with_news"],
                                  begin, end, mark)
        metrics[name] = stats
        output.append((name, ledgers))
    result = dict(entries=[iso(begin), iso(end)], valuation=iso(mark), policies=metrics)
    if not news:
        result["baselines"] = {
            "prior_joint": baseline(market, PARENT / "joint-entry-exits/main-trades.jsonl.gz", "policy", "joint"),
            "constant_fixed": baseline(market, PARENT / "bracket-exits/bracket-trades.jsonl.gz", "model", "constant"),
        }
        result["target"] = {mode: dict(win_rate=r["closed"] > 0 and 100 * r["wins"] >= 95 * r["closed"],
                                       fills=r["fills"] >= MIN_FILLS, profit=r["net"] > 0)
                            for mode, r in metrics["main"].items()}
        result["target_met"] = all(all(check.values()) for check in result["target"].values())
    path = HERE / f"{prefix}backtest-trades.jsonl.gz"
    export_ledger(path, output)
    result["ledger"] = file_hash(path)
    save_json(HERE / f"{prefix}results.json", result)
    for name, stats in metrics.items():
        print(name, {m: (r["wins"], r["closed"], r["fills"], round(r["net"], 2)) for m, r in stats.items()}, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["train", "backtest"])
    parser.add_argument("--news", action="store_true")
    args = parser.parse_args()
    data, market = Dataset(), Market()
    if args.command == "train":
        (train_news if args.news else train_main)(data, market)
    else:
        backtest(data, market, args.news)
