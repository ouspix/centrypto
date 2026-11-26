"""Replay frozen Centrypto policies and matched controls against the original decision tape."""
import argparse
import gzip
import json
from pathlib import Path
import sys

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from payoff_data import (BEGIN, Dataset, LIMITS, MIN_NOTIONAL, MODES, Market, SIGNS,
                         VALIDATION, initial_size, minute, volatility)
from autonomous_data import STORE
from autonomous_replay import CUTOFF, Schedule
from payoff_models import BASE_COLUMNS, Inputs, predict, torch
from payoff_history import HISTORY, MANIFEST
from payoff_replay import price_levels, replay
from run_payoff import OUTPUT as PRIOR, load_model
from settings import FEE, MARK_STOP, ORIGINAL_REPORT, TEST_START, TEST_STOP, file_hash, iso, load, ms, save_json
from source_data import FUNDING, GRID
from train_end_to_end import HISTORY_BATCH, read_fit, run_path, wide_encoder
from train_portfolio import exit_distances, normalized

CHECKPOINT = run_path(500)
FIXED_SPEC = HERE.parents[2] / "bracket-exits/selection.json"
RANDOM_SEED = 20261125
HORIZONS = (24 * 60, 7 * 24 * 60)
WINDOWS = {
    "training": (BEGIN, TEST_START, TEST_START, True),
    "validation": (VALIDATION, TEST_START, TEST_START, True),
    "backtest": (TEST_START, TEST_STOP, MARK_STOP, False),
}


class ResearchMarket(Market):
    """Optional fixed-age exit at the first observed open at or after the deadline."""
    max_hold = None

    def execute(self, asset, sign, decided, through, mode, paid, size, target, stop, probability, close_book):
        delay, slip = dict(MODES)[mode]
        entry = minute(decided) + 1 + delay
        deadline = through if self.max_hold is None else min(entry + self.max_hold, through)
        if deadline < through:
            opens = self.raw[asset, deadline:through, 0]
            observed = np.flatnonzero(np.isfinite(opens) & (opens > 0))
            if observed.size:
                end = deadline + int(observed[0])
                trade = super().execute(asset, sign, decided, end, mode, paid, size, target, stop,
                                        probability, False)
                if trade["end"] is not None:
                    return trade
                sold = float(self.raw[asset, end, 0] * (1 - sign * slip))
                funding, missing = self.flows(trade, end)
                fees = FEE * (size + trade["qty"] * sold)
                return dict(trade, end=end, sold=sold, reason=4, price_observed_minute=end,
                            funding=funding, missing_funding=missing, fees=fees,
                            net=sign * trade["qty"] * (sold - paid) - fees + funding)
        return super().execute(asset, sign, decided, through, mode, paid, size, target, stop,
                               probability, close_book)


@torch.inference_mode()
def encode(inputs, span, state, device):
    model = wide_encoder(state, device)
    observed, neutral, snapshot = [], [], []
    for start in range(span.start, span.stop, HISTORY_BATCH):
        ids = np.arange(start, min(start + HISTORY_BATCH, span.stop))
        x, bars = inputs.batch(ids, state["scale"], True, False)
        snapshot.append(x[:, :len(BASE_COLUMNS)].numpy())
        x, bars = x.to(device), bars.to(device)
        observed.append(model(x, bars).cpu().numpy())
        neutral.append(model(x, torch.zeros_like(bars)).cpu().numpy())
    return np.concatenate(snapshot), np.concatenate(observed), np.concatenate(neutral)


def quantiles(values):
    if not len(values):
        return None
    return dict(zip(("p50", "p90", "p99", "max"), np.percentile(values, (50, 90, 99, 100)).tolist(), strict=True))


def representation(hidden, preference, neutral, levels, neutral_levels, direct, history, intercept, selected):
    if not len(selected):
        return {"rows": 0}
    h = hidden[selected].astype("f8")
    eigen = np.maximum(np.linalg.eigvalsh(np.cov(h, rowvar=False)), 0.) if len(h) > 1 else np.zeros(h.shape[1])
    spectrum = eigen[eigen > 0] / eigen.sum() if eigen.sum() else np.empty(0)
    choice = lambda scores: np.where((scores > 0).any(axis=1), scores.argmax(axis=1), -1)
    p, n = preference[selected], neutral[selected]
    return dict(rows=len(selected), saturation_abs_ge_0995=float(np.mean(np.abs(h) >= .995)),
                saturation_abs_ge_0999=float(np.mean(np.abs(h) >= .999)),
                hidden_sd=h.std(axis=0).tolist(), total_centered_variance=float(eigen.sum()),
                effective_rank=float(np.exp(-np.sum(spectrum * np.log(spectrum)))) if spectrum.size else 0.,
                entropy_rank_spectrum=spectrum[::-1].tolist(),
                preference_sign_changes_by_side=np.sum((p > 0) != (n > 0), axis=0).tolist(),
                changed_preferred_side=int(np.count_nonzero(choice(p) != choice(n))),
                sides=[dict(side=side, absolute_preference_change=quantiles(np.abs(p[:, i] - n[:, i])),
                            abs_snapshot_contribution=quantiles(np.abs(direct[selected, i])),
                            abs_hidden_contribution=quantiles(np.abs(history[selected, i])),
                            intercept=float(intercept[i]),
                            target_change_bps=quantiles(10000 * np.abs(np.expm1(sign * levels[selected, i, 0])
                                                                     - np.expm1(sign * neutral_levels[selected, i, 0]))),
                            stop_change_bps=quantiles(10000 * np.abs(np.expm1(-sign * levels[selected, i, 1])
                                                                   - np.expm1(-sign * neutral_levels[selected, i, 1]))))
                       for i, (side, sign) in enumerate(zip(("long", "short"), SIGNS, strict=True))])


def trace_by_month(schedule, levels, preference, admission):
    months = schedule.at.astype("datetime64[ms]").astype("datetime64[M]").astype(str)
    positive = preference > 0
    size = initial_size(schedule.turnover[:, None], levels[:, :, 1], np.array(SIGNS))
    ranked_side = admission["initial_rank"]
    stage = dict(positive=positive, standalone_sized=positive & (size >= MIN_NOTIONAL), **admission)
    stage["initial_size_reject"] = admission["passes_daily_gate"] & ~admission["initial_feasible"]
    stage["initial_other_side_ranked"] = admission["initial_feasible"] & ~ranked_side
    stage["daily_gate_reject"] = admission["before_cutoff"] & ~admission["passes_daily_gate"]
    out = {}
    for month in np.unique(months):
        subset = months == month
        out[month] = {side: dict(eligible=int(subset.sum()), **{k: int(a[subset, i].sum()) for k, a in stage.items()})
                      for i, side in enumerate(("long", "short"))}
    return out


def compact(market, books, ledgers, mark):
    out = {}
    for mode, b in books.items():
        ledger = ledgers[mode]
        closed = [t for t in ledger if t["end"] is not None]
        cutoffs = [t for t in closed if t["reason"] == CUTOFF]
        natural = [t for t in closed if t["reason"] != CUTOFF]
        paths_missing = 0
        for trade in ledger:
            through = trade["end"] if trade["end"] is not None else minute(mark) + 1
            candles = market.raw[trade["asset"], trade["entry"]:through, :4]
            paths_missing += int(not (np.isfinite(candles) & (candles > 0)).all())
        outcomes = lambda records: dict(closed=len(records), wins=sum(t["net"] > 0 for t in records),
                                        realized_net=sum(t["net"] for t in records))
        out[mode] = dict(net=b["net"], max_drawdown=b["max_drawdown"], fills=len(ledger),
                         long_fills=sum(t["sign"] == 1 for t in ledger),
                         closed=outcomes(closed), natural=outcomes(natural), cutoff=outcomes(cutoffs),
                         open=len(ledger) - len(closed), time_closes=sum(t["reason"] == 4 for t in closed),
                         missing_funding_hours=sum(t["missing_funding"] for t in ledger),
                         trades_with_missing_path_minutes=paths_missing,
                         oldest_cutoff_quote_minutes=max((t["end"] - t["price_observed_minute"] for t in cutoffs), default=0),
                         median_holding_minutes=float(np.median([t["end"] - t["entry"] for t in closed])) if closed else None)
    return out


def replay_pair(market, schedule, vol, window, levels, scores, *, close_book, trace=False, scale_by_size=True):
    begin, _, mark, _ = window
    books, ledgers, traces = {}, {}, {}
    for mode, _ in MODES:
        flags = {} if trace else None
        books[mode], ledgers[mode], _ = replay(market, schedule, levels, scores, vol, mode, begin, mark,
                                               close_book=close_book, record_plan=False, admission=flags,
                                               scale_by_size=scale_by_size)
        if trace:
            traces[mode] = trace_by_month(schedule, levels, scores.min(axis=-1), flags)
            assert flags["fill"].sum() == len(ledgers[mode])
    return books, ledgers, traces


def saved_replay(name, books, ledgers, device):
    results = load(CHECKPOINT / "results.json")
    path = CHECKPOINT / f"{name}-trades.jsonl.gz"
    assert file_hash(path) == results[name]["ledger"]
    with gzip.open(path, "rt") as stream:
        saved = [json.loads(line) for line in stream]
    output = {}
    for mode, _ in MODES:
        original = [t for t in saved if t["mode"] == mode]
        observed = ledgers[mode]
        identity = lambda t: (t["decision"], t["asset"], t["sign"], t["entry"], t["end"], t["reason"],
                              t["paid"], t["missing_funding"], None if t["net"] is None else np.sign(t["net"]))
        assert list(map(identity, original)) == list(map(identity, observed)), (name, mode, len(original), len(observed))
        # Measured across the six books against the saved CUDA replay. On CPU the
        # maximum relative bracket drift was 3.5e-6 and sizing drift was 1.2e-4.
        cpu = device.type == "cpu"
        for key in ("size", "target", "stop", "funding", "fees"):
            rtol = 1e-6
            if cpu:
                rtol = 5e-6 if key in ("target", "stop") else 1.5e-4
            np.testing.assert_allclose([t[key] for t in observed], [t[key] for t in original], rtol=rtol, atol=1e-8)
        np.testing.assert_allclose([t["net"] for t in observed if t["end"] is not None],
                                   [t["net"] for t in original if t["end"] is not None],
                                   rtol=0, atol=.00025 if cpu else 1e-6)
        expected = results[name]["modes"][mode]
        check = {key: abs(books[mode][key] - expected[key]) for key in ("net", "max_drawdown")}
        assert max(check.values()) < (.001 if cpu else 1e-6), (name, mode, check)
        output[mode] = dict(matched_fills=len(original), **{f"{key}_absolute_error": value for key, value in check.items()})
    return output


def fixed_levels(schedule):
    pairs = load(FIXED_SPEC)["selected"]["pairs"]
    levels = []
    for sign in SIGNS:
        target, stop = np.array(pairs[str(sign)]) / 10000
        levels.append([sign * np.log1p(sign * target), -sign * np.log1p(-sign * stop)])
    return np.broadcast_to(levels, (len(schedule.at), 2, 2))


def row_lookup(schedule):
    return {(int(row["at"]), int(row["asset"])): i for i, row in enumerate(schedule.rows)}


def fixed_entry_attribution(market, book, window, levels, lookup):
    _, _, mark, _ = window
    through = minute(mark)
    repriced = {}
    for mode, ledger in book.items():
        swapped = []
        for t in ledger:
            row = lookup[t["decision"], t["asset"]]
            target, stop = price_levels(t["paid"], t["sign"], levels[row, int(t["sign"] < 0)])
            swapped.append(market.execute(t["asset"], t["sign"], t["decision"], through, mode, t["paid"],
                                          t["size"], target, stop, None, True))
        net = lambda trades: sum(t["net"] for t in trades)
        repriced[mode] = dict(entries=len(swapped), fixed_exit_net=net(swapped), original_exit_net=net(ledger),
                              fixed_exit_wins=sum(t["net"] > 0 for t in swapped),
                              original_exit_wins=sum(t["net"] > 0 for t in ledger),
                              fixed_exit_carry_missing_hours=sum(t["missing_funding"] for t in swapped))
    return repriced


def match_decisions(left, right):
    key = lambda t: (t["decision"], t["asset"], t["sign"])
    return {mode: dict(common=len({key(t) for t in left[mode]} & {key(t) for t in right[mode]}),
                       original=len(left[mode]), changed=len(right[mode])) for mode, _ in MODES}


def january_april_risk(market, schedule, preferences, ledgers):
    start = ms("2026-01-01T00:00:00Z")
    stop = ms("2026-05-01T00:00:00Z")
    stamps = np.unique(schedule.at[(schedule.at >= start) & (schedule.at < stop)
                                   & (preferences > 0).any(axis=1)])
    ceiling = LIMITS["maxOpenRiskUsd"]
    out = {}
    for mode, ledger in ledgers.items():
        positions = [t for t in ledger if t["decision"] < stop and t["end"] > minute(start)]
        total, mega, mega_mark, occupied = [], [], [], []
        for stamp in stamps:
            active = [t for t in positions if t["decision"] < stamp and t["end"] > minute(stamp)]
            occupied.append(len(active))
            risk = [market.open_value(t, stamp)[2] for t in active]
            total.append(sum(risk))
            mega.append(sum(r for r, t in zip(risk, active, strict=True) if t["symbol"] == "MEGA"))
            mega_mark.extend(float(market.mark_at(t["asset"], stamp)) for t in active if t["symbol"] == "MEGA")
        total, mega = np.array(total), np.array(mega)
        mega_positions = [t for t in positions if t["symbol"] == "MEGA"]
        out[mode] = dict(positive_timestamps=len(stamps), total_open_risk_usd=quantiles(total),
                         mega_open_risk_usd=quantiles(mega), mega_mark=quantiles(mega_mark),
                         most_occupied_slots=max(occupied, default=0),
                         at_or_over_limit=int((total >= ceiling).sum()),
                         mega_alone_at_or_over_limit=int((mega >= ceiling).sum()),
                         other_positions_at_or_over_limit=int(((total - mega) >= ceiling).sum()),
                         mega_trades=[{key: t[key] for key in ("sign", "paid", "stop", "qty", "planned_risk", "net")}
                                      for t in mega_positions])
    return out


def run_window(name, state, inputs, market, device):
    window = WINDOWS[name]
    begin, end, mark, archived_close = window
    span = inputs.data.span(begin, end)
    schedule = Schedule(inputs.data.decisions[span])
    vol = volatility(inputs.data, span)
    print(f"{name}: encoding {len(vol):,} decisions", flush=True)
    snap, hidden, neutral_hidden = encode(inputs, span, state, device)
    raw = normalized(np.column_stack((snap, hidden)), state["norm"])
    neutral = normalized(np.column_stack((snap, neutral_hidden)), state["norm"])
    weights = state["weights"]
    preference, neutral_preference = raw @ weights[:, :2], neutral @ weights[:, :2]
    levels, neutral_levels = exit_distances(raw, vol, weights), exit_distances(neutral, vol, weights)
    direct = raw[:, :len(BASE_COLUMNS)] @ weights[:len(BASE_COLUMNS), :2]
    hidden_contrib = raw[:, len(BASE_COLUMNS):-1] @ weights[len(BASE_COLUMNS):-1, :2]
    np.testing.assert_allclose(preference, direct + hidden_contrib + weights[-1, :2], rtol=0, atol=2e-5)
    original_scores, neutral_scores = preference[:, :, None], neutral_preference[:, :, None]
    del snap, raw, neutral, neutral_hidden

    original, ledgers, admission = replay_pair(market, schedule, vol, window, levels, original_scores,
                                               close_book=archived_close, trace=True)
    match = saved_replay(name, original, ledgers, device)
    print(f"{name}: reproduced archive", flush=True)
    lookup = row_lookup(schedule)
    admitted = np.array(sorted({lookup[t["decision"], t["asset"]] for ledger in ledgers.values() for t in ledger}))
    representation_args = (hidden, preference, neutral_preference, levels, neutral_levels, direct, hidden_contrib,
                           weights[-1, :2])
    representation_stats = dict(all=representation(*representation_args, np.arange(len(vol))),
                                admitted=representation(*representation_args, admitted))
    neutral_book, neutral_ledger, _ = replay_pair(market, schedule, vol, window, neutral_levels, neutral_scores,
                                                  close_book=archived_close)
    out = dict(window=[iso(t) for t in window[:3]], rows=len(vol), archived_close=archived_close,
               archive_reproduction=match, admission=admission, representation=representation_stats,
               archived=compact(market, original, ledgers, mark), neutral=compact(market, neutral_book, neutral_ledger, mark),
               history_admission_overlap=match_decisions(ledgers, neutral_ledger))

    if name == "training":
        out["january_april_risk"] = january_april_risk(market, schedule, preference, ledgers)
        return out

    fixed = fixed_levels(schedule)
    constant = np.ones((len(vol), 2, 1), dtype="f4")
    random = np.random.default_rng(RANDOM_SEED).uniform(.5, 1.5, size=constant.shape).astype("f4")
    arms = {"cash": (fixed, np.zeros_like(constant)), "constant_fixed": (fixed, constant),
            "constant_learned": (levels, constant), "random_fixed": (fixed, random),
            "random_size_weighted_fixed": (fixed, random),
            "wide_fixed": (fixed, original_scores), "wide_learned": (levels, original_scores)}
    if name == "backtest":
        standalone = initial_size(schedule.turnover[:, None], levels[:, :, 1], np.array(SIGNS))
        out["positive_short_candidates"] = [dict(symbol=str(schedule.names[i]), at=iso(int(schedule.at[i])),
                                                 preference=float(preference[i, 1]),
                                                 standalone_size=float(standalone[i, 1]),
                                                 stop_pct=float(100*np.expm1(levels[i, 1, 1])))
                                            for i in np.flatnonzero(preference[:, 1] > 0)]
        ordered_spec = load(PRIOR / "ordered-fit.json")["models"]["ordered-neural"]
        value, exits, scale = load_model("ordered-neural", ordered_spec["model"])
        ordered_levels, ordered_scores = predict(inputs, span, value, exits, scale, False)
        _, fixed_scores = predict(inputs, span, value, exits, scale, False, fixed_distances=fixed)
        short_only = constant.copy()
        short_only[:, 0] = 0
        learned_gate = ordered_scores.min(axis=-1, keepdims=True) > 0
        fixed_gate = fixed_scores.min(axis=-1, keepdims=True) > 0
        out["ordered_positive_by_side"] = dict(learned=learned_gate.sum(axis=(0, 2)).tolist(),
                                               fixed=fixed_gate.sum(axis=(0, 2)).tolist())
        arms.update(ordered_fixed=(fixed, fixed_scores), ordered_tied_fixed=(fixed, fixed_gate.astype("f4")),
                    ordered_learned=(ordered_levels, ordered_scores), constant_short_fixed=(fixed, short_only),
                    ordered_exit_swap=(fixed, ordered_scores), ordered_tied_exit_swap=(fixed, learned_gate.astype("f4")))

    out["controls"] = {}
    for arm, (distance, scores) in arms.items():
        print(f"{name}: {arm}", flush=True)
        if arm == "wide_learned":
            other, other_ledgers, _ = replay_pair(market, schedule, vol, window, levels, original_scores,
                                                   close_book=not archived_close)
            liquidation, liquidated = (original, ledgers) if archived_close else (other, other_ledgers)
            marked, natural = (other, other_ledgers) if archived_close else (original, ledgers)
        else:
            scale_by_size = arm != "random_fixed"
            marked, natural, _ = replay_pair(market, schedule, vol, window, distance, scores,
                                             close_book=False, scale_by_size=scale_by_size)
            liquidation, liquidated, _ = replay_pair(market, schedule, vol, window, distance, scores,
                                                      close_book=True, scale_by_size=scale_by_size)
        overlap = match_decisions(natural, liquidated)
        assert all(x["common"] == x["original"] == x["changed"] for x in overlap.values())
        stats = dict(marked=compact(market, marked, natural, mark),
                     liquidated=compact(market, liquidation, liquidated, mark))
        if arm in {"wide_learned", "ordered_learned"}:
            stats["fixed_entry_attribution"] = fixed_entry_attribution(market, liquidated, window, fixed, lookup)
        out["controls"][arm] = stats

    out["holding_horizons"] = {}
    for horizon in HORIZONS:
        print(f"{name}: {horizon // 60}h holding horizon", flush=True)
        market.max_hold = horizon
        book, limited, _ = replay_pair(market, schedule, vol, window, levels, original_scores, close_book=True)
        out["holding_horizons"][str(horizon // 60)] = compact(market, book, limited, mark)
    market.max_hold = None
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("windows", nargs="*", choices=WINDOWS, metavar="WINDOW")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--output-dir", type=Path, help="Defaults to the report directory on CUDA or its cpu/ subdirectory")
    args = parser.parse_args()
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.deterministic = True
    torch.backends.cuda.matmul.allow_tf32 = False
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        parser.error("CUDA is unavailable. Select the installed CUDA runtime or use --device cpu.")
    frozen = CHECKPOINT / "frozen.pt"
    digest = file_hash(frozen)
    assert load(CHECKPOINT / "results.json")["frozen"] == digest
    state = torch.load(frozen, map_location="cpu", weights_only=False)
    inputs, market = Inputs(Dataset()), ResearchMarket()
    cache = {
        STORE / "decisions.npy": inputs.data.manifest["hashes"]["decisions"],
        STORE / "market.npy": inputs.data.manifest["hashes"]["market"],
        HISTORY: load(MANIFEST)["history"],
        GRID: load(ORIGINAL_REPORT / "candles.json")["grid_sha256"],
        FUNDING: load(ORIGINAL_REPORT / "funding.json")["funding_sha256"],
    }
    for path, expected in cache.items():
        assert file_hash(path) == expected, path
    output_dir = args.output_dir or (HERE / "cpu" if device.type == "cpu" else HERE)
    output_dir.mkdir(parents=True, exist_ok=True)
    save_json(output_dir / "inputs.json", dict(cache_sha256={str(path.relative_to(HERE.parents[4])): digest
                                                       for path, digest in cache.items()},
                                         frozen_sha256=digest))
    for name in args.windows or WINDOWS:
        candidate = state
        model_file, model_hash = frozen.name, digest
        if name == "validation":
            development, manifest = read_fit(CHECKPOINT, "development")
            candidate = {**development, **development["checkpoints"][state["step"]]}
            model_file, model_hash = "development.pt", manifest["model"]
        result = run_window(name, candidate, inputs, market, device)
        result["checkpoint"] = dict(file=model_file, sha256=model_hash, step=state["step"])
        if name == "backtest":
            result["ordered_checkpoint_sha256"] = load(PRIOR / "ordered-fit.json")["models"]["ordered-neural"]["model"]
        result["fixed_bracket_source_sha256"] = file_hash(FIXED_SPEC)
        result["random_seed"] = RANDOM_SEED
        result["device"] = str(device)
        save_json(output_dir / f"{name}.json", result)


if __name__ == "__main__":
    main()
