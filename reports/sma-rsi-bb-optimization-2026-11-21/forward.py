"""Rebuild the model inputs on the forward period using frozen source snapshots."""
import importlib.util
import urllib.parse
from pathlib import Path
import numpy as np

from train import HERE
from capture import CACHE, PLAN, read_json, ms
from repair_data import RepairData, ENTRY_CORE

spec = importlib.util.spec_from_file_location("forward_source", HERE.parent / "rally-signals-2026-11-17/data.py")
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
fresh = source.fresh
fresh.PLAN = {"market_end": PLAN["test_market_end"]}
fresh.MARKET_END = ms(PLAN["test_market_end"])
fresh.ENTRY_END = ms(PLAN["test_entry_end"])

class ForwardData(source.SignalData, RepairData):
    def __init__(self):
        self.complete_minutes = {}
        self.extensions = {}
        super().__init__()
        self.entry_names += ["active_sma_gap"]
        self.past_complete = np.zeros((len(self.d.state), 5), dtype=bool)
        self.actual_ends = []
        for cat in self.d.catalog:
            offset, n = cat["offset"], cat["bars"]
            complete = self.complete_minutes[cat["symbol"]]
            ends = np.flatnonzero(complete)
            self.actual_ends.append(ms(cat["start"]) + (int(ends[-1]) + 1) * fresh.MIN if len(ends) else ms(cat["start"]))
            count = np.cumsum(np.r_[0, complete.reshape(-1, 5).all(axis=1)])
            for column, width in enumerate((1, 3, 12, 48, 288)):
                self.past_complete[offset + width - 1 : offset + n, column] = count[width:] - count[:-width] == width
        self.actual_ends = np.asarray(self.actual_ends)
        indices = [self.entry_names.index(name) for name in ENTRY_CORE]
        self.core_ok = np.zeros(len(self.c), bool)
        for start in range(0, len(self.c), 8192):
            ids = np.arange(start, min(start + 8192, len(self.c)))
            self.core_ok[ids] = np.isfinite(self.entry_rows(ids)[:, indices]).all(axis=1)

    def read_source(self, kind, symbol):
        prior = super().read_source(kind, symbol)
        if symbol not in self.extensions:
            name = urllib.parse.quote(symbol, safe="") + ".json.gz"
            self.extensions[symbol] = read_json(CACHE / "snapshots" / name)
        extra = self.extensions[symbol]
        prior["rows"].extend(extra["rows"] if kind == "market" else extra["spot"])
        return prior

    def minutes(self, symbol, rows):
        full = super().minutes(symbol, rows)
        self.complete_minutes[symbol] = np.isfinite(full).all(axis=1)
        return full

    def build_candidates(self):
        setups, candidates = [], []
        pairs = fresh.sweep.CFG["pairs"]
        for cat in self.d.catalog:
            offset = cat["offset"]
            state = self.d.state[offset : offset + self.bars]
            window = (state["time"] >= ms(PLAN["test_start"])) & (state["time"] < fresh.ENTRY_END)
            signals = fresh.crossings(state["close"], pairs)
            for pair_id, pair in enumerate(pairs):
                for side, name, other in ((1, "long", "short"), (-1, "short", "long")):
                    crossing = signals[tuple(pair)]
                    opposite = np.flatnonzero(crossing[other])
                    for first in np.flatnonzero(crossing[name] & window):
                        next_opposite = np.searchsorted(opposite, first, side="right")
                        last = min(first + fresh.sweep.CFG["entry_window_bars"], self.bars - 1)
                        if next_opposite < len(opposite):
                            last = min(last, opposite[next_opposite] - 1)
                        rows = np.arange(first, last + 1)
                        rows = rows[state["eligible"][rows] & window[rows]]
                        if len(rows):
                            sid = len(setups)
                            setups.append((sid, cat["id"], offset + first, offset + last, side, pair_id,
                                           state["time"][first], -1, False, np.nan))
                            candidates.extend((sid, offset + at, pair_id, side, at - first, np.nan, np.nan) for at in rows)
        self.setups = np.asarray(setups, dtype=fresh.SETUP_DTYPE)
        self.c = np.asarray(candidates, dtype=fresh.CANDIDATE_DTYPE)
        self.setup_time = self.setups["time"][self.c["setup"]]
