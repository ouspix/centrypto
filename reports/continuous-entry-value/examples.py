"""Rebuild the frozen SMA opportunities and exit targets on continuous native history."""
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from urllib.parse import quote
import gzip
import json
import multiprocessing
import sys
import warnings

import joblib
import numpy as np
from archive import CACHE, HERE
from prepare import INPUTS, LEGACY, START, STOP, SYMBOLS
import spot

sys.path.insert(0, str(HERE.parent / "capped-entry-value"))
from decisions import (BAR, BREADTH, BUNDLE, CONFIGS, DAY, HOUR, MINUTE, OLD_CACHE, PRIOR_CACHE,
                       SIGN, augment, build_bank, file_hash, fixed_exits, load, ms, read_json)
from common import rolling
from data_four import CONTEXT_NAMES
from forward import fresh
from repair_data import ENTRY_CORE, RepairData
from stable_exits import StableExitInputs, ZERO_VARIANCE

FIT_START, FIT_STOP = ms("2026-04-01T00:00:00Z"), ms("2026-11-05T00:00:00Z")
MARKET = load(LEGACY/"market-feature-names.json")
SMA = load(LEGACY/"sma-feature-names.json")
PAIRS = fresh.sweep.CFG["pairs"]
CLOSED = HERE.parent / "capped-entry-value"
MODEL = joblib.load(BUNDLE)
if file_hash(BUNDLE) != load(HERE.parent/"net-value-entry-2026-11-22/experiment-lock.json")["bundle_sha256"]:
    raise ValueError("Frozen exit bundle hash mismatch")
GRID = SPOT = FUNDING = BENCH = BREADTH_ARRAY = None


def candle_bars(minutes):
    b = minutes.reshape(-1,5,5)
    valid = np.isfinite(b[:,:,3])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        a = np.column_stack([b[:,0,0],np.nanmax(b[:,:,1],1),np.nanmin(b[:,:,2],1),
                             b[:,-1,3],np.nansum(b[:,:,4],1)])
    a[valid.sum(1)<4] = np.nan
    return a,valid.all(1)


def initialize():
    global GRID, SPOT, FUNDING, BENCH, BREADTH_ARRAY
    GRID = np.load(CACHE/"minutes.npy",mmap_mode="r")
    SPOT = load(HERE/"spot-manifest.json")
    FUNDING = read_json(CACHE/"funding.json.gz")
    BENCH = {}
    for sym in ("BTC","ETH"):
        a,_ = candle_bars(GRID[SYMBOLS.index(sym)])
        BENCH.update({k:v for k,v in fresh.market(a,sym.lower()+"_").items()
                      if "_return_pct_" in k or "_rv_pct_" in k})
    returns = np.full((len(SYMBOLS),GRID.shape[1]//5),np.nan,dtype="f4")
    for i,minute in enumerate(GRID):
        # Canonical one-hour perp return on twelve fully observed five-minute bars.
        a,complete = candle_bars(minute)
        count = np.cumsum(np.r_[0,complete])
        vals = 100*(a[11:,3]/a[:-11,0]-1)
        returns[i,11:] = np.where(count[12:]-count[:-12]==12,vals,np.nan)
    count = np.isfinite(returns).sum(axis=0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore",RuntimeWarning)
        BREADTH_ARRAY = np.column_stack([fresh.safe((returns>0).sum(0),count),np.nanmedian(returns,axis=0),
                                         np.nanstd(returns,axis=0),count])


def observations(sym, a, close, times):
    features = fresh.market(a,"perp_") | BENCH
    features["rolling24h_close_return_pct"] = 100*(fresh.safe(close,fresh.lag(close,288))-1)
    hour = times/HOUR%24
    features.update(calendar_hour_sin=np.sin(2*np.pi*hour/24),calendar_hour_cos=np.cos(2*np.pi*hour/24))
    means = {n:fresh.sma(close,n) for n in {v for pair in PAIRS for v in pair}}
    for n,mean in means.items():
        features[f"sma_price_distance_{n}"] = 100*(fresh.safe(close,mean)-1)
        features[f"sma_slope_1h_{n}"] = 100*(fresh.safe(mean,fresh.lag(mean,12))-1)
    for fast,slow in PAIRS:
        features[f"sma_gap_{fast}_{slow}"] = 100*(fresh.safe(means[fast],means[slow])-1)
    sp = spot.bars(sym,SPOT)
    features.update({k:v for k,v in fresh.market(sp[:,:5],"spot_").items()
                     if any(s in k for s in ("return_pct","rv_pct","log_quote_volume"))})
    features["crossvenue_basis_bps"] = 10000*(fresh.safe(close,sp[:,3])-1)
    for w in fresh.WINDOWS:
        valid = fresh.sma(np.isfinite(sp).all(axis=1),w)>=.8
        features[f"spot_buy_imbalance_{5*w}m"] = np.where(valid,2*fresh.safe(rolling(sp[:,8],w),rolling(sp[:,5],w))-1,np.nan)
        features[f"spot_log_trade_count_{5*w}m"] = np.where(valid,np.log1p(rolling(sp[:,6],w)),np.nan)
        features[f"relative_btc_return_{5*w}m"] = features[f"perp_return_pct_{5*w}m"] - features[f"btc_return_pct_{5*w}m"]
    return features


class Series(RepairData):
    def __init__(self, sym, minute):
        a,complete = candle_bars(minute)
        n = len(a)
        self.d = fresh.ReplayStates()
        self.d.catalog = [dict(id=0,symbol=sym,bars=n,offset=0)]
        state = self.d.state = np.zeros(n,dtype=[("series","i4"),("time","i8"),("price","f8"),
            ("close","f8"),("eligible","?"),("terminal_price","f8")])
        state["time"] = START + (np.arange(n)+1)*BAR+5000
        state["price"] = np.r_[minute[6::5,0],np.nan]
        state["terminal_price"] = np.r_[state["price"][288:],np.full(288,np.nan)]
        state["close"] = close = minute[4::5,3]
        state["eligible"] = (np.arange(n)>=288)&(close*minute[4::5,4]>=fresh.MIN_VOLUME)&np.isfinite(close)
        self.past_complete = np.zeros((n,5),bool)
        count = np.cumsum(np.r_[0,complete])
        for col,w in enumerate(fresh.WINDOWS):
            self.past_complete[w-1:,col] = count[w:]-count[:-w]==w
        features = observations(sym,a,close,state["time"])
        missing = np.full(n,np.nan)
        self.d.market = np.column_stack([features.get(k,missing) for k in MARKET]).astype("f4")
        smas = fresh.sma_features(close)
        self.d.sma = np.column_stack([smas[k] for k in SMA]).astype("f4")
        self.entry_base_names = MARKET+SMA
        self.entry_names = self.entry_base_names+CONTEXT_NAMES+["active_sma_gap"]
        self.exit_names = MODEL["exits"]["long"][0]["input_names"]
        assert self.exit_names[:len(MARKET+SMA)] == MARKET+SMA
        self.features_available = set(features)|set(SMA)|set(CONTEXT_NAMES)|{"active_sma_gap"}
        setups, candidates = [], []
        signals = fresh.crossings(close,PAIRS)
        for side,choice in zip(("long","short"),MODEL["choices"]):
            sign = SIGN[side]
            pair = choice["pair"]
            cross = signals[tuple(PAIRS[pair])]
            opp = np.flatnonzero(cross["short" if sign==1 else "long"])
            for first in np.flatnonzero(cross[side] & (state["time"]>=FIT_START) & (state["time"]<FIT_STOP)):
                k = np.searchsorted(opp,first,side="right")
                last = min(first+12,n-1,opp[k]-1 if k<len(opp) else n-1)
                rows = np.arange(first,last+1)
                rows = rows[state["eligible"][rows] & self.past_complete[rows,-1] & (state["time"][rows]<FIT_STOP)]
                if len(rows):
                    idx = len(setups)
                    setups.append((idx,0,first,last,sign,pair,state["time"][first],-1,False,np.nan))
                    candidates.extend((idx,j,pair,sign,j-first,np.nan,np.nan) for j in rows)
        self.setups = np.array(setups,dtype=fresh.SETUP_DTYPE)
        self.c = np.array(candidates,dtype=fresh.CANDIDATE_DTYPE)


def rates_for(sym):
    rates = {int(k):v for k,v in FUNDING.get(sym,{}).items()}
    name = quote(sym,safe="")
    for folder,prefix,suffix in [(OLD_CACHE/"funding","recent-",".json"),
            (CACHE.parent/"capped-entry-value/hourly-funding","recent-",".json"),(PRIOR_CACHE/"snapshots","",".json.gz")]:
        path = folder/(prefix+name+suffix)
        if path.exists():
            rates.update({int(k):v for k,v in (read_json(path) if suffix.endswith("gz") else load(path))["rates"].items()
                          if int(k)>=ms("2026-11-01T00:00:00Z") and int(k)<STOP})
    return rates


def one(sym):
    folder = CACHE/"examples"
    target = folder/(quote(sym,safe="")+".joblib")
    minute = GRID[SYMBOLS.index(sym)]
    data = Series(sym,minute)
    state = data.d.state
    bank = build_bank(data,[CONFIGS[c["config"]] for c in MODEL["choices"]])
    rate = rates_for(sym)
    pay = np.full((STOP-START)//HOUR,np.nan)
    for h,r in rate.items():
        if START<=h<STOP and h%HOUR==0:
            pay[(h-START)//HOUR] = minute[(h-START)//MINUTE,0]*r
    flow = np.cumsum(np.r_[0.,np.nan_to_num(pay)])
    missing = np.cumsum(np.r_[0,~np.isfinite(pay)])
    result = {}
    for side,choice in zip(("long","short"),MODEL["choices"]):
        sign = SIGN[side]
        ids = np.flatnonzero(data.c["side"]==sign)
        raw = data.entry_rows(ids)
        valid = np.isfinite(raw[:,[data.entry_names.index(k) for k in ENTRY_CORE]]).all(1)
        ids = ids[valid]
        x,extra = augment(raw[valid],bank,ids,CONFIGS[choice["config"]])
        chosen = [i for i,k in enumerate(data.entry_names+extra) if (k in data.features_available or k in extra) and k not in ZERO_VARIANCE]
        names = [(data.entry_names+extra)[i] for i in chosen]+BREADTH
        rows = data.c["row"][ids]
        breadth = BREADTH_ARRAY[rows]
        x = np.column_stack([x[:,chosen],breadth,x[:,data.entry_names.index("perp_return_pct_60m")]-breadth[:,1]]).astype("f4")
        steps = fixed_exits(StableExitInputs(data), rows, sign, MODEL["exits"][side])
        enter = state["time"][rows]+55_000
        end = enter+steps*BAR
        price = state["price"][rows]
        last = state["price"][rows+steps]
        i,j = (enter-START)//HOUR+1,(end-START)//HOUR+1
        funding_ok = missing[j] == missing[i]
        # $100 notional, 1 bp adverse slip each leg, 4.5 bps fee each leg.
        paid,sold = price*(1+sign*.0001),last*(1-sign*.0001)
        qty = 100/paid
        y = 100*qty*(sign*(sold-paid)-.00045*(paid+sold)-sign*(flow[j]-flow[i]))
        status = np.select([~np.isfinite(price),steps==0,~funding_ok],["missing_entry","unresolved_exit","missing_funding"],default="priced")
        y[status!="priced"] = np.nan
        episodes = data.setups[data.c["setup"][ids]]
        result[side] = dict(names=names,x=x,y=y,decision=state["time"][rows],end=end,
                            setup_start=episodes["time"],setup_end=state["time"][episodes["last"]],status=status)
    tmp = target.with_suffix(".partial")
    joblib.dump(result,tmp,compress=2)
    tmp.replace(target)
    return sym,sum(len(p["y"]) for p in result.values())


def main():
    initialize()
    (CACHE/"examples").mkdir(exist_ok=True)
    tasks = sorted(SPOT["symbols"],key=lambda s:(s not in ("BTC","ETH","SOL","HYPE","ZEC"),s))
    with ProcessPoolExecutor(max_workers=6,mp_context=multiprocessing.get_context("fork")) as pool:
        for i,(symbol,count) in enumerate(pool.map(one,tasks),1):
            if i<=5 or i%10==0 or i==len(tasks):
                print(f"{i}/{len(tasks)} {symbol}: {count} decisions",flush=True)


if __name__ == "__main__":
    main()
