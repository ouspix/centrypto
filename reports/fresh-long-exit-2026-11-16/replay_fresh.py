"""Compare a frozen four-model sweep checkpoint to its long-exit-only swap."""

import itertools
import math
import sys
import urllib.parse
import warnings
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
REPORTS = HERE.parent
for directory in (
    "mixed-feature-replay-2026-11-16",
    "sma-four-models-no-news-2026-11-14",
    "two-stage-policy-2026-11-14",
):
    sys.path.insert(0, str(REPORTS / directory))
import replay as sweep
from build import CANDIDATE_DTYPE, SETUP_DTYPE
from build_features import sma_features
from common import BAR, H, MIN, gz, iso, lag, minute_array, safe, sma
from data_four import CONTEXT_NAMES, FourData
from dataset import Data
from detectors import crossings
from features_two import WINDOWS, derivatives, market
import numpy as np

PLAN = sweep.read_json(HERE / "plan.json")
WINDOWS_UTC = PLAN["entry_windows"]
START = sweep.ms(WINDOWS_UTC[0]["start"])
ENTRY_END = sweep.ms(WINDOWS_UTC[-1]["end"])
MARKET_END = sweep.ms(PLAN["market_end"])
TAIL_MINUTES = 1472
BASELINE = PLAN["baseline"]
SWAP = "position_history_long_exit_only"
CACHE = sweep.CACHE.parent / HERE.name
ARCHIVE_START = "2026-10-29T00:00:00Z"
PERIOD = {"id": "recent", "start": ARCHIVE_START, "end": WINDOWS_UTC[0]["start"]}
MIN_VOLUME = 10000  # Original sweep's minimum prior-minute quote volume, in USD.


class ReplayStates:
    exit_rows = Data.exit_rows


class FreshData(FourData):
    def __init__(self):
        reference = FourData().d
        self.entry_base_names = reference.market_names + reference.sma_names
        self.entry_names = self.entry_base_names + CONTEXT_NAMES
        self.exit_names = reference.exit_names[:-1]
        catalog = [row for row in reference.catalog if row["period"] == PERIOD["id"]]
        start = sweep.ms(PERIOD["start"])
        self.bars = (MARKET_END - start) // BAR
        self.archive_bars = (START - start) // BAR
        self.d = ReplayStates()
        self.d.catalog = []
        self.d.market = np.empty((len(catalog) * self.bars, len(reference.market_names)), dtype="f4")
        self.d.sma = np.empty((len(catalog) * self.bars, len(reference.sma_names)), dtype="f4")
        self.d.state = np.zeros(len(catalog) * self.bars, reference.state.dtype)
        self.opens = {}
        self.hashes = {}
        self.coverage = Counter()
        self.spot_status = Counter()
        self.parity = Counter()

        all_bars = {}
        for row in catalog:
            symbol = row["symbol"]
            raw = self.read_source("market", symbol)
            minute = self.minutes(symbol, raw["rows"])
            self.opens[symbol] = minute[:, 0]
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                blocks = minute.reshape(-1, 5, 5)
                bars = np.column_stack([
                    blocks[:, 0, 0], np.nanmax(blocks[:, :, 1], axis=1), np.nanmin(blocks[:, :, 2], axis=1),
                    blocks[:, -1, 3], np.nansum(blocks[:, :, 4], axis=1),
                ])
            bars[np.isfinite(blocks).all(axis=2).sum(axis=1) < 4] = np.nan
            close = blocks[:, -1, 3]
            all_bars[symbol] = bars, close, close * blocks[:, -1, 4], raw["ticks"]

        benchmark = {}
        for symbol in ("BTC", "ETH"):
            benchmark.update({
                name: values for name, values in market(all_bars[symbol][0], symbol.lower() + "_").items()
                if "_return_pct_" in name or "_rv_pct_" in name
            })
        for sid, row in enumerate(catalog):
            bars, close, quote_volume, new_ticks = all_bars[row["symbol"]]
            self.build_series(reference, row, sid, bars, close, quote_volume, new_ticks, benchmark)
        self.build_candidates()

    def read_source(self, kind, symbol):
        filename = CACHE / kind / (urllib.parse.quote(symbol, safe="") + ".json.gz")
        self.hashes[str(filename.relative_to(CACHE))] = sweep.sha256(filename)
        return gz(filename)

    def minutes(self, symbol, rows):
        warmup, _ = minute_array(PERIOD, symbol)
        fresh = np.full(((MARKET_END - START) // MIN, 5), np.nan)
        values = np.array(rows, dtype=float).reshape((-1, 6))
        assert len(np.unique(values[:, 0])) == len(values)
        idx = ((values[:, 0] - START) // MIN).astype(int)
        assert ((values[:, 0] % MIN == 0) & (idx >= 0) & (idx < len(fresh))).all()
        valid = (
            np.isfinite(values).all(axis=1) & (values[:, 1:5] > 0).all(axis=1) & (values[:, 5] >= 0)
            & (values[:, 2] >= values[:, 1:5].max(axis=1)) & (values[:, 3] <= values[:, 1:5].min(axis=1))
        )
        fresh[idx[valid]] = values[valid, 1:]
        self.coverage["tail_possible_minute_marks"] += len(fresh)
        self.coverage["tail_valid_minute_marks"] += int(valid.sum())
        return np.concatenate((warmup, fresh))

    def build_series(self, reference, row, sid, bars, close, quote_volume, new_ticks, benchmark):
        symbol, key = row["symbol"], row["key"]
        offset = sid * self.bars
        series = slice(offset, offset + self.bars)
        self.d.catalog.append({**row, "id": sid, "offset": offset, "bars": self.bars, "end": PLAN["market_end"]})
        start = sweep.ms(row["start"])
        assert row["start"] == ARCHIVE_START and row["bars"] == self.archive_bars
        state = self.d.state[series]
        cut = start + (np.arange(self.bars) + 1) * BAR + 5000
        state["series"] = sid
        state["time"] = cut
        state["close"] = close
        state["price"] = np.r_[self.opens[symbol][6::5], np.nan]
        state["eligible"] = (
            (quote_volume >= MIN_VOLUME) & np.isfinite(close) & (np.arange(self.bars) >= H)
        )
        state["terminal_price"] = np.r_[state["price"][H:], np.full(H, np.nan)]
        state["terminal_time"] = np.where(np.isfinite(state["terminal_price"]), cut + 55000 + H * BAR, -1)
        old = slice(row["offset"], row["offset"] + row["bars"])
        for field in ("time", "close", "eligible", "price", "terminal_price", "terminal_time"):
            # The final archived price and earlier deadlines can become observable as the archive extends.
            end = self.archive_bars - (H + 1 if field.startswith("terminal") else 1)
            assert np.array_equal(state[field][:end], reference.state[old][field][:end], equal_nan=True), (symbol, field)

        features = market(bars, "perp_")
        features.update(benchmark)
        features["rolling24h_close_return_pct"] = 100 * (safe(close, lag(close, H)) - 1)
        hour = (cut / 3600000) % 24
        features["calendar_hour_sin"] = np.sin(2 * np.pi * hour / 24)
        features["calendar_hour_cos"] = np.cos(2 * np.pi * hour / 24)
        means = {n: sma(close, n) for pair in sweep.CFG["pairs"] for n in pair}
        for n, mean in means.items():
            features[f"sma_price_distance_{n}"] = 100 * (safe(close, mean) - 1)
            features[f"sma_slope_1h_{n}"] = 100 * (safe(mean, lag(mean, 12)) - 1)
        for fast, slow in sweep.CFG["pairs"]:
            features[f"sma_gap_{fast}_{slow}"] = 100 * (safe(means[fast], means[slow]) - 1)
        for width in WINDOWS:
            suffix = f"_return_pct_{width * 5}m"
            features[f"relative_btc_return_{width * 5}m"] = features["perp" + suffix] - features["btc" + suffix]

        archive_tick_file = sweep.BASE_CACHE / "ticks" / (key + ".json.gz")
        archive_ticks = gz(archive_tick_file) if archive_tick_file.exists() else []
        ticks = archive_ticks + [{**tick, "step": tick["step"] + self.archive_bars} for tick in new_ticks]
        derivative_features, _, _ = derivatives(ticks, self.d.catalog[sid])
        features.update(derivative_features)
        spot_prices = np.full(self.bars, np.nan)
        archive_spot_file = sweep.BASE_CACHE / "spot" / (key + ".json.gz")
        new_spot = self.read_source("spot", symbol)
        self.spot_status[new_spot["status"]] += 1
        inputs = [gz(archive_spot_file), new_spot] if archive_spot_file.exists() else [new_spot]
        for payload in inputs:
            for candle in payload["rows"]:
                i = (int(candle[0]) - start) // BAR
                assert 0 <= i < self.bars and int(candle[6]) < cut[i] and np.isnan(spot_prices[i])
                spot_prices[i] = float(candle[4]) * payload["multiplier"]
        features["crossvenue_basis_bps"] = 10000 * (safe(close, spot_prices) - 1)

        # Archived preprocessing masks the spot group in both variants. Cross-venue basis belongs to derivatives.
        expected = set(reference.market_names)
        assert set(features) == {name for name in expected if not name.startswith("spot_")}
        matrix = np.column_stack([features.get(n, np.full(self.bars, np.nan)) for n in reference.market_names]).astype("f4")
        joined_sma = sma_features(close)
        smas = np.column_stack([joined_sma[name] for name in reference.sma_names]).astype("f4")
        active = [i for i, name in enumerate(reference.market_names) if not name.startswith("spot_")]
        # Check the reconstructed inputs on the overlapping history against the frozen feature matrices.
        assert np.allclose(matrix[: self.archive_bars, active], reference.market[old][:, active],
                           atol=1e-6, rtol=1e-6, equal_nan=True), symbol
        assert np.array_equal(smas[: self.archive_bars], reference.sma[old], equal_nan=True), symbol
        assert not np.isinf(matrix).any() and not np.isinf(smas).any()
        self.parity["archived_feature_rows"] += self.archive_bars
        self.d.market[series], self.d.sma[series] = matrix, smas
        eligible = (cut >= START) & (cut < ENTRY_END) & state["eligible"] & np.isfinite(state["price"])
        self.coverage["eligible_entry_states"] += int(eligible.sum())
        self.coverage["crossvenue_basis_at_eligible_states"] += int((eligible & np.isfinite(features["crossvenue_basis_bps"])).sum())
        self.coverage["derivatives_at_eligible_states"] += int((eligible & np.isfinite(features["derivative_log_oi_usd"])).sum())

    def build_candidates(self):
        setups, candidates = [], []
        for row in self.d.catalog:
            offset = row["offset"]
            state = self.d.state[offset : offset + self.bars]
            signals = crossings(state["close"], sweep.CFG["pairs"])
            eligible = state["eligible"] & np.isfinite(state["price"])
            for pair_id, pair in enumerate(sweep.CFG["pairs"]):
                for side, name, other in ((1, "long", "short"), (-1, "short", "long")):
                    cross = np.flatnonzero(signals[tuple(pair)][name] & (state["time"] >= START) & (state["time"] < ENTRY_END))
                    opposite = np.flatnonzero(signals[tuple(pair)][other])
                    for first in cross:
                        next_opposite = np.searchsorted(opposite, first, side="right")
                        last = min(first + sweep.CFG["entry_window_bars"], self.bars - 1)
                        if next_opposite < len(opposite):
                            last = min(last, opposite[next_opposite] - 1)
                        local = np.arange(first, last + 1)
                        local = local[eligible[local] & (state["time"][local] < ENTRY_END)]
                        if len(local):
                            setup = len(setups)
                            setups.append((setup, row["id"], offset + first, offset + last, side, pair_id,
                                           state["time"][first], -1, False, np.nan))
                            candidates.extend((setup, offset + at, pair_id, side, at - first, np.nan, np.nan) for at in local)
        self.setups = np.array(setups, dtype=SETUP_DTYPE)
        self.c = np.array(candidates, dtype=CANDIDATE_DTYPE)
        self.setup_time = self.setups["time"][self.c["setup"]]

    def verify_trade(self, trade):
        entry, exit = (sweep.ms(trade[name + "_time"]) for name in ("entry", "exit"))
        start = sweep.ms(ARCHIVE_START)
        assert ENTRY_END > entry >= START and exit <= MARKET_END and 0 < exit - entry <= H * BAR
        assert (entry - start) % MIN == (exit - start) % MIN == 0
        opens = self.opens[trade["symbol"]]
        entry_price, exit_price = opens[(entry - start) // MIN], opens[(exit - start) // MIN]
        assert np.isfinite(entry_price)
        if not trade["scored"]:
            assert not np.isfinite(exit_price) and trade["return_pct"] is None and exit - entry == H * BAR
            return
        expected = trade["side_sign"] * 100 * (exit_price / entry_price - 1)
        assert math.isclose(trade["return_pct"], expected, abs_tol=1e-9, rel_tol=0), trade


def prepare_side(data, side, models, policy):
    if policy["cash"]:
        return {}
    return sweep.prepare(
        data,
        {**dict.fromkeys(sweep.SIDES, {"untrained": True}), side: models},
        START, ENTRY_END + TAIL_MINUTES * MIN,
        {side: [policy["exit_threshold"]]},
    )


def replay_pair(data, seed, checkpoint):
    archive = sweep.archived_run(BASELINE, seed, checkpoint)
    policies = archive["policies"]
    baseline_models, baseline_weights = sweep.load_models(sweep.MODEL_SOURCES[BASELINE], seed, checkpoint)
    replacements = {**sweep.MODEL_SOURCES[BASELINE], "long_exit": PLAN["replacement_long_exit"]}
    swap_models, swap_weights = sweep.load_models(replacements, seed, checkpoint)
    assert [role for role in baseline_weights if baseline_weights[role] != swap_weights[role]] == ["long_exit"]
    for models in (baseline_models, swap_models):
        for side in sweep.SIDES:
            for stage in sweep.STAGES:
                model = models[side][stage]
                assert model["input_names"] == getattr(data, stage + "_names")
                assert all(not name.startswith("spot_") for name in model["active_names"])
    short = prepare_side(data, "short", baseline_models["short"], policies["short"])
    pair = {
        "seed": seed, "checkpoint": checkpoint, "policies": policies,
        "baseline_policy_source_sha256": sweep.sha256(
            sweep.CACHE / "runs" / f"{BASELINE}__{seed}__{checkpoint[:10]}.json"
        ),
        "variants": {},
    }
    baseline_entry = None
    for variant, models, weights in (
        (BASELINE, baseline_models, baseline_weights),
        (SWAP, swap_models, swap_weights),
    ):
        long = prepare_side(data, "long", models["long"], policies["long"])
        if long:
            entries = long["long"]
            if baseline_entry is None:
                baseline_entry = entries["ids"], entries["score"]
                cut = policies["long"]["entry_threshold"]
                pair["long_candidates_past_entry_threshold"] = int((entries["score"] >= cut).sum())
            else:
                assert np.array_equal(baseline_entry[0], entries["ids"])
                assert np.array_equal(baseline_entry[1], entries["score"])
        trades, meta = sweep.replay(data, {**short, **long}, policies, WINDOWS_UTC[0]["start"], BASELINE)
        for trade in trades:
            data.verify_trade(trade)
        pair["variants"][variant] = {"weights": weights, "trades": trades, **meta}
    if policies["long"]["cash"]:
        assert pair["variants"][BASELINE]["trades"] == pair["variants"][SWAP]["trades"]
        assert all(t["side"] == "short" for t in pair["variants"][BASELINE]["trades"])
    return pair


def key(trade):
    return tuple(trade[field] for field in ("side", "symbol", "entry_time", "exit_time"))


def compare(baseline, swap):
    left, right = sweep.totals(baseline), sweep.totals(swap)
    missing_left = Counter(key(t) for t in baseline if not t["scored"])
    missing_right = Counter(key(t) for t in swap if not t["scored"])
    # Identical unpriced trades have the same entry and missing exit, so they cancel in the paired delta.
    delta = right["priced_subtotal_usd"] - left["priced_subtotal_usd"] if missing_left == missing_right else None
    return {BASELINE: left, SWAP: right, "pnl_delta_usd": delta}


def summarize(pair, start, end, exclude=()):
    def filter_trades(variant):
        return [
            trade for trade in pair["variants"][variant]["trades"]
            if start <= trade["entry_time"] < end and trade["symbol"] not in exclude
        ]
    baseline, swap = filter_trades(BASELINE), filter_trades(SWAP)
    return {
        **compare(baseline, swap),
        "by_side": {
            side: compare(
                [t for t in baseline if t["side"] == side],
                [t for t in swap if t["side"] == side],
            ) for side in sweep.SIDES
        },
    }


def main():
    assert sweep.lock() == sweep.read_json(sweep.SWEEP / "experiment-lock.json")["files"]
    archived_folds = sweep.read_json(sweep.SWEEP / "fold-plan.json")
    assert WINDOWS_UTC[0]["start"] == archived_folds[-1]["end"]
    assert PLAN["primary_checkpoint"] == archived_folds[-1]["start"]
    assert MARKET_END >= ENTRY_END + TAIL_MINUTES * MIN
    assert WINDOWS_UTC[0]["end"] == WINDOWS_UTC[1]["start"]
    assert all(sweep.CFG[key] == 0 for key in ("fees", "slippage", "funding_payments"))
    assert sweep.CFG["notional_usd"] == 100
    seeds = sweep.read_json(sweep.SWEEP / "experiment.json")["seeds"]
    checkpoints = [PLAN["primary_checkpoint"], *PLAN["earlier_checkpoints"]]
    data = FreshData()
    print(f"Reconstructed {len(data.d.catalog)} symbols with {len(data.c)} eligible fresh candidates", flush=True)
    runs = []
    with sweep.threadpool_limits(limits=1):
        for checkpoint, seed in itertools.product(checkpoints, seeds):
            pair = replay_pair(data, seed, checkpoint)
            runs.append(pair)
            print(f"Compared checkpoint {checkpoint[:10]}, seed {seed}", flush=True)
    output = CACHE / "runs"
    output.mkdir(exist_ok=True, parents=True)
    checks = sum(len(details["trades"]) for pair in runs for details in pair["variants"].values())
    summaries = []
    for pair in runs:
        name = f"{pair['checkpoint'][:10]}__{pair['seed']}.json"
        sweep.write_json(output / name, pair)
        summary = {
            "checkpoint": pair["checkpoint"], "seed": pair["seed"], "policies": pair["policies"],
            "file": "runs/" + name,
            "all_windows": summarize(pair, WINDOWS_UTC[0]["start"], WINDOWS_UTC[-1]["end"]),
            "by_window": [{**w, **summarize(pair, w["start"], w["end"])} for w in WINDOWS_UTC],
        }
        summaries.append(summary)
    # Preserve a common universe for absolute comparisons if any missing exit prevents a full total.
    excluded = sorted({
        trade["symbol"] for pair in runs for details in pair["variants"].values()
        for trade in details["trades"] if not trade["scored"]
    })
    if excluded:
        for summary, pair in zip(summaries, runs):
            summary["common_complete_symbols"] = summarize(
                pair, WINDOWS_UTC[0]["start"], WINDOWS_UTC[-1]["end"], exclude=set(excluded),
            )
            assert summary["common_complete_symbols"]["pnl_delta_usd"] is not None
    sweep.write_json(CACHE / "results.json", {
        **PLAN, "seeds": seeds, "notional_usd": 100, "fees": 0, "funding": 0, "slippage": 0,
        "instruments": len(data.d.catalog), "candidate_rows": len(data.c),
        "archive_feature_parity": dict(data.parity), "market_coverage": dict(data.coverage),
        "spot_pair_status": dict(data.spot_status), "source_sha256": data.hashes,
        "trade_prices_checked": checks, "symbols_excluded_from_complete_subset": excluded,
        "paired_replays": summaries,
    })
    print(f"Verified timestamps and native price marks on {checks} trade records. Results: {CACHE}", flush=True)


if __name__ == "__main__":
    main()
