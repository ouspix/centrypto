"""Fit the ordered policy heads directly against realized, desk-constrained portfolio outcomes."""
import argparse
import copy
import fcntl
import gzip
import json
import math
from contextlib import ExitStack

import numpy as np

from payoff_data import BEGIN, HERE, MODES, TEACH, VALIDATION, VOL_COLUMN, Dataset, Market, realized_volatility, volatility
from payoff_models import Context, Inputs, SEED, STEPS, fit_exits, fit_value, market_batch, teach, tensor, torch
from payoff_history import HISTORY_COLUMNS, LAGS
from payoff_replay import price_levels, replay
from autonomous_data import BASE_COLUMNS
from autonomous_replay import CAPITAL, Schedule
from extended_fit import experiment
from run_payoff import OUTPUT as PRETRAINED, load_model
from settings import MARK_STOP, SYMBOLS, TEST_START, TEST_STOP, file_hash, iso, load, ms, save_json
from verify_autonomous import verify_ledger

FIRST_PASS = HERE / "portfolio-objective"
INITIAL_FIT = FIRST_PASS / "fitted-heads"
OUTPUT = INITIAL_FIT
MIN_CLOSED = 250
MIN_WIN_PERCENT = 95
JOINT = "joint"
WORST_NET = "worst-net"
CONSTRAINED_UPDATES = 500
CHECKPOINTS = (50, 100, 150, 200, 250)
SCENARIOS = tuple(mode for mode, _ in MODES)
ENCODER_BATCH = 2048


def objective(books, criterion=JOINT):
    if set(books) != set(SCENARIOS):
        raise ValueError("objective requires both base and stress portfolios")
    n = min(b["closed"] for b in books.values())
    rate = min(b["wins"] / b["closed"] if b["closed"] else 0. for b in books.values())
    pnl = min(b["net"] for b in books.values())
    feasible = n >= MIN_CLOSED and all(100*b["wins"] >= MIN_WIN_PERCENT*b["closed"] for b in books.values())
    summary = dict(min_closed=n, worst_win_rate=rate, worst_net=pnl,
                   volume_qualified=n >= MIN_CLOSED, target_met=feasible and pnl > 0)
    if criterion == WORST_NET:
        return dict(**summary, criterion=criterion, constraints_met=feasible)
    if criterion == JOINT:
        return dict(**summary, utility=pnl / CAPITAL + rate)
    raise ValueError(f"unknown objective: {criterion}")


def priority(obj):
    if obj.get("criterion") == WORST_NET:
        if obj["constraints_met"]:
            return True, obj["worst_net"]
        # While infeasible, improve the least satisfied minimum, then the other.
        # Cap attainment so excess volume or wins cannot cover the other shortfall.
        volume = min(1., obj["min_closed"] / MIN_CLOSED)
        win_rate = min(1., obj["worst_win_rate"] * 100 / MIN_WIN_PERCENT)
        return False, min(volume, win_rate), max(volume, win_rate), obj["worst_net"]
    return obj["target_met"], min(obj["min_closed"], MIN_CLOSED), obj["utility"]


@torch.no_grad()
def with_history(x, bars, encoder):
    dtype = next(encoder.parameters()).dtype
    hidden = encoder(x.to(dtype), bars.to(dtype)).numpy()
    return np.column_stack((x[:, :len(BASE_COLUMNS)].numpy(), hidden))


def state_features(inputs, rows, encoder, scale):
    x, bars = inputs.batch(rows, scale, True, False)
    return with_history(x, bars, encoder)


def normalized(features, norm):
    features = np.clip((features - norm[0]) / norm[1], -8., 8.).astype("f4")
    return np.column_stack((features, np.ones(len(features), dtype="f4")))


def encode(inputs, span, encoder, scale, norm=None):
    blocks = [state_features(inputs, np.arange(start, min(start + ENCODER_BATCH, span.stop)), encoder, scale)
              for start in range(span.start, span.stop, ENCODER_BATCH)]
    features = np.concatenate(blocks)
    if norm is None:
        mean = features.mean(axis=0, dtype="f8")
        std = features.std(axis=0, dtype="f8")
        if next(encoder.parameters()).dtype == torch.float64:
            # Prevent saturation noise from becoming a full-strength market feature.
            std[len(BASE_COLUMNS):] = np.maximum(std[len(BASE_COLUMNS):], .001)
            norm = mean, np.where(std > 1e-6, std, 1.)
        else:
            norm = mean.astype("f4"), np.where(std > 1e-6, std, 1.).astype("f4")
    return normalized(features, norm), norm


def exit_distances(features, vol, weights):
    raw = (features @ weights[:, 2:]).astype("f8").reshape(-1, 2, 2)
    distances = vol[:, None, None] * np.logaddexp(0., raw)
    assert np.isfinite(distances).all() and (distances > 0).all()
    return distances


class Window:
    def __init__(self, inputs, encoder, scale, begin, end, mark, norm=None):
        self.begin, self.mark = begin, mark
        span = inputs.data.span(begin, end)
        self.rows = inputs.data.decisions[span]
        self.vol = volatility(inputs.data, span)
        self.x, self.norm = encode(inputs, span, encoder, scale, norm)

    def evaluate(self, market, weights, *, close_book, score_only=False):
        return replay_policy(market, self.rows, self.vol, self.begin, self.mark, self.x, weights,
                             close_book=close_book, score_only=score_only)


def replay_policy(market, rows, volatility, begin, mark, features, weights, *, close_book, score_only=False):
    preference = features @ weights[:, :2]
    active = np.flatnonzero((preference > 0).any(axis=1))
    schedule = Schedule(rows[active])
    vol = volatility[active]
    distances = exit_distances(features[active], vol, weights)
    # Learned preferences are utility scores per unit of exposure. Pass has zero utility.
    forecast = preference[active, :, None]
    metrics, ledgers = {}, {}
    for mode in SCENARIOS:
        metrics[mode], ledgers[mode], _ = replay(
            market, schedule, distances, forecast, vol, mode, begin, mark,
            close_book=close_book, record_plan=False, training_score_only=score_only, policy_scores=True)
    return metrics, ledgers


def initial_heads(x, rng):
    weights = rng.normal(0., .035, (x.shape[1], 6)).astype("f4")
    momentum = BASE_COLUMNS.index("perp_return_pct_60m")
    weights[momentum, :2] += (1., -1.)
    weights[-1] = (0., 0., 1.5, 4., 1.5, 4.)
    weights[-1, :2] -= np.quantile(x @ weights[:, :2], .99, axis=0)
    return weights


def pretrained_heads(inputs, stage):
    record = load(PRETRAINED / "ordered-fit.json")["models"]["ordered-neural"]
    if stage == "final":
        return load_model("ordered-neural", record["model"])
    early_scale = inputs.scale(inputs.data.span(BEGIN, TEACH))
    scale = inputs.scale(inputs.data.span(BEGIN, VALIDATION))
    early, _ = fit_value(inputs, "teacher", True, early_scale)
    value, _ = fit_value(inputs, "development", True, scale)
    rows, targets, _ = teach(inputs, TEACH, VALIDATION, early, early_scale, False)
    exits, losses = fit_exits(inputs, rows, targets, True, False, scale)
    np.testing.assert_array_equal(losses, record["exit_losses"]["validation"])
    return value, exits, scale


@torch.no_grad()
def fitted_heads(inputs, window, end, value, exits, scale):
    # Transfer all four fitted exit functions into the standardized feature basis.
    weights = np.zeros((window.x.shape[1], 6), dtype="f4")
    hidden = slice(len(BASE_COLUMNS), -1)
    old = exits.linear.weight.detach().numpy().T
    mean, std = (v[len(BASE_COLUMNS):] for v in window.norm)
    weights[hidden, 2:] = old * std[:, None]
    weights[-1, 2:] = exits.linear.bias.detach().numpy() + mean @ old
    # Initialize each preference using the prior conservative payoff on fitting dates only.
    span = inputs.data.span(BEGIN, end)
    sample = np.linspace(0, len(window.x) - 1, min(len(window.x), 32768), dtype=int)
    forecasts = []
    for chunk in np.array_split(sample, max(1, (len(sample) + 2047)//2048)):
        x, bars = inputs.batch(chunk + span.start, scale, True, False)
        brackets = exits(x, bars)[:, :, None, :]
        forecasts.append(value(x, bars, brackets).squeeze(2).amin(-1).numpy())
    y = np.concatenate(forecasts).astype("f8")
    y = (y - y.mean(0)) / np.maximum(y.std(0), 1e-8)
    design = window.x[sample].astype("f8")
    gram = design.T @ design
    gram.flat[::len(gram)+1] += .001 * len(sample)
    weights[:, :2] = np.linalg.solve(gram, design.T @ y)
    weights[-1, :2] -= np.quantile(window.x @ weights[:, :2], .99, axis=0)
    return weights


def propose(current, rng, step, stale=0):
    candidate = current.copy()
    # Coordinate and multi-head proposals can change the entry decision and all four exit functions.
    heads = rng.choice(6, size=int(rng.choice([1, 2, 3, 6])), replace=False)
    scale = (.45 if step <= 150 else .22) * rng.choice([.5, 1., 2.]) * .5 ** min(4, stale//15)
    for head in heads:
        idx = rng.choice(len(candidate) - 1, size=int(rng.choice([1, 4, 12])), replace=False)
        magnitude = scale * (1. if head < 2 else 2.)
        candidate[idx, head] += rng.normal(0., magnitude / np.sqrt(len(idx)), len(idx))
        candidate[-1, head] += rng.normal(0., magnitude)
    return candidate


def save_bundle(path, bundle):
    tmp = path.with_suffix(".partial")
    torch.save(bundle, tmp)
    tmp.replace(path)


def search(stage, market, window, weights, rng, records, snapshots, last_improvement, through,
           *, cold=False, checkpoint=None, criterion=JOINT):
    best = records[-1]["incumbent"] if records else None
    for step in range(len(records), through + 1):
        stale = 0 if cold else step - last_improvement
        trial = weights if step == 0 else propose(weights, rng, step, stale)
        books, _ = window.evaluate(market, trial, close_book=True, score_only=True)
        score = objective(books, criterion)
        accepted = best is None or priority(score) > priority(best)
        if accepted:
            weights, best = trial, score
            last_improvement = step
        records.append(dict(step=step, accepted=accepted, candidate=score, incumbent=best,
                            books={mode: {k: book[k] for k in ("net", "wins", "closed", "fills", "cutoff_closes")}
                                   for mode, book in books.items()}))
        if step in CHECKPOINTS or (step > STEPS and step % 50 == 0) or step == through:
            snapshots[step] = weights.copy()
        if checkpoint is not None and (step % 5 == 0 or step == through):
            checkpoint(weights, last_improvement)
        if step % 25 == 0 or step == through:
            print(f"{stage} {step}/{through} {best}", flush=True)


def train(stage, cold):
    end = VALIDATION if stage == "development" else TEST_START
    inputs, market = Inputs(Dataset()), Market()
    if cold:
        scale = inputs.scale(inputs.data.span(BEGIN, end))
        value, _ = fit_value(inputs, "development" if stage == "development" else "final", True, scale)
        encoder = value.context.eval()
    else:
        value, exits, scale = pretrained_heads(inputs, stage)
        encoder = copy.deepcopy(exits.context).double().eval()
    window = Window(inputs, encoder, scale, BEGIN, end, end)
    rng = np.random.default_rng(SEED)
    weights = initial_heads(window.x, rng) if cold else fitted_heads(inputs, window, end, value, exits, scale)
    start_weights = weights.copy()
    snapshots, records = {}, []
    search(stage, market, window, weights, rng, records, snapshots, 0, STEPS, cold=cold)
    path = OUTPUT / f"{stage}.pt"
    save_bundle(path, dict(encoder=encoder.state_dict(), scale=scale, norm=window.norm, heads=snapshots,
                           columns=BASE_COLUMNS, fit_start=iso(BEGIN), fit_end=iso(end), seed=SEED,
                           start_weights=start_weights))
    save_json(OUTPUT / f"{stage}.json", dict(updates=STEPS, model=file_hash(path), records=records))


def load_encoder(state):
    dtype = next(iter(state["encoder"].values())).dtype
    encoder = Context(True).to(dtype=dtype)
    encoder.load_state_dict(state["encoder"])
    return encoder.eval()


def model(stage, directory=None):
    directory = directory if directory is not None else OUTPUT
    path = directory / f"{stage}.pt"
    assert file_hash(path) == load(directory / f"{stage}.json")["model"]
    state = torch.load(path, weights_only=False)
    return state, load_encoder(state)


def recover_search(state, records):
    """Recover the RNG and stagnation counter from a completed fit without RNG snapshots."""
    rng = np.random.default_rng(state["seed"])
    weights = state["start_weights"].copy()
    last_improvement = 0
    for step, record in enumerate(records):
        assert step == record["step"]
        if step:
            trial = propose(weights, rng, step, step - last_improvement)
            if record["accepted"]:
                weights = trial
                last_improvement = step
        if step in state["heads"]:
            np.testing.assert_array_equal(weights, state["heads"][step])
    return rng, last_improvement


def fit_saved(stage, through, criterion):
    """Reuse the original encoder and scaler. A changed objective starts at iteration zero."""
    source = load(INITIAL_FIT / f"{stage}.json")
    state, encoder = model(stage, INITIAL_FIT)
    start = 0 if criterion == WORST_NET else source["updates"]
    if (OUTPUT / f"{stage}.json").exists():
        finished = load(OUTPUT / f"{stage}.json")
        if (finished["updates"] != through or finished["source_model"] != source["model"]
                or finished.get("criterion", JOINT) != criterion):
            raise ValueError("existing fit uses another iteration count, source model or objective")
        model(stage)
        print(f"{stage} finished at iteration {through}", flush=True)
        return
    assert source["updates"] == STEPS and len(source["records"]) == STEPS + 1
    assert STEPS in state["heads"] and state["columns"] == BASE_COLUMNS
    end = VALIDATION if stage == "development" else TEST_START
    assert state["fit_start"] == iso(BEGIN) and state["fit_end"] == iso(end)
    settings = dict(source_model=source["model"], source_records=file_hash(INITIAL_FIT / f"{stage}.json"),
                    through=through, stage=stage)
    if criterion == WORST_NET:
        settings.update(criterion=criterion, min_closed=MIN_CLOSED, min_win_percent=MIN_WIN_PERCENT,
                        start_iteration=start)
    progress = OUTPUT / f"{stage}-progress.pt"
    rng = np.random.default_rng(state["seed"])
    if progress.exists():
        saved = torch.load(progress, weights_only=False)
        if saved["settings"] != settings:
            raise ValueError(f"resume checkpoint settings differ in {progress}")
        weights, last_improvement = saved["weights"], saved["last_improvement"]
        records, snapshots = saved["records"], saved["snapshots"]
        rng.bit_generator.state = saved["rng"]
    elif start:
        records, snapshots = source["records"], state["heads"].copy()
        rng, last_improvement = recover_search(state, records)
        weights = snapshots[start].copy()
    else:
        weights = state["start_weights"].copy()
        records, snapshots, last_improvement = [], {}, 0
    print(f"{stage}: {criterion}, {len(records)} recorded evaluations, {through} updates", flush=True)

    def checkpoint(current, last):
        save_bundle(progress, dict(settings=settings, weights=current, last_improvement=last,
                                   records=records, snapshots=snapshots, rng=rng.bit_generator.state))

    checkpoint(weights, last_improvement)
    inputs, market = Inputs(Dataset()), Market()
    window = Window(inputs, encoder, state["scale"], BEGIN, end, end, state["norm"])
    if records:
        books, _ = window.evaluate(market, weights, close_book=True, score_only=True)
        assert objective(books, criterion) == records[-1]["incumbent"]
    search(stage, market, window, weights, rng, records, snapshots, last_improvement, through,
           checkpoint=checkpoint, criterion=criterion)
    assert records[0]["books"] == source["records"][0]["books"]
    path = OUTPUT / f"{stage}.pt"
    provenance = (dict(criterion=criterion, start_iteration=0) if criterion == WORST_NET
                  else dict(continuation_from=start))
    state.update(heads=snapshots, source_model=source["model"], **provenance)
    save_bundle(path, state)
    save_json(OUTPUT / f"{stage}.json", dict(updates=through, model=file_hash(path), records=records,
              source_model=source["model"], source_records=settings["source_records"], **provenance))


def audited(name, market, mark, close_book, books, ledgers, criterion=JOINT, directory=None):
    path = (OUTPUT if directory is None else directory) / f"{name}-trades.jsonl.gz"
    experiment.export_ledger(path, [(name, ledgers)])
    audit = verify_ledger(market, path, mark, close_book, {name: books})
    for mode in SCENARIOS:
        b, trades = books[mode], ledgers[mode]
        assert len(trades) == b["fills"]
        if close_book:
            assert len(trades) == b["closed"] and not b["ending_open"]
        assert math.isclose(math.fsum(t["net"] for t in trades if t["net"] is not None)
                            + b["open_marked_pnl"], b["net"], abs_tol=1e-7)
    return dict(modes=books, objective=objective(books, criterion), ledger=file_hash(path), audit=audit)


def audit_frozen_inference(inputs, encoder, state, ledgers):
    decisions = inputs.data.decisions
    levels_checked = 0
    for trades in ledgers.values():
        for trade in trades:
            a, b = np.searchsorted(decisions["at"], [trade["decision"], trade["decision"] + 1])
            rows = np.flatnonzero(decisions["asset"][a:b] == trade["asset"]) + a
            assert len(rows) == 1
            snapshot = dict(zip(BASE_COLUMNS, inputs.data.market[rows[0]], strict=True))
            bars = [dict(zip(HISTORY_COLUMNS, bar, strict=True)) for bar in inputs.history[rows[0]]]
            proposals = propose_state(state, encoder, snapshot, bars, trade["paid"])
            chosen = proposals["long" if trade["sign"] == 1 else "short"]
            prices = [chosen["tp"], chosen["sl"]]
            np.testing.assert_allclose(prices, [trade["target"], trade["stop"]], rtol=3e-6)
            assert chosen["preference_per_unit"] > 0
            levels_checked += 2
    return levels_checked


def replay_reference_150(inputs, market, desk_hash):
    original = load(INITIAL_FIT / "results.json")
    assert original["selection_step"] == 150 and original["desk"] == desk_hash
    assert original["backtest_entries"] == [iso(TEST_START), iso(TEST_STOP)] and original["valuation"] == iso(MARK_STOP)
    path = INITIAL_FIT / "frozen.pt"
    assert file_hash(path) == original["frozen"]
    state = torch.load(path, weights_only=False)
    assert state["step"] == 150 and state["desk_hash"] == desk_hash and state["fit_end"] == iso(TEST_START)
    window = Window(inputs, load_encoder(state), state["scale"], TEST_START, TEST_STOP, MARK_STOP, state["norm"])
    books, ledgers = window.evaluate(market, state["weights"], close_book=False)
    assert books == original["backtest"]["modes"]
    previous = INITIAL_FIT / "backtest-trades.jsonl.gz"
    assert file_hash(previous) == original["backtest"]["ledger"]
    with gzip.open(previous, "rt", encoding="utf-8") as stream:
        for mode, trades in ledgers.items():
            for trade in trades:
                assert json.loads(next(stream)) == dict(experiment="backtest", mode=mode, **trade)
        assert stream.readline() == ""
    return dict(**audited("reference-150", market, MARK_STOP, False, books, ledgers, WORST_NET),
                frozen=original["frozen"], original_ledger=original["backtest"]["ledger"], step=150)


def finish(criterion=JOINT):
    inputs, market = Inputs(Dataset()), Market()
    state, encoder = model("development")
    validation = Window(inputs, encoder, state["scale"], VALIDATION, TEST_START, TEST_START, state["norm"])
    scores, winner = {}, None
    for step, weights in sorted(state["heads"].items()):
        books, ledgers = validation.evaluate(market, weights, close_book=True)
        scores[step] = objective(books, criterion)
        if winner is None or priority(scores[step]) > priority(scores[winner]):
            winner, best_books, best_ledgers = step, books, ledgers
    validated = audited("validation", market, TEST_START, True, best_books, best_ledgers, criterion)
    selection = dict(selected_step=winner, checkpoints=scores, validation=validated)
    if criterion == WORST_NET:
        qualifying = [step for step, score in scores.items() if score["constraints_met"]]
        selection.update(criterion=criterion, qualifying_steps=qualifying,
                         selection_basis="maximum_feasible_worst_net" if qualifying else "infeasible_comparison_only",
                         validation_entries=[iso(VALIDATION), iso(TEST_START)])
    continued = [step for step in scores if criterion == JOINT and step > STEPS]
    if continued:
        selection["selected_added_step"] = max(continued, key=lambda step: priority(scores[step]))
    save_json(OUTPUT / "selection.json", selection)

    state, encoder = model("final")
    heads = state.pop("heads")
    assert set(heads) == set(scores)
    weights = heads[winner]
    start = state.pop("start_weights", None)
    changed = (np.max(np.abs(weights - start), axis=0).tolist() if start is not None else None)
    frozen_path = OUTPUT / "frozen.pt"
    desk_hash = file_hash(HERE.parent.parent / "bracket-exits/desk-mandate.json")
    if criterion == WORST_NET:
        assert state["criterion"] == criterion
        state.update(minimum_win_percent=MIN_WIN_PERCENT, validation_qualified=bool(qualifying))
    save_bundle(frozen_path, dict(**state, weights=weights, step=winner,
                                  outputs=["long_preference","short_preference","long_tp","long_sl","short_tp","short_sl"],
                                  minimum_closed=MIN_CLOSED, desk_hash=desk_hash))
    frozen_hash = file_hash(frozen_path)
    frozen = torch.load(frozen_path, weights_only=False)
    encoder.load_state_dict(frozen["encoder"])
    manifest = load(OUTPUT / "final.json")
    records = manifest["records"]
    results = {}
    for name, begin, end, mark, close_book in (
            ("training", BEGIN, TEST_START, TEST_START, True),
            ("backtest", TEST_START, TEST_STOP, MARK_STOP, False)):
        window = Window(inputs, encoder, frozen["scale"], begin, end, mark, frozen["norm"])
        books, ledgers = window.evaluate(market, frozen["weights"], close_book=close_book)
        results[name] = audited(name, market, mark, close_book, books, ledgers, criterion)
        if name == "backtest":
            results[name]["independently_quoted_levels"] = audit_frozen_inference(inputs, encoder, frozen, ledgers)
            if continued:
                comparison = {}
                for step in sorted({STEPS, manifest["updates"], selection["selected_added_step"]}):
                    if step == winner:
                        comparison[step] = results[name]
                        continue
                    alternate, trades = window.evaluate(market, heads[step], close_book=False)
                    comparison[step] = audited(f"iteration-{step}", market, mark, False, alternate, trades)
                results["checkpoint_backtests"] = comparison
        if close_book:
            ref = records[winner]["incumbent"]
            actual = results[name]["objective"]
            for field in ("min_closed", "worst_win_rate", "target_met"):
                assert ref[field] == actual[field]
            np.testing.assert_allclose(ref["worst_net"], actual["worst_net"], rtol=0, atol=1e-8)
    assert file_hash(frozen_path) == frozen_hash
    if criterion == WORST_NET:
        results["reference_150"] = replay_reference_150(inputs, market, desk_hash)
        results.update(criterion=criterion, validation_selection_basis=selection["selection_basis"],
                       profitable_and_qualified=results["backtest"]["objective"]["target_met"],
                       dataset_manifest=file_hash(HERE.parent / "dataset.json"),
                       replay_source=file_hash(HERE / "payoff_replay.py"), trainer_source=file_hash(__file__))
    else:
        results["prior_ordered"] = replay_prior_ordered(inputs, market)
    save_json(OUTPUT / "results.json", dict(**results, validation=validated, selection_step=winner,
              iterations=manifest["updates"], continuation_from=manifest.get("continuation_from"),
              frozen=frozen_hash, coefficient_change_per_head=changed,
              retrospective=True, backtest_entries=[iso(TEST_START),iso(TEST_STOP)],
              valuation=iso(MARK_STOP), target_closed=MIN_CLOSED, target_win_rate=MIN_WIN_PERCENT/100,
              desk=desk_hash))
    print("Selected", winner, "test", results["backtest"]["objective"], flush=True)


def replay_prior_ordered(inputs, market):
    from payoff_models import predict
    prior_spec = load(PRETRAINED / "ordered-fit.json")["models"]["ordered-neural"]
    value, exits, scale = load_model("ordered-neural", prior_spec["model"])
    span = inputs.data.span(TEST_START, TEST_STOP)
    distances, forecasts = predict(inputs, span, value, exits, scale, False)
    schedule = Schedule(inputs.data.decisions[span])
    vol = volatility(inputs.data, span)
    books, ledgers = {}, {}
    for mode in SCENARIOS:
        books[mode], ledgers[mode], _ = replay(market, schedule, distances, forecasts, vol, mode,
                                               TEST_START, MARK_STOP, record_plan=False)
    return audited("prior", market, MARK_STOP, False, books, ledgers)


def propose_state(state, encoder, snapshot, bars, fill):
    """Quote both directions from an as-of snapshot and the last 24 completed bars, oldest first."""
    if not np.isfinite(fill) or fill <= 0:
        raise ValueError("fill must be a positive, finite price")
    if len(bars) != LAGS:
        raise ValueError(f"expected {LAGS} completed five-minute bars")
    market = np.array([[snapshot[name] for name in BASE_COLUMNS]], dtype="f4")
    history = np.array([[[bar[name] for name in HISTORY_COLUMNS] for bar in bars]], dtype="f4")
    if np.isinf(market).any() or np.isinf(history).any():
        raise ValueError("found an infinite input")
    sigma = market[:, BASE_COLUMNS.index(VOL_COLUMN)]
    if not np.isfinite(sigma).all() or (sigma < 0).any():
        raise ValueError("expected finite, nonnegative trailing volatility")
    values, sequence = market_batch(market, history, state["scale"])
    x = normalized(with_history(tensor(values), sequence, encoder), state["norm"])
    dist = exit_distances(x, realized_volatility(sigma), state["weights"])[0]
    preferences = (x @ state["weights"][:, :2])[0]
    out = {}
    for side, (label, sign) in enumerate((("long", 1), ("short", -1))):
        tp, sl = price_levels(fill, sign, dist[side])
        out[label] = dict(tp=tp, sl=sl, preference_per_unit=float(preferences[side]))
    return out


def quote(symbol, at, fill, state_file):
    if not np.isfinite(fill) or fill <= 0:
        raise ValueError("fill must be a positive, finite price")
    frozen = OUTPUT / "frozen.pt"
    assert file_hash(frozen) == load(OUTPUT / "results.json")["frozen"]
    state = torch.load(frozen, weights_only=False)
    encoder = load_encoder(state)
    if state_file:
        with open(state_file, encoding="utf-8") as stream:
            payload = json.load(stream)
        proposals = propose_state(state, encoder, payload["snapshot"], payload["bars"], fill)
        print(json.dumps(dict(fill=fill, proposals=proposals), indent=2))
        return
    inputs = Inputs(Dataset())
    stamps = inputs.data.decisions["at"]
    stamp = ms(at)
    a, b = np.searchsorted(stamps, [stamp, stamp + 1])
    rows = np.flatnonzero(inputs.data.decisions["asset"][a:b] == SYMBOLS.index(symbol)) + a
    if len(rows) != 1:
        raise ValueError("No eligible decision for that symbol and exact UTC decision timestamp")
    snapshot = dict(zip(BASE_COLUMNS, inputs.data.market[rows[0]], strict=True))
    bars = [dict(zip(HISTORY_COLUMNS, bar, strict=True)) for bar in inputs.history[rows[0]]]
    out = propose_state(state, encoder, snapshot, bars, fill)
    print(json.dumps(dict(symbol=symbol, decision=iso(stamp), fill=fill, proposals=out), indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("development", "final", "evaluate", "quote"))
    parser.add_argument("--symbol")
    parser.add_argument("--at")
    parser.add_argument("--state-file", help="JSON containing the current snapshot and 24 ordered bars")
    parser.add_argument("--fill-price", type=float)
    parser.add_argument("--cold-start", action="store_true", help="reproduce the initial diagnostic run")
    parser.add_argument("--extend-to", type=int, metavar="ITERATION",
                        help="continue the completed 250-iteration fit to this total in a separate directory")
    parser.add_argument("--objective", choices=(JOINT, WORST_NET), default=JOINT,
                        help="worst-net maximizes the smaller scenario P&L subject to both portfolio minimums")
    parser.add_argument("--iterations", type=int, help="fresh worst-net updates per fit (default 500)")
    args = parser.parse_args()
    stage = args.stage
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    if args.objective == WORST_NET:
        if args.cold_start or args.extend_to is not None:
            parser.error("worst-net uses a fresh search from the original fitted initialization")
        iterations = CONSTRAINED_UPDATES if args.iterations is None else args.iterations
        if iterations < 1:
            parser.error("--iterations must be positive")
        OUTPUT = INITIAL_FIT.with_name(f"worst-net-{iterations}")
    elif args.iterations is not None:
        parser.error("--iterations requires --objective worst-net")
    elif args.extend_to is not None:
        if args.cold_start or args.extend_to <= STEPS:
            parser.error("--extend-to must exceed 250 and requires the fitted-heads run")
        OUTPUT = INITIAL_FIT.with_name(f"fitted-heads-{args.extend_to}")
    elif args.cold_start:
        OUTPUT = FIRST_PASS
    OUTPUT.mkdir(exist_ok=True, parents=True)
    with ExitStack() as locks:
        lock_name = "evaluate" if stage == "quote" else stage
        lock = locks.enter_context((OUTPUT / f".{lock_name}.lock").open("a"))
        fcntl.flock(lock, fcntl.LOCK_SH if stage == "quote" else fcntl.LOCK_EX | fcntl.LOCK_NB)
        if stage == "quote":
            if args.fill_price is None or (not args.state_file and (args.symbol is None or args.at is None)):
                parser.error("quote needs --fill-price and either --state-file or --symbol and --at")
            quote(args.symbol, args.at, args.fill_price, args.state_file)
        elif stage == "evaluate":
            for fit_stage in ("development", "final"):
                fit_lock = locks.enter_context((OUTPUT / f".{fit_stage}.lock").open("a"))
                fcntl.flock(fit_lock, fcntl.LOCK_SH)
            finish(args.objective)
        elif args.objective == WORST_NET:
            fit_saved(stage, iterations, args.objective)
        elif args.extend_to is not None:
            fit_saved(stage, args.extend_to, args.objective)
        else:
            train(stage, args.cold_start)
