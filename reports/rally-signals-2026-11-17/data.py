"""Extend frozen source inputs and reuse the original feature calculations."""
import concurrent.futures
import gzip
import importlib.util
import json
import sys
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fresh", HERE.parent / "fresh-long-exit-2026-11-16/replay_fresh.py")
fresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fresh)
from features_two import market, rolling, safe, WINDOWS
from fetch_spot_two import get
import numpy as np

PLAN = json.loads((HERE / "plan.json").read_text())
CACHE = fresh.sweep.CACHE.parent / HERE.name
PRIOR = fresh.CACHE
fresh.CACHE = CACHE
fresh.PLAN = {"market_end": PLAN["market_end"]}
fresh.WINDOWS_UTC = PLAN["windows"]
fresh.ENTRY_END = fresh.sweep.ms(PLAN["windows"][-1]["end"])
fresh.MARKET_END = fresh.sweep.ms(PLAN["market_end"])


def extend_spot():
    folder = CACHE / "spot"
    folder.mkdir(parents=True, exist_ok=True)
    old_end = fresh.sweep.read_json(HERE.parent / "fresh-long-exit-2026-11-16/plan.json")["market_end"]
    def one(file):
        target = folder / file.name
        if target.exists():
            return
        payload = fresh.gz(file)
        if payload["status"] in {"available", "no_candles"}:
            rows = get({"symbol":payload["pair"],"interval":"5m","startTime":fresh.sweep.ms(old_end),
                        "endTime":fresh.MARKET_END-1,"limit":1000})
            payload["rows"].extend(rows)
        target.write_bytes(gzip.compress(json.dumps(payload).encode(), mtime=0))
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(one, sorted((PRIOR / "spot").glob("*.json.gz"))))


class SignalData(fresh.FreshData):
    def build_series(self, reference, row, sid, bars, close, quote_volume, new_ticks, benchmark):
        super().build_series(reference, row, sid, bars, close, quote_volume, new_ticks, benchmark)
        spot = np.full((self.bars,9),np.nan)
        archive = fresh.sweep.BASE_CACHE / "spot" / (row["key"] + ".json.gz")
        files = ([fresh.gz(archive)] if archive.exists() else []) + [self.read_source("spot",row["symbol"])]
        start = fresh.sweep.ms(row["start"])
        for payload in files:
            mult = payload["multiplier"]
            for r in payload["rows"]:
                j = (int(r[0])-start)//fresh.BAR
                assert np.isnan(spot[j,0])
                spot[j] = [float(r[k])*(mult if k in [1,2,3,4] else 1/mult if k in [5,9] else 1)
                           for k in [1,2,3,4,5,7,8,9,10]]
        features = {k:v for k,v in market(spot[:,:5],"spot_").items()
                    if any(s in k for s in ["return_pct","rv_pct","log_quote_volume"])}
        for w in WINDOWS:
            valid = rolling(np.isfinite(spot).all(axis=1),w)>=.8*w
            features[f"spot_buy_imbalance_{w*5}m"] = np.where(valid,2*safe(rolling(spot[:,8],w),rolling(spot[:,5],w))-1,np.nan)
            features[f"spot_log_trade_count_{w*5}m"] = np.where(valid,np.log1p(rolling(spot[:,6],w)),np.nan)
        series = slice(sid*self.bars,(sid+1)*self.bars)
        old = slice(row["offset"],row["offset"]+row["bars"])
        for name,values in features.items():
            column=reference.market_names.index(name)
            values=values.astype("f4")
            assert np.allclose(values[:self.archive_bars],reference.market[old,column],rtol=1e-6,atol=1e-6,equal_nan=True)
            self.d.market[series,column]=values


if __name__ == "__main__":
    extend_spot()
    print("Spot source extended",flush=True)
