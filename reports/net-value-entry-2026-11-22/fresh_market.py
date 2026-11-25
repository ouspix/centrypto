"""Capture the locked, subsequently observed market window once its exits mature."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import json
import sqlite3
from urllib.parse import quote, urlencode
from urllib.request import Request

import numpy as np

from run_common import CACHE, DAY, HOUR, MINUTE, PLAN, PRIOR_CACHE, file_hash, load, ms, read_json, save_json
from capture import DB, fetch
from economics import Costs
from forward import ForwardData, fresh
import forward
from historical_labels import FundingCapture

FRESH = CACHE / "fresh-market"
MANIFEST = FRESH / "manifest.json"


def status(window, now=None):
    tail = ms(window["test_market_end"])
    current = datetime.now(timezone.utc) if now is None else now
    if ms(current.isoformat()) < tail:
        raise ValueError(f"Fresh test is locked until {window['test_market_end']}.")


def spot_tail(symbol, begin, stop):
    prior = forward.source.CACHE / "spot" / (quote(symbol, safe="") + ".json.gz")
    spot = read_json(prior)
    if spot["status"] not in {"available", "no_candles"}:
        return []
    path = "https://api.binance.com/api/v3/klines?"
    output = []
    cursor = begin
    while cursor < stop:
        query = urlencode(dict(symbol=spot["pair"], interval="5m", startTime=cursor,
                               endTime=stop - 1, limit=1000))
        page = fetch(Request(path + query))
        if not page:
            break
        output.extend(row for row in page if begin <= int(row[0]) and int(row[6]) < stop)
        next_cursor = int(page[-1][0]) + 5 * MINUTE
        if next_cursor <= cursor:
            raise ValueError(f"Non-advancing spot page for {symbol}")
        cursor = next_cursor
    return output


def capture_window(window):
    status(window)
    if MANIFEST.exists():
        manifest = load(MANIFEST)
        assert manifest["period"] == window
        assert all(file_hash(FRESH / name) == entry["sha256"] for name, entry in manifest["symbols"].items())
        return manifest
    begin = ms(PLAN["test_market_end"])
    stop = ms(window["test_market_end"])
    first_funding = ms(window["test_start"])
    if not begin <= first_funding < stop:
        raise ValueError("Fresh dates overlap the frozen historical data")
    FRESH.mkdir(parents=True, exist_ok=True)
    fetcher = FundingCapture()
    original_paths = sorted((PRIOR_CACHE / "snapshots").glob("*.json.gz"))
    assert len(original_paths) == 179
    with sqlite3.connect(DB.as_uri() + "?mode=ro", uri=True, timeout=30) as db:
        for symbol in ("BTC", "ETH"):
            recorded = db.execute("SELECT open_at FROM best_candle WHERE symbol=? AND open_at>=? LIMIT 1",
                                  (symbol, stop - MINUTE)).fetchone()
            if recorded is None:
                raise ValueError(f"The market archive has not reached the locked cutoff for {symbol}")

    def one(original):
        symbol = read_json(original)["symbol"]
        target = FRESH / original.name
        if target.exists():
            payload = read_json(target)
            assert payload["period"] == window and payload["symbol"] == symbol
        else:
            with sqlite3.connect(DB.as_uri() + "?mode=ro", uri=True, timeout=30) as db:
                rows = db.execute(
                    "SELECT open_at,o,h,l,c,v,origin FROM best_candle WHERE symbol=? AND open_at>=? "
                    "AND open_at<? ORDER BY open_at", (symbol, begin, stop),
                ).fetchall()
            assert len({r[0] for r in rows}) == len(rows)
            rates = fetcher.rates(symbol, first_funding, (stop - 1) // HOUR * HOUR) if rows else {}
            payload = dict(symbol=symbol, rows=[r[:-1] for r in rows], rates=rates,
                           spot=spot_tail(symbol, begin, stop), period=window,
                           origins=dict(Counter(row[-1] for row in rows)))
            temp = target.with_suffix(".tmp")
            temp.write_bytes(gzip.compress(json.dumps(payload, separators=(",", ":")).encode(), mtime=0))
            temp.replace(target)
        return original.name, dict(symbol=symbol, sha256=file_hash(target), candles=len(payload["rows"]),
                                   spot=len(payload["spot"]), rates=len(payload["rates"]), origins=payload["origins"])

    manifest = dict(period=window, source_start=PLAN["test_market_end"], symbols={})
    with ThreadPoolExecutor(max_workers=6) as pool:
        for count, (name, entry) in enumerate(pool.map(one, original_paths), 1):
            manifest["symbols"][name] = entry
            if count % 20 == 0 or count == len(original_paths):
                print(f"Captured {count}/{len(original_paths)} fresh symbols", flush=True)
    save_json(MANIFEST, manifest)
    return manifest


class FreshReplay(ForwardData):
    def __init__(self, window):
        forward.PLAN = dict(PLAN, **window)
        fresh.PLAN = {"market_end": window["test_market_end"]}
        fresh.MARKET_END = ms(window["test_market_end"])
        fresh.ENTRY_END = ms(window["test_entry_end"])
        self.holdout = {}
        super().__init__()

    def read_source(self, kind, symbol):
        prior = super().read_source(kind, symbol)
        if symbol not in self.holdout:
            self.holdout[symbol] = read_json(FRESH / (quote(symbol, safe="") + ".json.gz"))
        prior["rows"].extend(self.holdout[symbol]["rows" if kind == "market" else "spot"])
        return prior

    def replay_ids(self, start, end, side=None, quality=True):
        at = self.d.state["time"][self.c["row"]]
        keep = (self.setup_time >= start) & (at + 55_000 + DAY < end)
        if side is not None:
            keep &= self.c["side"] == side
        if quality:
            keep &= self.core_ok
        return np.flatnonzero(keep)


class FreshCosts(Costs):
    def settlement_inputs(self, symbol):
        cat = self.cats[symbol]
        return ms(cat["start"]), self.data.opens[symbol], self.rates[symbol]

    def __init__(self, data):
        super().__init__(data)
        self.rates = {symbol: {int(hour): rate for hour, rate in snap["rates"].items()}
                      for symbol, snap in data.holdout.items()}
