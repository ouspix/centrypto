"""Build all decisions for the frozen SMA universe from the original research tapes."""
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
import argparse
import gzip
import json
import sys

import joblib
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PRIOR = HERE.parent / "net-value-entry-2026-11-22"
sys.path.insert(0, str(PRIOR))
sys.path.insert(0, str(HERE.parent / "news-entry-2026-11-22"))
from run_common import (BASE_CACHE, CACHE as OLD_CACHE, CONFIGS, DAY, HOUR, MINUTE, PLAN, PRIOR_CACHE,
                        SIDES, SIGN, file_hash, funding_hours, inputs, load, ms, read_json, recovery_prices,
                        save_json, trade_costs)
from common import minute_array
from indicators import augment, build_bank
from news_inputs import AVAILABILITY, CONTENT, FeatureBank, NewsHistory
from price_network import predict
from repair_data import EXIT_CORE
from repair_network import predict as exit_score
from causal_candidates import CausalData
from forward import ForwardData
from threadpoolctl import threadpool_limits

CACHE = BASE_CACHE.parent / HERE.name
BUNDLE = PRIOR / "net-value-models.joblib"
NEWS = BASE_CACHE.parent / "news-entry-2026-11-22/news-snapshot.json.gz"
BAR = 5 * MINUTE
AGE_TO_ARRIVAL = 55_000
BREADTH = ["advancing_fraction", "median_move_pct", "dispersion_pct", "observed_assets", "asset_minus_median_pct"]


def iso(at):
    return datetime.fromtimestamp(int(at) / 1000, timezone.utc).isoformat()


def dump(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    joblib.dump(payload, tmp, compress=3)
    tmp.replace(path)


def intervals(at, cadence):
    times = np.unique(at)
    if not len(times):
        return dict(count=0, first=None, last=None, internal_gaps=[])
    breaks = np.flatnonzero(np.diff(times) > cadence)
    return dict(count=len(times), first=int(times[0]), last=int(times[-1]),
                internal_gaps=[[int(times[i]+cadence), int(times[i+1])] for i in breaks])


def fixed_exits(data, entries, side, models):
    """Track the original ensemble's pending exit, including truncated series tails."""
    state = data.d.state
    end = np.array([c["offset"] + c["bars"] for c in data.d.catalog])[state["series"][entries]]
    steps = np.zeros(len(entries), dtype=int)
    high = state["price"][entries].copy()
    low = high.copy()
    pending = np.zeros(len(entries), bool)
    core = [data.exit_names.index(n) for n in EXIT_CORE]
    for step in range(1, 289):
        active = np.flatnonzero((steps == 0) & np.isfinite(high) & (entries + step < end))
        if not len(active):
            break
        rows = entries[active] + step
        close = state["close"][rows]
        high[active] = np.fmax(high[active], close)
        low[active] = np.fmin(low[active], close)
        if step < 288:
            raw = data.exit_rows(entries[active], rows, side, high[active], low[active])
            scores = np.mean([exit_score(m, raw) for m in models], axis=0)
            pending[active] |= (scores >= .5) | ~np.isfinite(raw[:, core]).all(axis=1)
            take = pending[active] & np.isfinite(state["price"][rows])
        else:
            take = np.isfinite(state["terminal_price"][entries[active]])
        steps[active[take]] = step
    return steps


def breadth_by_time(data):
    col = data.entry_base_names.index("perp_return_pct_60m")
    series = defaultdict(list)
    for cat in data.d.catalog:
        sl = slice(cat["offset"], cat["offset"] + cat["bars"])
        values = data.d.market[sl, col]
        valid = np.isfinite(values) & data.past_complete[sl, 2]
        for t, v in zip(data.d.state["time"][sl][valid], values[valid]):
            series[int(t)].append(v)
    return {t: (np.mean(np.asarray(v) > 0), np.median(v), np.std(v), len(v)) for t, v in series.items()}


def market_for(data, cat, proxy):
    symbol = cat["symbol"]
    start = ms(cat["start"])
    if hasattr(data, "opens"):
        opens = data.opens[symbol]
    else:
        opens = minute_array(dict(id=cat["period"], start=cat["start"], end=cat["end"]), symbol)[0][:, 0]
    encoded = quote(symbol, safe="")
    snap = PRIOR_CACHE / "snapshots" / (encoded + ".json.gz")
    rates = read_json(snap)["rates"] if snap.exists() else {}
    older = OLD_CACHE / "funding" / (cat["period"] + "-" + encoded + ".json")
    if older.exists():
        rates = load(older)["rates"] | rates
    if hasattr(data, "holdout"):
        rates.update(data.holdout[symbol]["rates"])
    rates = {int(k): float(v) for k, v in rates.items()}
    settlements = {}
    for hour, rate in rates.items():
        j = (hour-start)//MINUTE
        if 0 <= j < len(opens):
            p = opens[j]
            if not np.isfinite(p):
                p = proxy.get(symbol, {}).get(hour, np.nan)
            if p > 0:
                settlements[hour] = (float(p), rate)
    return start, opens, settlements


def build(stage, data, window):
    bundle = joblib.load(BUNDLE)
    assert file_hash(BUNDLE) == load(PRIOR / "experiment-lock.json")["bundle_sha256"]
    choices = bundle["choices"]
    state = data.d.state
    bank = build_bank(data, [CONFIGS[c["config"]] for c in choices])
    breadth = breadth_by_time(data)
    news = FeatureBank(data, NewsHistory(read_json(NEWS), {c["symbol"] for c in data.d.catalog}))
    if hasattr(data, "holdout"):
        # Only news actually present in the frozen news export can be used.
        assert stage == "shadow"
    output, markets, coverage = {}, {}, {}
    proxy = recovery_prices()
    for cat in data.d.catalog:
        key = cat["key"]
        markets[key] = market_for(data, cat, proxy)
        start, opens, settlements = markets[key]
        sl = slice(cat["offset"], cat["offset"] + cat["bars"])
        times = state["time"][sl]
        sources = {}
        for name, col in (("binance_spot", "spot_return_pct_5m"), ("derivatives", "derivative_log_oi_usd"),
                          ("funding_feature", "derivative_funding_bps"), ("book", "liquidity_spread_bps")):
            values = data.d.market[sl, data.entry_base_names.index(col)]
            sources[name] = intervals(times[np.isfinite(values)], BAR)
        sources["minute_price"] = intervals(start + np.flatnonzero(np.isfinite(opens))*MINUTE, MINUTE)
        sources["priceable_funding"] = intervals(list(settlements), HOUR)
        coverage[key] = dict(symbol=cat["symbol"], period=cat["period"], sources=sources, decisions={})
    for side, choice in zip(SIDES, choices):
        ids = np.flatnonzero(data.core_ok & (data.c["pair"] == choice["pair"]) & (data.c["side"] == SIGN[side]))
        if stage != "history":
            # The parity comparison uses the exact original replay population.
            legacy = data.replay_ids(ms(window["test_start"]), ms(window["test_market_end"]), SIGN[side])
            benchmark_ids = set(map(int, legacy))
        else:
            benchmark_ids = set()
        candidates = data.c[ids]
        rows = candidates["row"]
        raw, extra = augment(data.entry_rows(ids), bank, ids, CONFIGS[choice["config"]])
        legacy_names = data.entry_names + extra
        scores = {}
        for arm, sides in bundle["entries"].items():
            assert all(m["input_names"] == legacy_names for m in sides[side])
            scores[arm] = predict({"members": sides[side]}, raw)
        members = bundle["entries"]["net_value"][side]
        scores["mlp_net_bps"] = np.mean([predict(m, raw, False)*m["usd_per_output"]*100 for m in members], axis=0)
        news_values, events = news.inputs(ids, raw)
        context = np.full((len(ids), len(BREADTH)), np.nan)
        for i, row in enumerate(rows):
            b = breadth.get(int(state["time"][row]))
            if b:
                context[i] = (*b, raw[i, data.entry_names.index("perp_return_pct_60m")] - b[1])
        x = np.column_stack((raw, context, news_values)).astype("f4")
        names = legacy_names + BREADTH + AVAILABILITY + CONTENT
        steps = np.concatenate([fixed_exits(data, batch, SIGN[side], bundle["exits"][side])
                                for batch in np.array_split(rows, max(1, (len(rows)+3999)//4000))])
        records = []
        groups = defaultdict(list)
        for i, (cid, c, row, step) in enumerate(zip(ids, candidates, rows, steps)):
            cat = data.d.catalog[state["series"][row]]
            key = cat["key"]
            start, opens, settlements = markets[key]
            decision = int(state["time"][row])
            entry = decision + AGE_TO_ARRIVAL
            exit_at = entry + (int(step)*BAR if step else DAY)
            first = float(state["price"][row])
            last = float(state["price"][row+step]) if step else np.nan
            hours = funding_hours(entry, exit_at)
            costs = {}
            status = "priced"
            if not np.isfinite(first):
                status = "missing_entry"
            elif not step:
                status = "unresolved_exit"
            elif any(h not in settlements for h in hours):
                status = "missing_funding"
            else:
                costs = trade_costs(first, last, SIGN[side], sum(np.prod(settlements[h]) for h in hours))
            episode = data.setups[c["setup"]]
            path = opens[(entry-start)//MINUTE:(exit_at-start)//MINUTE+1] if step else []
            mae = None
            if len(path) and np.isfinite(path).all():
                mae = min(0., float(np.min(SIGN[side]*(path/first-1)))*10000)
            records.append(dict(id=int(cid), setup=int(c["setup"]), symbol=cat["symbol"], key=key, side=side,
                                decision=decision, setup_start=int(episode["time"]),
                                setup_end=int(state["time"][episode["last"]]), age=int(c["age"]),
                                entry=entry, end=exit_at, step=int(step), status=status,
                                entry_open=first, exit_open=last, mae_minute_open_bps=mae,
                                benchmark=int(cid) in benchmark_ids, asset_events=events[i][0],
                                market_events=events[i][1], **costs))
            groups[key].append(i)
        for key, positions in groups.items():
            rr = [records[i] for i in positions]
            coverage[key]["decisions"][side] = dict(rows=len(rr), episodes=len({r["setup"] for r in rr}),
                first=min(r["decision"] for r in rr), last=max(r["decision"] for r in rr),
                independent_news_events=len({e for r in rr for e in r["asset_events"]}),
                outcome_status={k:sum(r["status"]==k for r in rr) for k in sorted({r["status"] for r in rr})})
        output[side] = dict(names=names, x=x, records=records, scores=scores)
        print(stage, side, len(ids), "decisions", flush=True)
    dump(CACHE / (stage+".joblib"), dict(sides=output, markets=markets, window=window))
    with gzip.open(CACHE / (stage+"-coverage.json.gz"), "wt") as fp:
        json.dump(coverage, fp, allow_nan=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["history", "benchmark", "shadow"])
    stage = parser.parse_args().stage
    with threadpool_limits(limits=1):
        if stage == "shadow":
            from fresh_market import FreshReplay, capture_window
            window = load(PRIOR/"experiment-lock.json")["fresh"]
            capture_window(window)
            build(stage, FreshReplay(window), window)
        else:
            build(stage, CausalData() if stage == "history" else ForwardData(), PLAN)
