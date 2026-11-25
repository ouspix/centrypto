"""Compare the combined return, win-rate and fill-count loss with win-rate-only fitting."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import fcntl
import gzip
import json
from multiprocessing import get_context

import joblib
import numpy as np

from autonomous_data import BASE_COLUMNS, BEGIN, HERE, NEWS_WIDTH, Dataset
from autonomous_network import LONG, SHORT, Adam, gradient, initialize, policy
from autonomous_replay import CAPITAL, CUTOFF, Market, Schedule, run
from extended_fit import experiment
from settings import MARK_STOP, MINUTE, MODES, START, TEST_START, TEST_STOP, file_hash, iso, save_json
from verify_autonomous import verify_ledger

WIN_FLOOR = .95
FILLS = experiment.MIN_FILLS
STEPS = 250
MAX_STOP_LOSS = .05
MODES = tuple(MODES)


def worst_scenario_weights(values):
    worst = values == values.min()
    return worst / worst.sum()


def loss_terms(net_dollars, wins, fills, fill_floor, win_weight, fill_weight, closed=None):
    """Loss and active subgradients, with an equal split at a scenario tie."""
    draws = net_dollars.shape[0]
    returns = net_dollars.mean(axis=0) / CAPITAL
    closed_totals = (fills if closed is None else closed).sum(axis=0)
    win_rates = np.divide(wins.sum(axis=0), closed_totals, out=np.zeros(len(MODES)), where=closed_totals > 0)
    volume_ratio = fills.mean(axis=0) / fill_floor
    win_gap = max(0., WIN_FLOOR - win_rates.min())
    volume_gap = max(0., 1. - volume_ratio.min())
    profit = worst_scenario_weights(returns) / (draws * CAPITAL)
    win = np.divide(win_weight * (win_gap > 0) * worst_scenario_weights(win_rates), closed_totals,
                    out=np.zeros(len(MODES)), where=closed_totals > 0)
    volume = fill_weight * (volume_gap > 0) * worst_scenario_weights(volume_ratio) / (draws * fill_floor)
    return (
        dict(loss=float(-returns.min() + win_weight * win_gap + fill_weight * volume_gap),
             returns=dict(zip(MODES, returns.tolist(), strict=True)),
             win_rates=dict(zip(MODES, win_rates.tolist(), strict=True)),
             mean_fills=dict(zip(MODES, fills.mean(axis=0).tolist(), strict=True)),
             win_shortfall=float(win_gap), volume_shortfall=float(volume_gap)),
        profit, win, volume, win_rates,
    )


def future_rewards(ledger, minutes, profit, win, volume, rate):
    """Credit available after each decision for the negative loss subgradient."""
    if not len(ledger):
        return np.zeros(len(minutes))
    ends = np.array([t["end"] for t in ledger], dtype="i8")
    entries = np.array([t["entry"] for t in ledger], dtype="i8")
    net = np.array([t["net"] for t in ledger])
    reward = np.zeros(len(minutes))
    # Entry count is realized at the fill. Return and win count settle at close.
    if volume:
        reward += volume * (len(entries) - np.searchsorted(np.sort(entries), minutes, side="right"))
    if profit or win:
        order = np.argsort(ends)
        close_reward = profit * net + win * ((net > 0) - rate)
        tail = np.r_[close_reward[order][::-1].cumsum()[::-1], 0.]
        reward += tail[np.searchsorted(ends[order], minutes, side="right")]
    return reward


def init_worker(schedule):
    global WORKER_MARKET, WORKER_SCHEDULE
    WORKER_MARKET = Market()
    WORKER_SCHEDULE = schedule


def sample_book(prediction, mode):
    return run(WORKER_MARKET, WORKER_SCHEDULE, prediction, mode, BEGIN, TEST_START, training=True)


def capped_policy(dataset, span, scale, parameters, max_stop_loss, rng=None):
    prediction = policy(dataset, span, scale, parameters, False, rng)
    actions, _, exits, _ = prediction
    # Replay converts the multiplier to paid / sl for longs and paid * sl for shorts.
    stop_multiplier = exits[:, 1]
    longs, shorts = actions == LONG, actions == SHORT
    stop_multiplier[longs] = np.minimum(stop_multiplier[longs], 1. / (1. - max_stop_loss))
    stop_multiplier[shorts] = np.minimum(stop_multiplier[shorts], 1. + max_stop_loss)
    return prediction


def verify_stop_cap(path, max_stop_loss):
    audit = [dict(trades=0, at_cap=0, maximum=0.) for _ in range(2)]
    with gzip.open(path, "rt") as ledger:
        for line in ledger:
            trade = json.loads(line)
            side = audit[0 if trade["sign"] == 1 else 1]
            distance = trade["sign"] * (1. - trade["stop"] / trade["paid"])
            assert 0. < distance <= max_stop_loss + 1e-12, trade
            side["trades"] += 1
            side["at_cap"] += abs(distance - max_stop_loss) <= 1e-12
            side["maximum"] = max(side["maximum"], distance)
    return dict(zip(("long", "short"), audit, strict=True))


def atomic_model(path, value):
    pending = path.with_suffix(".partial")
    joblib.dump(value, pending, compress=3)
    pending.replace(path)


def evaluation_objective(metrics, settings):
    net, wins, fills, closed = (np.array([[metrics[m][key] for m in MODES]])
                                for key in ("net", "wins", "fills", "closed"))
    return loss_terms(net, wins, fills, FILLS, settings["win_weight"], settings["fill_weight"], closed)[0]


def train(dataset, output, settings):
    span = dataset.span(BEGIN, TEST_START)
    schedule = Schedule(dataset.decisions[span])
    minutes = (schedule.at - START) // MINUTE
    rng = np.random.default_rng(experiment.SEED)
    checkpoint = output / "resume.joblib"
    if checkpoint.exists():
        state = joblib.load(checkpoint)
        assert state["settings"] == settings
        parameters, scale, optimizer, records = (state[key] for key in ("parameters", "scale", "optimizer", "records"))
        rng.bit_generator.state = state["rng"]
    else:
        scale = dataset.scale(span)
        parameters = initialize(len(BASE_COLUMNS) + NEWS_WIDTH, len(BASE_COLUMNS), rng)
        optimizer = Adam(parameters, experiment.LEARNING_RATE)
        records = []

    with ProcessPoolExecutor(max_workers=len(MODES), mp_context=get_context("fork"),
                             initializer=init_worker, initargs=(schedule,)) as pool:
        for step in range(len(records) + 1, settings["iterations"] + 1):
            predictions, pending = [], []
            for _ in range(2):
                prediction = capped_policy(dataset, span, scale, parameters, settings["max_stop_loss"], rng)
                predictions.append(prediction)
                pending.append([pool.submit(sample_book, prediction[:3] + (None,), mode) for mode in MODES])
            books = [[future.result() for future in draw] for draw in pending]
            rollouts = [[dict(**experiment.outcomes(ledger),
                              cutoff_closes=experiment.outcomes([t for t in ledger if t["reason"] == CUTOFF]),
                              missing_funding_hours=sum(t["missing_funding"] for t in ledger),
                              rejects=dict(rejects)) for ledger, _, rejects in draw] for draw in books]
            net, wins, fills = (
                np.array([[r[key] for r in draw] for draw in rollouts])
                for key in ("realized_net", "wins", "fills")
            )
            record, profit, win, volume, rates = loss_terms(
                net, wins, fills, settings["training_fill_floor"], settings["win_weight"], settings["fill_weight"])
            rewards = [[future_rewards(ledger, minutes, profit[m], win[m], volume[m], rates[m])
                        for m, (ledger, _, _) in enumerate(draw)] for draw in books]
            total = [[np.zeros_like(v) for v in layer] for layer in parameters]
            for i, prediction in enumerate(predictions):
                advantage = sum(trace * (rewards[i][m] - rewards[1 - i][m])
                                for m, (_, trace, _) in enumerate(books[i]))
                grads = gradient(dataset, span, scale, parameters, False, prediction[0], prediction[3], advantage)
                for summed, estimate in zip(total, grads, strict=True):
                    summed[0] += estimate[0]
                    summed[1] += estimate[1]
            norm = optimizer.update(parameters, total)
            records.append(dict(step=step, **record, gradient_norm=norm,
                                rollouts=[dict(zip(MODES, draw, strict=True)) for draw in rollouts]))
            if step == settings["iterations"]:
                ledger = output / "training-trades.jsonl.gz"
                experiment.export_ledger(ledger, [
                    (f"training_draw_{i + 1}", {mode: book[0] for mode, book in zip(MODES, draw, strict=True)})
                    for i, draw in enumerate(books)
                ])
                atomic_model(output / "main.joblib", dict(parameters=parameters, scale=scale, with_news=False,
                            max_stop_loss=settings["max_stop_loss"]))
                save_json(output / "fit.json", dict(settings=settings, records=records,
                          model=file_hash(output / "main.joblib"), ledger=file_hash(ledger)))
            elif step % 10 == 0:
                atomic_model(checkpoint, dict(settings=settings, parameters=parameters, scale=scale,
                                              optimizer=optimizer, records=records, rng=rng.bit_generator.state))
            print(f"step={step}/{settings['iterations']} loss={record['loss']:.5f} "
                  f"worst_return={min(record['returns'].values()):+.2%} "
                  f"worst_win_rate={min(record['win_rates'].values()):.2%} "
                  f"minimum_fills={min(record['mean_fills'].values()):.0f}", flush=True)
    checkpoint.unlink(missing_ok=True)


def backtest(dataset, output, settings):
    with (output / "fit.json").open() as stream:
        fit = json.load(stream)
    assert fit["settings"] == settings and len(fit["records"]) == settings["iterations"]
    assert fit["model"] == file_hash(output / "main.joblib")
    market = Market()
    training_ledger = output / "training-trades.jsonl.gz"
    assert fit["ledger"] == file_hash(training_ledger)
    training_audit = verify_ledger(market, training_ledger, TEST_START, True)
    assert all(entry["fills"] == entry["closed"] for entry in training_audit.values())
    bundle = joblib.load(output / "main.joblib")
    assert bundle["max_stop_loss"] == settings["max_stop_loss"]
    span = dataset.span(TEST_START, TEST_STOP)
    schedule = Schedule(dataset.decisions[span])
    prediction = capped_policy(dataset, span, bundle["scale"], bundle["parameters"], bundle["max_stop_loss"])
    modes, books = {}, {}
    for mode in MODES:
        trades, inventory, result = run(market, schedule, prediction, mode, TEST_START, MARK_STOP)
        modes[mode] = experiment.summarize(trades, inventory, result)
        books[mode] = trades
    with (HERE / f"iterations-{settings['iterations']}" / "backtest.json").open() as stream:
        baseline = json.load(stream)
    assert baseline["iterations"] == settings["iterations"]
    dates = [iso(TEST_START), iso(TEST_STOP)]
    assert baseline["entries"] == dates and baseline["valuation"] == iso(MARK_STOP)
    ledger = output / "backtest-trades.jsonl.gz"
    experiment.export_ledger(ledger, [("joint_loss", books)])
    audit = verify_ledger(market, ledger, MARK_STOP, False, {"joint_loss": modes})
    stop_cap_audit = dict(training=verify_stop_cap(training_ledger, bundle["max_stop_loss"]),
                          backtest=verify_stop_cap(ledger, bundle["max_stop_loss"]))
    fields = ("win_rate", "fills", "net", "max_drawdown")
    differences = {
        mode: {key: modes[mode][key] - baseline["modes"][mode][key]
               for key in fields if modes[mode][key] is not None}
        for mode in MODES
    }
    target = {mode: dict(win_rate=m["closed"] > 0 and 100 * m["wins"] >= 95 * m["closed"],
                         fills=m["fills"] >= FILLS, profit=m["net"] > 0) for mode, m in modes.items()}
    save_json(output / "backtest.json", dict(
        entries=dates, valuation=iso(MARK_STOP), iterations=settings["iterations"],
        objective=evaluation_objective(modes, settings),
        baseline_objective=evaluation_objective(baseline["modes"], settings),
        modes=modes, baseline=baseline["modes"], changes=differences, target=target,
        target_met=all(all(values.values()) for values in target.values()), ledger=file_hash(ledger),
        verification=audit, training_verification=training_audit, stop_cap_verification=stop_cap_audit,
    ))
    for mode, result in modes.items():
        print(mode, {key: result[key] for key in fields}, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--win-weight", type=float, default=1.)
    parser.add_argument("--fill-weight", type=float, default=1.)
    args = parser.parse_args()
    if not all(np.isfinite(v) and v > 0 for v in (args.win_weight, args.fill_weight)):
        parser.error("Both penalty weights must be finite and positive.")
    output = HERE / f"joint-loss-{STEPS}-win-{args.win_weight:g}-fills-{args.fill_weight:g}-sl-{MAX_STOP_LOSS * 100:g}pct"
    output.mkdir(exist_ok=True)
    sources = experiment.provenance()
    sources["autonomous-entry/joint_fit.py"] = file_hash(__file__)
    settings = dict(iterations=STEPS, win_weight=args.win_weight, fill_weight=args.fill_weight,
                    max_stop_loss=MAX_STOP_LOSS,
                    win_floor=WIN_FLOOR, evaluation_fill_floor=FILLS,
                    training_fill_floor=FILLS * (TEST_START - BEGIN) / (TEST_STOP - TEST_START),
                    seed=experiment.SEED, base_learning_rate=experiment.LEARNING_RATE,
                    begin=iso(BEGIN), cutoff=iso(TEST_START), provenance=sources)
    with (output / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (output / "backtest.json").exists():
            raise FileExistsError(output / "backtest.json")
        dataset = Dataset()
        if not (output / "fit.json").exists():
            train(dataset, output, settings)
        backtest(dataset, output, settings)


if __name__ == "__main__":
    main()
