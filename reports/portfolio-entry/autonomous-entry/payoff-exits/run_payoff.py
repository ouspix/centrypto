"""Train chronological payoff models and replay the factorial experiment."""
import argparse
import fcntl
import gzip
import json

import numpy as np

from payoff_data import BEGIN, HERE, MODES, NEWS_BEGIN, NEWS_TEACH, TEACH, VALIDATION, WINDOWS
from payoff_data import Dataset, Market, SIGNS, initial_size, minute, paths, volatility
from payoff_models import Inputs, SNAP_WIDTH, STEPS, fit_exits, fit_value, predict, teach, torch
from payoff_replay import replay, summarize_stops
from payoff_history import HISTORY, LAGS
from autonomous_data import BASE_COLUMNS, NEWS_END, NEWS_MARK, NEWS_TEST, RECEIPTS, STORIES
from autonomous_replay import CUTOFF, LIMITS, MIN_NOTIONAL, Schedule
from examples import candle_bars
from extended_fit import experiment
from publication_news import PublicationWindows
from settings import MARK_STOP, MINUTE, START, SYMBOLS, TEST_START, TEST_STOP, WORK, file_hash, iso, load, save_json
from verify_autonomous import assert_decisions, verify_ledger

OUTPUT = HERE / "results"
FAMILIES = {"named": True, "neural": False}
KINDS = {"snapshot": False, "ordered": True}


def run_pair(inputs, market, begin, end, mark, value, exits, scale, history, news):
    span = inputs.data.span(begin, end)
    schedule = Schedule(inputs.data.decisions[span])
    vol = volatility(inputs.data, span)
    thresholds = np.quantile(volatility(inputs.data, history), [1 / 3, 2 / 3])
    dist, forecasts = predict(inputs, span, value, exits, scale, news)
    train_dist, train_q = predict(inputs, history, value, exits, scale, news)
    sizes = initial_size(inputs.data.decisions["turnover"][history, None], train_dist[:, :, 1], SIGNS)
    scores = np.where(sizes >= MIN_NOTIONAL, sizes * train_q.min(axis=-1), -np.inf)
    best = scores.argmax(axis=1)
    fixed = []
    for side in range(2):
        chosen = (best == side) & (scores[:, side] > 0)
        sample = train_dist[chosen, side] if chosen.any() else train_dist[:, side]
        fixed.append(np.median(sample, axis=0).tolist())
    fixed_dist = np.broadcast_to(fixed, dist.shape)
    summaries, ledgers = {}, {}
    for mode, _ in MODES:
        adaptive, ledgers_adaptive, plan = replay(market, schedule, dist, forecasts, vol, mode, begin, mark)
        baseline, ledgers_baseline, _ = replay(market, schedule, fixed_dist, forecasts, vol, mode, begin, mark, plan)
        summaries[mode] = dict(
            learned=dict(**adaptive, stop_by_volatility=summarize_stops(ledgers_adaptive, thresholds)),
            fixed=dict(**baseline, stop_by_volatility=summarize_stops(ledgers_baseline, thresholds)),
            proposed=sum(map(len, plan.values())),
        )
        ledgers[mode] = (ledgers_adaptive, ledgers_baseline)
    return dict(scenarios=summaries, fixed_log_distances=fixed,
                volatility_thresholds=thresholds.tolist()), ledgers


def save_replay(name, report, books, market, mark):
    ledger = OUTPUT / f"{name}-trades.jsonl.gz"
    variants = ("learned", "fixed")
    experiment.export_ledger(ledger, [
        (variant, {mode: trades[i] for mode, trades in books.items()})
        for i, variant in enumerate(variants)
    ])
    metrics = {variant: {mode: result[variant] for mode, result in report["scenarios"].items()}
               for variant in variants}
    audit = verify_ledger(market, ledger, mark, False, metrics)
    assert sum(book["fills"] for book in audit.values()) == sum(
        result["fills"] for modes in metrics.values() for result in modes.values())
    report.update(ledger=file_hash(ledger), audited=audit)
    return report


def save_model(name, value, exits, scale, metadata):
    model = OUTPUT / f"{name}.pt"
    temp = model.with_suffix(".partial")
    torch.save(dict(value=value.state_dict(), exits=exits.state_dict(), scale=scale, **metadata), temp)
    temp.replace(model)
    return file_hash(model)


def summary(report):
    return {mode: {label: round(stats[label]["net"], 2) for label in ("learned", "fixed")}
            for mode, stats in report["scenarios"].items()}


def run_group(kind, inputs, market):
    ordered = KINDS[kind]
    data = inputs.data
    teacher_scale, dev_scale, final_scale = (
        inputs.scale(data.span(*WINDOWS[window])) for window in ("teacher", "development", "final")
    )
    teacher, teacher_loss = fit_value(inputs, "teacher", ordered, teacher_scale)
    development, development_loss = fit_value(inputs, "development", ordered, dev_scale)
    before_may, targets_a, dropped_a = teach(inputs, TEACH, VALIDATION, teacher, teacher_scale, False)
    before_august, targets_b, dropped_b = teach(inputs, VALIDATION, TEST_START, development, dev_scale, False)
    final, final_loss = fit_value(inputs, "final", ordered, final_scale)
    family_results = {}
    for family, named in FAMILIES.items():
        name = f"{kind}-{family}"
        dev_exits, dev_loss = fit_exits(inputs, before_may, targets_a, ordered, named, dev_scale)
        validation, books = run_pair(inputs, market, VALIDATION, TEST_START, TEST_START, development,
                                     dev_exits, dev_scale, data.span(BEGIN, VALIDATION), False)
        save_replay(f"{name}-validation", validation, books, market, TEST_START)
        # Select from these metrics. The retrospective replay is isolated in finish().
        combined_rows = np.r_[before_may, before_august]
        combined_targets = np.concatenate((targets_a, targets_b))
        exits, loss = fit_exits(inputs, combined_rows, combined_targets, ordered, named, final_scale)
        coeff = exits.coefficients(data.manifest["intelligence_columns"])
        if coeff is not None:
            save_json(OUTPUT / f"{name}-coefficients.json", dict(
                **coeff, snapshot_scaling=[a.tolist() for a in final_scale[0]],
                history_scaling=[a.tolist() for a in final_scale[1]],
            ))
        family_results[name] = dict(
            validation=validation, model=save_model(name, final, exits, final_scale,
                                                     dict(ordered=ordered, named=named, news=False)),
            exit_losses=dict(validation=dev_loss, final=loss))
        print(f"{name} validation {summary(validation)}", flush=True)
    save_json(OUTPUT / f"{kind}-fit.json", dict(
        iterations=STEPS, teacher_cutoffs=[iso(TEACH), iso(VALIDATION)], final_cutoff=iso(TEST_START),
        distillation_rows=[len(before_may), len(before_august)], infeasible_sides=[dropped_a, dropped_b],
        value_losses=dict(teacher=teacher_loss, development=development_loss, final=final_loss),
        models=family_results,
    ))


def load_model(name, digest):
    from payoff_models import Exits, Value
    path = OUTPUT / f"{name}.pt"
    assert file_hash(path) == digest
    state = torch.load(path, weights_only=False)  # The file is produced and hashed by this experiment.
    value = Value(state["ordered"])
    value.load_state_dict(state["value"])
    exits = Exits(state["ordered"], state["named"])
    exits.load_state_dict(state["exits"])
    return value.eval(), exits.eval(), state["scale"]


def news_comparison(inputs, market, selected, digest):
    parent_value, parent_exits, scale = load_model(selected, digest)
    ordered, named = parent_exits.ordered, parent_exits.named
    # Both arms start with zero weights on features absent from long-history fitting.
    exit_input = parent_exits.linear if named else parent_exits.context.dense[0]
    with torch.no_grad():
        for layer in (parent_value.context.dense[0], exit_input):
            layer.weight[:, len(BASE_COLUMNS):SNAP_WIDTH].zero_()
    variants = {}
    for label, news in (("intelligence", True), ("masked", False)):
        early, early_loss = fit_value(inputs, "news-teacher", ordered, scale, news, parent_value.state_dict())
        rows, targets, dropped = teach(inputs, NEWS_TEACH, NEWS_TEST, early, scale, news)
        value, value_loss = fit_value(inputs, "news", ordered, scale, news, parent_value.state_dict())
        exits, exit_loss = fit_exits(inputs, rows, targets, ordered, named, scale, news, parent_exits.state_dict())
        replay, books = run_pair(inputs, market, NEWS_TEST, NEWS_END, NEWS_MARK, value, exits, scale,
                                 inputs.data.span(NEWS_BEGIN, NEWS_TEST), news)
        variants[label] = save_replay(f"november-{label}", replay, books, market, NEWS_MARK)
        variants[label]["training"] = dict(rows=len(rows), infeasible_sides=dropped,
                                           losses=dict(teacher=early_loss, value=value_loss, exits=exit_loss))
        variants[label]["model"] = save_model(f"november-{label}", value, exits, scale,
                                               dict(ordered=ordered, named=named, news=news))
        print(f"November {label} {summary(replay)}", flush=True)
    return dict(selected_parent=selected, train=[iso(NEWS_BEGIN), iso(NEWS_TEST)],
                entries=[iso(NEWS_TEST), iso(NEWS_END)], valuation=iso(NEWS_MARK), per_variant=variants)


def audit_examples(data, market):
    rng = np.random.default_rng(826)
    total = forced = 0
    for window, (begin, end) in WINDOWS.items():
        span = data.span(begin, end)
        brackets, labels = [np.load(p, mmap_mode="r") for p in paths(window)[:2]]
        rows = np.r_[rng.integers(0, len(labels), 150), rng.integers(len(labels) - 80, len(labels), 80)]
        for row in rows:
            i = int(span.start + row)
            decision = data.decisions[i]
            at, asset = int(decision["at"]), int(decision["asset"])
            side, pair = int(rng.integers(2)), int(rng.integers(16))
            sign = SIGNS[side]
            target, stop = volatility(data, slice(i, i + 1))[0] * np.exp(brackets[row, side, pair])
            size = float(initial_size(decision["turnover"], stop, sign))
            for m, (mode, (delay, slip)) in enumerate(MODES):
                entry = (at - START) // MINUTE + 1 + delay
                paid = float(market.raw[asset, entry, 0] * (1 + sign * slip))
                if (entry >= minute(end) or not np.isfinite(paid) or paid <= 0 or size < MIN_NOTIONAL
                        or sign * (paid / decision["reference"] - 1) * 10000 > LIMITS["maxSlippageBps"]):
                    observed = 0.
                else:
                    tp = paid * float(np.exp(sign * target))
                    sl = paid * float(np.exp(-sign * stop))
                    trade = market.execute(asset, sign, at, minute(end), mode, paid, size, tp, sl, None, True)
                    observed = trade["net"] / size
                    forced += int(trade["reason"] == CUTOFF)
                np.testing.assert_allclose(labels[row, side, pair, m], observed, rtol=1e-5, atol=1e-7)
                total += 1
    return dict(outcomes_checked=total, cutoff_closes_checked=forced, decisions_checked=assert_decisions(data, market))


def audit_history(data, market):
    receipts = np.load(RECEIPTS, mmap_mode="r")
    timestamps = np.load(WORK / "receipt-times.npy", mmap_mode="r")
    switch = minute(load(HERE.parent.parent / "receipts.json")["begin_ms"])
    history = np.load(HISTORY, mmap_mode="r")
    cutoff = START + (switch + 5 * (LAGS + 1)) * MINUTE
    rng = np.random.default_rng(198)
    sampled = np.r_[rng.integers(0, len(history), 64),
                    rng.integers(np.searchsorted(data.decisions["at"], cutoff), len(history), 64)]
    with gzip.open(STORIES, "rt") as stream:
        news = PublicationWindows(map(json.loads, stream))
    for row in sampled:
        stamp = int(data.decisions[row]["at"])
        asset = int(data.decisions[row]["asset"])
        end = minute(stamp)
        start = end - 5 * (LAGS + 1)
        tape = np.array(market.raw[asset, start:end])
        if end > switch:
            latest = slice(max(start, switch) - switch, end - switch)
            tape[max(0, switch - start):] = receipts[asset, latest]
            observed = timestamps[asset, latest]
            # Each candle was available by its own five-minute decision time.
            candle_minute = np.arange(max(start, switch), end)
            deadlines = START + (candle_minute // 5 + 1) * 5 * MINUTE + 5000
            assert ((0 < observed) & (observed <= deadlines[:, None])).all()
        aggregate, complete = candle_bars(tape)
        assert complete.all()
        prices = aggregate[:, 3]
        np.testing.assert_allclose(history[row, :, 1], np.log(prices[1:] / prices[:-1]), atol=1e-7)
        dates = stamp + (np.arange(LAGS) - LAGS + 1) * 5 * MINUTE
        np.testing.assert_array_equal(history[row, :, -4:], news.flags(SYMBOLS[asset], dates))
    return len(sampled)


def finish(inputs, market):
    models = {}
    for kind in KINDS:
        models.update(load(OUTPUT / f"{kind}-fit.json")["models"])

    def rank(name):
        return min(m["learned"]["net"] for m in models[name]["validation"]["scenarios"].values())

    selected = sorted(models, key=lambda name: (-rank(name), name))[0]
    selection = dict(model=selected, criterion="Highest lower-of-base-and-stress validation net P&L",
                     scores={name: rank(name) for name in models})
    save_json(OUTPUT / "selection.json", selection)
    backtests = {}
    for name, record in models.items():
        value, exits, scale = load_model(name, record["model"])
        report, books = run_pair(inputs, market, TEST_START, TEST_STOP, MARK_STOP, value, exits, scale,
                                 inputs.data.span(BEGIN, TEST_START), False)
        report["target"] = {
            mode: dict(positive_profit=r["learned"]["net"] > 0, fill_floor=r["learned"]["fills"] >= 250,
                       win_floor=bool(r["learned"]["closed"] and
                                      100 * r["learned"]["wins"] >= 95 * r["learned"]["closed"]))
            for mode, r in report["scenarios"].items()
        }
        report["target_met"] = all(all(criteria.values()) for criteria in report["target"].values())
        backtests[name] = save_replay(f"{name}-backtest", report, books, market, MARK_STOP)
        print(f"{name} retrospective {summary(report)}", flush=True)
    provenance = {w: load(paths(w)[2]) for w in WINDOWS}
    audit = dict(**audit_examples(inputs.data, market), sequences_checked=audit_history(inputs.data, market))
    save_json(OUTPUT / "backtest.json", dict(selection=selection, iterations=STEPS,
        entries=[iso(TEST_START), iso(TEST_STOP)], valuation=iso(MARK_STOP), models=backtests,
        retrospective=True, verification=audit, labels=provenance, torch_version=torch.__version__))
    save_json(OUTPUT / "november.json", news_comparison(inputs, market, selected, models[selected]["model"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=(*KINDS, "finish"))
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    OUTPUT.mkdir(exist_ok=True)
    with (OUTPUT / f".{args.stage}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        inputs, market = Inputs(Dataset()), Market()
        if args.stage == "finish":
            finish(inputs, market)
        else:
            run_group(args.stage, inputs, market)


if __name__ == "__main__":
    main()
