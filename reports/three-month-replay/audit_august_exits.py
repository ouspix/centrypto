"""Apply the earlier November exit weights to the August calibration paths for attribution."""
from concurrent.futures import ProcessPoolExecutor
from urllib.parse import quote
from unittest.mock import patch

import joblib
import numpy as np

from config import CACHE,REPORTS,ROLES,START,MINUTE,BAR,DAY,CAL_START,CAL_STOP,TEST_START
from config import BASE_SLIP,SYMBOLS,load,iso,file_hash
from source_data import GRID,FUNDING
from exit_policy import Prices
from examples import Series,candle_bars
from stable_exits import StableExitInputs
import examples
import spot

AUG_START=CAL_START-3*DAY
AUG_STOP=TEST_START
OFF=(AUG_START-START)//MINUTE
END=(AUG_STOP-START)//MINUTE

def prepare():
    global RAW,RATES,MARKET,SPOT
    RAW=np.load(GRID,mmap_mode="r")
    RATES=joblib.load(FUNDING)
    MARKET={}
    for s in ("BTC","ETH"):
        bars,_=candle_bars(RAW[SYMBOLS.index(s),OFF:END])
        MARKET.update({k:v for k,v in examples.fresh.market(bars,s.lower()+"_").items()
                       if "_return_pct_" in k or "_rv_pct_" in k})
    m=load(REPORTS/"continuous-entry-value/spot-manifest.json")
    SPOT=dict(m,partitions={k:v for k,v in m["partitions"].items() if "-2026-08." in k or "-2026-08-" in k})

def compare(path):
    part=joblib.load(path)
    sym=part["symbol"]
    if not any(len(part["sides"][s]["cal"]["row"]) for s in ROLES):
        return {}
    raw=RAW[SYMBOLS.index(sym)]
    px=Prices(raw[:,0],RATES[sym])
    with patch.multiple(examples,START=AUG_START,BENCH=MARKET,SPOT=SPOT,FIT_START=AUG_START,FIT_STOP=AUG_START), \
            patch.multiple(spot,START=AUG_START,STOP=AUG_STOP):
        source=Series(sym,raw[OFF:END])
    state=source.d.state
    exits=StableExitInputs(source)
    out={}
    for side,(sign,_,_) in ROLES.items():
        p=part["sides"][side]["cal"]
        at=p["decision"]
        if not len(at):
            continue
        local=np.searchsorted(state["time"],at)
        np.testing.assert_array_equal(state["time"][local],at)
        np.testing.assert_allclose(state["price"][local],raw[p["minute"],0],equal_nan=True)
        step=examples.fixed_exits(exits,local,sign,examples.MODEL["exits"][side])
        old_end=np.where(step>0,p["minute"]+5*step,-1)
        y_old=px.payoff(p["minute"],old_end,sign,BASE_SLIP)*100.
        out[side]=(p["y"],y_old,p["minute"],p["end"],old_end)
    return out

def run_august():
    prepare()
    merged={s:[] for s in ROLES}
    with ProcessPoolExecutor(max_workers=5) as pool:
        for piece in pool.map(compare,sorted((CACHE/"targets").glob("*.joblib"))):
            for side,values in piece.items():
                merged[side].append(values)
    out={}
    for side,parts in merged.items():
        new,old,entry,new_end,old_end=[np.concatenate(values) for values in zip(*parts,strict=True)]
        common=np.isfinite(old)&np.isfinite(new)
        out[side]=dict(decisions=len(new),matched_priced=int(common.sum()),
            old_mean_bps=float(old[common].mean()),new_mean_bps=float(new[common].mean()),
            full_new_mean_bps=float(np.nanmean(new)),
            old_median_hold=float(np.median(old_end[common]-entry[common])),
            new_median_hold=float(np.median(new_end[common]-entry[common])),
            changed_exit=int((new_end[common]!=old_end[common]).sum()))
    return out
