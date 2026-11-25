"""Train the full wide-history policy against the exact desk portfolio replay."""
import argparse
import fcntl
import json
from contextlib import ExitStack

import numpy as np

from payoff_data import BEGIN, VALIDATION, Dataset, Market, volatility
from payoff_models import Context, Inputs, torch
from payoff_history import HISTORY_COLUMNS
from payoff_replay import price_levels
from settings import MARK_STOP, SYMBOLS, TEST_START, TEST_STOP, file_hash, iso, load, ms, save_json
from train_portfolio import (BASE_COLUMNS, CONSTRAINED_UPDATES, FIRST_PASS, MIN_CLOSED,
                             MIN_WIN_PERCENT, SEED, WORST_NET, audited, exit_distances, load_encoder, normalized,
                             objective, priority, propose, replay_policy, save_bundle)

HISTORY_CHANNELS = 240
SOURCE = FIRST_PASS / f"worst-net-{CONSTRAINED_UPDATES}"
HISTORY_BATCH = 4096
DESK = FIRST_PASS.parent.parent.parent / "bracket-exits/desk-mandate.json"


def run_path(steps):
    return FIRST_PASS / f"end-to-end-{HISTORY_CHANNELS}-{steps}"


class WideContext(Context):
    """Evaluate the causal stack at the most recent bar."""
    def __init__(self):
        super().__init__(True, HISTORY_CHANNELS)

    def forward(self, x, bars):
        # The last output needs three third-layer positions, spaced eight bars apart.
        # Earlier layers consume only odd positions because their downstream dilations are even.
        hidden = bars.transpose(1, 2)
        for conv, (padding, stride, dilation) in zip(
            self.convolutions, ((1, 2, 1), (2, 1, 1), (1, 4, 2), (0, 1, 1)), strict=True
        ):
            hidden = torch.tanh(torch.nn.functional.conv1d(
                torch.nn.functional.pad(hidden, (padding, 0)), conv.weight, conv.bias,
                stride=stride, dilation=dilation))
        return self.dense(torch.cat((x, hidden.squeeze(-1)), dim=1))


def wide_encoder(state, device):
    encoder = WideContext().to(device)
    encoder.load_state_dict(state["encoder"])
    return encoder.eval()


@torch.no_grad()
def widen(original, channels=HISTORY_CHANNELS):
    """Replicate channels and share outgoing weights to preserve the initialized function."""
    width = original.convolutions[0].out_channels
    if channels < width or channels % width:
        raise ValueError("history width must be an integer multiple of the original width")
    repeats = channels // width
    expanded = Context(True, channels).to(dtype=next(original.parameters()).dtype)
    for i, (old, new) in enumerate(zip(original.convolutions, expanded.convolutions, strict=True)):
        weights = old.weight.repeat_interleave(repeats, dim=0)
        if i:
            weights = weights.repeat_interleave(repeats, dim=1) / repeats
        new.weight.copy_(weights)
        new.bias.copy_(old.bias.repeat_interleave(repeats))
    old, new = original.dense[0], expanded.dense[0]
    snap = old.in_features - width
    new.weight[:, :snap].copy_(old.weight[:, :snap])
    new.weight[:, snap:].copy_(old.weight[:, snap:].repeat_interleave(repeats, dim=1) / repeats)
    new.bias.copy_(old.bias)
    for old, new in zip(original.dense[2:], expanded.dense[2:], strict=True):
        new.load_state_dict(old.state_dict())
    return expanded.eval()


@torch.no_grad()
def new_candidate(current, heads, initial_rms, rng, step, stale):
    updated_heads = propose(heads, rng, step, stale)
    if step % 2:
        updated_heads = heads + .125 * (updated_heads - heads)
    strength = rng.choice([.006, .018, .05, .12]) * .70 ** min(stale // 20, 5)
    layers = ("convolutions.0", "convolutions.1", "convolutions.2", "convolutions.3",
              "dense.0", "dense.2", "dense.4", "dense.6")
    focus_layer = layers[step % len(layers)]
    updated = {}
    for key, weight in current.items():
        # Small joint moves plus occasional larger steps in a single layer.
        focus = 3 if key.rsplit(".", 1)[0] == focus_layer else 1
        noise = rng.standard_normal(weight.shape, dtype=np.float32)
        updated[key] = weight + torch.from_numpy(noise) * (strength * focus * initial_rms[key])
    return updated, updated_heads


class Window:
    def __init__(self, inputs, state, device, begin, end, mark):
        self.begin, self.mark = begin, mark
        self.device = device
        self.norm = state["norm"]
        span = inputs.data.span(begin, end)
        self.rows = inputs.data.decisions[span]
        self.vol = volatility(inputs.data, span)
        self.blocks = [
            (x.to(device), bars.to(device))
            for start in range(span.start, span.stop, HISTORY_BATCH)
            for x, bars in [inputs.batch(np.arange(start, min(start + HISTORY_BATCH, span.stop)),
                                         state["scale"], True, False)]
        ]
        self.snapshot = torch.cat([x[:, :len(BASE_COLUMNS)] for x, _ in self.blocks]).cpu().numpy()

    @torch.inference_mode()
    def encode(self, encoder):
        hidden = torch.cat([encoder(x, bars) for x, bars in self.blocks]).cpu().numpy()
        return normalized(np.column_stack((self.snapshot, hidden)), self.norm)

    def evaluate(self, market, encoder, weights, *, close_book, score_only=False):
        return replay_policy(market, self.rows, self.vol, self.begin, self.mark, self.encode(encoder), weights,
                             close_book=close_book, score_only=score_only)


def source_model(stage):
    path = SOURCE / f"{stage}.pt"
    digest = file_hash(path)
    manifest = load(SOURCE / f"{stage}.json")
    assert digest == manifest["model"] and manifest["criterion"] == WORST_NET
    state = torch.load(path, map_location="cpu", weights_only=False)
    step = load(SOURCE / "selection.json")["selected_step"]
    return state, step, digest


def fit(directory, stage, steps, device):
    source, start_step, digest = source_model(stage)
    model_path = directory / f"{stage}.pt"
    manifest = directory / f"{stage}.json"
    progress = directory / f"{stage}-progress.pt"
    end = VALIDATION if stage == "development" else TEST_START
    settings = dict(step_budget=steps, source_step=start_step, source_sha256=digest, criterion=WORST_NET,
                    history_channels=HISTORY_CHANNELS, minimum_closed=MIN_CLOSED, minimum_win_percent=MIN_WIN_PERCENT,
                    fit_start=iso(BEGIN), fit_end=iso(end), device=str(device), torch=torch.__version__,
                    desk=file_hash(DESK), dataset=file_hash(FIRST_PASS.parent.parent / "dataset.json"),
                    implementation=file_hash(__file__))
    if manifest.exists():
        saved = load(manifest)
        assert saved["settings"] == settings and saved["model"] == file_hash(model_path)
        print(f"{stage} already has {steps} updates", flush=True)
        return

    assert source["fit_start"] == iso(BEGIN) and source["fit_end"] == iso(end)
    original = load_encoder(source)
    expanded = widen(original)
    start = {name: weight.float() for name, weight in expanded.state_dict().items()}
    initial_rms = {
        name: max(float(weight.square().mean().sqrt()), .025 if weight.ndim == 1 else .002)
        * (np.sqrt(HISTORY_CHANNELS / original.convolutions[0].out_channels)
           if weight.ndim == 3 and weight.shape[1] == HISTORY_CHANNELS else 1.)
        for name, weight in start.items()
    }
    state = dict(scale=source["scale"], norm=source["norm"], history_channels=HISTORY_CHANNELS)
    weights = source["heads"][start_step].copy()
    rng = np.random.default_rng(SEED)
    records, checkpoints = [], {}
    current, last = start, 0
    if progress.exists():
        saved = torch.load(progress, map_location="cpu", weights_only=False)
        if saved["settings"] != settings:
            raise ValueError(f"training settings differ from {progress}")
        current, weights, last = saved["current"], saved["weights"], saved["last"]
        records, checkpoints = saved["records"], saved["checkpoints"]
        rng.bit_generator.state = saved["rng"]

    encoder = wide_encoder(dict(encoder=start), device)
    window = Window(Inputs(Dataset()), state, device, BEGIN, end, end)
    market = Market()
    best = records[-1]["incumbent"] if records else None
    print(f"{stage}: {len(window.rows):,} decisions, {len(records)} evaluations recorded", flush=True)
    for step in range(len(records), steps + 1):
        trial, heads = new_candidate(current, weights, initial_rms, rng, step, step - last) if step else (current, weights)
        encoder.load_state_dict(trial)
        books, _ = window.evaluate(market, encoder, heads, close_book=True, score_only=True)
        score = objective(books, WORST_NET)
        accepted = best is None or priority(score) > priority(best)
        if accepted:
            current, weights, best, last = trial, heads, score, step
        records.append(dict(step=step, accepted=accepted, incumbent=best, candidate=score,
                            books={mode: {k: b[k] for k in ("net", "closed", "wins", "fills", "cutoff_closes")}
                                   for mode, b in books.items()}))
        if step % 50 == 0 or step == steps:
            checkpoints[step] = dict(encoder=current, weights=weights)
        if step % 10 == 0 or step == steps:
            save_bundle(progress, dict(settings=settings, records=records, checkpoints=checkpoints,
                                       current=current, weights=weights, last=last, rng=rng.bit_generator.state))
        if step % 25 == 0 or step == steps:
            print(f"{stage} {step}/{steps} {best}", flush=True)
    save_bundle(model_path, dict(**state, settings=settings, checkpoints=checkpoints))
    save_json(manifest, dict(settings=settings, updates=steps, records=records, model=file_hash(model_path)))


def read_fit(directory, stage):
    path = directory / f"{stage}.pt"
    manifest = load(directory / f"{stage}.json")
    assert file_hash(path) == manifest["model"]
    state = torch.load(path, map_location="cpu", weights_only=False)
    assert state["settings"] == manifest["settings"]
    return state, manifest


@torch.inference_mode()
def audit_quotes(inputs, frozen, trades):
    # Reconstruct from stored decision inputs with the full causal stack in double precision.
    encoder = Context(True, HISTORY_CHANNELS).double().eval()
    encoder.load_state_dict(frozen["encoder"])
    all_trades = [trade for mode in trades.values() for trade in mode]
    maximum_error = 0.
    decisions = inputs.data.decisions
    for start in range(0, len(all_trades), 96):
        block = all_trades[start:start + 96]
        rows = []
        for trade in block:
            a, b = np.searchsorted(decisions["at"], [trade["decision"], trade["decision"] + 1])
            found = np.flatnonzero(decisions["asset"][a:b] == trade["asset"])
            assert len(found) == 1
            rows.append(a + found[0])
        x, bars = inputs.batch(np.array(rows), frozen["scale"], True, False)
        hidden = encoder(x.double(), bars.double()).numpy()
        features = normalized(np.column_stack((x[:, :len(BASE_COLUMNS)].numpy(), hidden)), frozen["norm"])
        distances = exit_distances(features, volatility(inputs.data, rows), frozen["weights"])
        preferences = features @ frozen["weights"][:, :2]
        for j, trade in enumerate(block):
            side = int(trade["sign"] < 0)
            prices = price_levels(trade["paid"], trade["sign"], distances[j, side])
            actual = np.array([trade["target"], trade["stop"]])
            maximum_error = max(maximum_error, float(np.max(np.abs(prices / actual - 1))))
            np.testing.assert_allclose(prices, actual, atol=0, rtol=1e-4)
            assert preferences[j, side] > 0
    return dict(prices_checked=2*len(all_trades), max_relative_difference=maximum_error)


def evaluate(directory, device):
    inputs, market = Inputs(Dataset()), Market()
    development, _ = read_fit(directory, "development")
    assert development["settings"]["device"] == str(device)
    valid = Window(inputs, development, device, VALIDATION, TEST_START, TEST_START)
    scores, winner, saved = {}, None, None
    for step, state in sorted(development["checkpoints"].items()):
        books, trades = valid.evaluate(market, wide_encoder(state, device), state["weights"], close_book=True)
        scores[step] = objective(books, WORST_NET)
        if winner is None or priority(scores[step]) > priority(scores[winner]):
            winner, saved = step, (books, trades)
    del valid
    qualified = [step for step, metrics in scores.items() if metrics["constraints_met"]]
    validation = audited("validation", market, TEST_START, True, *saved, WORST_NET, directory)
    basis = "maximum_feasible_worst_net" if qualified else "infeasible_comparison_only"
    save_json(directory / "selection.json", dict(selected_step=winner, qualifying_steps=qualified, selection_basis=basis,
                                                  checkpoints=scores, validation=validation))
    print(f"Validation picked {winner}, {len(qualified)} qualifying checkpoints, {scores[winner]}", flush=True)

    final, manifest = read_fit(directory, "final")
    assert final["settings"]["device"] == str(device)
    selected = final["checkpoints"][winner]
    start = final["checkpoints"][0]
    changes = {name: float((weight - start["encoder"][name]).abs().max())
               for name, weight in selected["encoder"].items()}
    frozen_path = directory / "frozen.pt"
    save_bundle(frozen_path, dict(**selected, scale=final["scale"], norm=final["norm"], step=winner,
                                  history_channels=HISTORY_CHANNELS, criterion=WORST_NET,
                                  validation_qualified=bool(qualified), minimum_closed=MIN_CLOSED,
                                  minimum_win_percent=MIN_WIN_PERCENT, desk=final["settings"]["desk"]))
    digest = file_hash(frozen_path)
    frozen = torch.load(frozen_path, map_location="cpu", weights_only=False)
    encoder = wide_encoder(frozen, device)
    results = {}
    for name, start_date, end, mark, close_book in (
        ("training", BEGIN, TEST_START, TEST_START, True),
        ("backtest", TEST_START, TEST_STOP, MARK_STOP, False),
    ):
        window = Window(inputs, frozen, device, start_date, end, mark)
        books, trades = window.evaluate(market, encoder, frozen["weights"], close_book=close_book)
        results[name] = audited(name, market, mark, close_book, books, trades, WORST_NET, directory)
        if close_book:
            recorded = manifest["records"][winner]["incumbent"]
            actual = results[name]["objective"]
            assert actual["min_closed"] == recorded["min_closed"] and actual["worst_win_rate"] == recorded["worst_win_rate"]
            np.testing.assert_allclose(actual["worst_net"], recorded["worst_net"], rtol=0, atol=1e-8)
        else:
            results[name]["independently_quoted_levels"] = audit_quotes(inputs, frozen, trades)
        del window
    assert digest == file_hash(frozen_path)
    reference = load(SOURCE / "results.json")
    assert reference["desk"] == frozen["desk"] and reference["valuation"] == iso(MARK_STOP)
    assert reference["backtest_entries"] == [iso(TEST_START), iso(TEST_STOP)]
    for key, filename in (("backtest", "backtest"), ("reference_150", "reference-150")):
        assert reference[key]["ledger"] == file_hash(SOURCE / f"{filename}-trades.jsonl.gz")
    save_json(directory / "results.json",
              dict(**results, validation=validation, selection_step=winner, validation_selection_basis=basis,
                   iterations=manifest["updates"], frozen=digest, encoder_weight_changes=changes,
                   head_weight_changes=np.abs(selected["weights"] - start["weights"]).max(axis=0).tolist(),
                   encoder_parameters=sum(t.numel() for t in selected["encoder"].values()),
                   history_channels=HISTORY_CHANNELS, retrospective=True, criterion=WORST_NET,
                   backtest_entries=[iso(TEST_START), iso(TEST_STOP)], valuation=iso(MARK_STOP),
                   target_closed=MIN_CLOSED, target_win_rate=MIN_WIN_PERCENT/100, desk=frozen["desk"],
                   previous_frozen=reference["backtest"], reference_150=reference["reference_150"]))
    print(f"Backtest {results['backtest']['objective']}", flush=True)


@torch.no_grad()
def quote(directory, symbol, at, fill, state_file):
    from train_portfolio import propose_state

    path = directory / "frozen.pt"
    assert file_hash(path) == load(directory / "results.json")["frozen"]
    frozen = torch.load(path, map_location="cpu", weights_only=False)
    encoder = wide_encoder(frozen, torch.device("cpu"))
    if state_file:
        with open(state_file, encoding="utf-8") as stream:
            payload = json.load(stream)
        snapshot, bars = payload["snapshot"], payload["bars"]
    else:
        inputs = Inputs(Dataset())
        stamp = ms(at)
        a, b = np.searchsorted(inputs.data.decisions["at"], [stamp, stamp + 1])
        rows = np.flatnonzero(inputs.data.decisions["asset"][a:b] == SYMBOLS.index(symbol)) + a
        if len(rows) != 1:
            raise ValueError("no eligible decision at that timestamp and symbol")
        snapshot = dict(zip(BASE_COLUMNS, inputs.data.market[rows[0]], strict=True))
        bars = [dict(zip(HISTORY_COLUMNS, bar, strict=True)) for bar in inputs.history[rows[0]]]
    print(json.dumps(dict(fill=fill, proposals=propose_state(frozen, encoder, snapshot, bars, fill)), indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["development", "final", "evaluate", "quote"])
    parser.add_argument("--iterations", type=int, default=CONSTRAINED_UPDATES)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    parser.add_argument("--symbol")
    parser.add_argument("--at")
    parser.add_argument("--fill-price", type=float)
    parser.add_argument("--state-file")
    args = parser.parse_args()
    if args.iterations < 1:
        parser.error("--iterations must be positive")
    if args.stage == "quote" and (args.fill_price is None or not (args.state_file or args.symbol and args.at)):
        parser.error("quote requires --fill-price and a state file or symbol and timestamp")
    if args.stage != "quote" and args.device == "cuda" and not torch.cuda.is_available():
        parser.error("CUDA runtime unavailable. Set CENTRYPTO_TORCH_RUNTIME or use --device cpu.")
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.deterministic = True
    torch.backends.cuda.matmul.allow_tf32 = False
    directory = run_path(args.iterations)
    directory.mkdir(exist_ok=True)
    device = torch.device(args.device)
    with ExitStack() as locks:
        name = "evaluate" if args.stage == "quote" else args.stage
        lock = locks.enter_context((directory / f".{name}.lock").open("a"))
        fcntl.flock(lock, fcntl.LOCK_SH if args.stage == "quote" else fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.stage == "evaluate":
            for stage in ("development", "final"):
                lock = locks.enter_context((directory / f".{stage}.lock").open("a"))
                fcntl.flock(lock, fcntl.LOCK_SH)
            evaluate(directory, device)
        elif args.stage == "quote":
            quote(directory, args.symbol, args.at, args.fill_price, args.state_file)
        else:
            fit(directory, args.stage, args.iterations, device)


if __name__ == "__main__":
    main()
