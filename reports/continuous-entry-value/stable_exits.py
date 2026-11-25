"""Evaluate the same fixed exit weights with exact one-return volatility on all v2 tapes."""
from pathlib import Path
import argparse
import sys

import joblib
import numpy as np
from archive import CACHE, HERE

sys.path.insert(0,str(HERE.parent/"capped-entry-value"))
from decisions import BUNDLE, BAR, DAY, dump, file_hash, fixed_exits, load
from forward import ForwardData, fresh
from repair_data import RepairData
from repair_common import CACHE as REPAIR
from common import BASE_CACHE, CACHE as REBUILT

ZERO_VARIANCE = {p+"_rv_pct_5m" for p in ("perp","spot","btc","eth")}


class StableExitInputs:
    def __init__(self, source):
        self.source = source
        self.d = source.d
        self.exit_names = source.exit_names
        self.columns = [self.exit_names.index(k) for k in sorted(ZERO_VARIANCE)]

    def exit_rows(self, *args):
        raw = self.source.exit_rows(*args)
        v = raw[:,self.columns]
        # One finite return has zero dispersion after subtracting its own mean.
        raw[:,self.columns] = np.where(np.isfinite(v),0.,np.nan)
        return raw


def historical_state(names):
    obj = object.__new__(RepairData)
    obj.exit_names = names
    obj.past_complete = np.load(REPAIR/"past-complete.npy",mmap_mode="r")
    obj.d = fresh.ReplayStates()
    obj.d.state = np.load(REBUILT/"state.npy",mmap_mode="r")
    obj.d.market = np.load(BASE_CACHE/"market.npy",mmap_mode="r")
    obj.d.sma = np.load(REBUILT/"sma.npy",mmap_mode="r")
    obj.d.catalog = load(HERE.parent/"two-stage-rebuild-2026-11-14/catalog.json")
    return obj


def materialize(stage):
    base = CACHE.parent/"capped-entry-value"/(stage+".joblib")
    tape = joblib.load(base)
    model = joblib.load(BUNDLE)
    src = historical_state(model["exits"]["long"][0]["input_names"]) if stage=="history" else ForwardData()
    stable = StableExitInputs(src)
    cats = {r["key"]:r for r in src.d.catalog}
    times = src.d.state["time"]
    saved = {}
    for side,sign in (("long",1),("short",-1)):
        rr = tape["sides"][side]["records"]
        idx = np.empty(len(rr),int)
        for i,r in enumerate(rr):
            cat = cats[r["key"]]
            ofs,n = cat["offset"],cat["bars"]
            idx[i] = ofs+np.searchsorted(times[ofs:ofs+n],r["decision"])
            assert ofs<=idx[i]<ofs+n and times[idx[i]]==r["decision"]
        weights = model["exits"][side]
        def exit_steps(data):
            return np.concatenate([fixed_exits(data,b,sign,weights) for b in np.array_split(idx,max(1,(len(idx)+3999)//4000))])
        actual = exit_steps(src)
        assert np.array_equal(actual,[r["step"] for r in rr]),"Reconstruction must reproduce every original exit before applying the fix"
        corrected = exit_steps(stable)
        saved[side] = corrected
        print(stage,side,"verified original exits",len(idx),"corrected exit times",np.sum(corrected!=actual),flush=True)
    dump(CACHE/(stage+"-stable-exits.joblib"),dict(base=file_hash(base),steps=saved))


def apply_to(tape,stage):
    aligned = joblib.load(CACHE/(stage+"-stable-exits.joblib"))
    assert aligned["base"]==file_hash(CACHE.parent/"capped-entry-value"/(stage+".joblib"))
    for side,steps in aligned["steps"].items():
        for r,step in zip(tape["sides"][side]["records"],steps,strict=True):
            r["step"] = int(step)
            r["end"] = r["entry"] + (int(step)*BAR if step else DAY)


if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage",choices=("history","benchmark"))
    materialize(parser.parse_args().stage)
