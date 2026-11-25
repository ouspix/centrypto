"""Independently check indicators, split boundaries, model files and the forward ledger."""
from datetime import datetime, timezone
from functools import lru_cache
import json
import math
import urllib.parse
import numpy as np
import joblib
from train import HERE, CACHE, SOURCE, PLAN, CONFIGS, FOLD, member_path, save_json, file_hash
from capture import ms, read_json, HOUR
from indicators import on_segment
from price_common import BASE_CACHE
from repair_replay import models_for

def indicator_checks():
    close=100+np.cumsum(np.random.default_rng(19).normal(size=400))
    for period in [3,7.5,15,96]:
        n=math.ceil(period)
        up=np.maximum(np.diff(close[:n+1]),0).mean()
        down=np.maximum(-np.diff(close[:n+1]),0).mean()
        values=on_segment(close,"rsi",period)
        for i in range(n,len(close)):
            if i>n:
                change=close[i]-close[i-1]
                up+=(max(change,0)-up)/period
                down+=(max(-change,0)-down)/period
            np.testing.assert_allclose(values[i,0],100*up/(up+down),rtol=1e-9)
    for n in [5,20,120]:
        values=on_segment(close,"bb",n)
        for i in range(n-1,len(close)):
            window=close[i-n+1:i+1]
            avg,sd=window.mean(),window.std()
            np.testing.assert_allclose(values[i,:2],[.5+(close[i]-avg)/(4*sd),4*sd/avg],atol=1e-9)
        np.testing.assert_allclose(values[:200],on_segment(close[:200],"bb",n),equal_nan=True)
    assert (on_segment(np.ones(75),"rsi",15)[15:,0]==50).all()

@lru_cache(maxsize=None)
def prices(symbol):
    snap=read_json(CACHE/"snapshots"/(urllib.parse.quote(symbol,safe="")+".json.gz"))
    return {r[0]:r[1] for r in snap["rows"]},{int(k):v for k,v in snap["rates"].items()}

def main():
    indicator_checks()
    result=json.loads((HERE/"result.json").read_text())
    lock=json.loads((HERE/"selection.json").read_text())
    assert file_hash(HERE/"selection.json")==result["selection_sha256"]
    ledger=json.loads((HERE/"trades.json").read_text())
    assert ms(PLAN["validation_market_end"])+86400000<=ms(PLAN["test_start"])
    from causal_candidates import CausalData
    data=CausalData()
    train_end=0
    for side in ("long","short"):
        pack=joblib.load(SOURCE/side/"train.joblib",mmap_mode="r")
        train_end=max(train_end,int(data.completion[pack["ids"]].max()))
    assert train_end+86400000<ms(PLAN["validation_start"])
    checked=0
    for name,trades in ledger.items():
        busy={}
        for t in trades:
            entry,exit=ms(t["entry_time"]),ms(t["exit_time"])
            assert ms(PLAN["test_start"])<=entry<=ms(PLAN["test_entry_end"])
            assert entry<exit<=min(entry+86400000,ms(PLAN["test_market_end"]))
            assert entry>busy.get(t["symbol"],0)
            busy[t["symbol"]]=exit if t["scored"] else ms(PLAN["test_market_end"])
            price,rate=prices(t["symbol"])
            side=t["side_sign"]
            if t["net"] is None:
                continue
            slip=PLAN["slippage_bps"]/10000
            open_px=price[entry]*(1+side*slip)
            close_px=price[exit]*(1-side*slip)
            qty=PLAN["notional"]/open_px
            hours=range((entry//HOUR+1)*HOUR,exit+1,HOUR)
            funded=sum(side*qty*price[h]*rate[h] for h in hours)
            fees=(open_px+close_px)*qty*PLAN["fee_bps"]/10000
            pnl=(close_px-open_px)*side*qty-fees-funded
            assert abs(pnl-t["net"])<1e-8
            checked+=1
        stats=result["results"][name]["overall"]
        assert stats["trades"]==len(trades)
        if stats["net"] is not None:
            assert abs(stats["net"]-sum(t["net"] for t in trades))<1e-9
    networks=list((CACHE/"weights").glob("*.joblib"))
    assert len(networks)==(len(CONFIGS)-1)*2*len(PLAN["seeds"])
    retained=set()
    for path in networks:
        m=joblib.load(path)
        assert m["selected_updates"]==4000
        retained.update(m["preprocess"].names)
    for m in models_for(FOLD):
        for roles in m.values():
            for model in roles.values():
                retained.update(model["preprocess"].names)
    assert not any(n.startswith(("derivative_","liquidity_")) for n in retained)
    manifest={p.name:file_hash(p) for p in sorted((CACHE/"snapshots").glob("*.json.gz"))}
    assert len(manifest)==179
    save_json(HERE/"snapshot-hashes.json",manifest)
    save_json(HERE/"verification.json",dict(trained_networks=len(networks),updates_per_network=4000,
        forward_trade_rows_reconciled=checked,snapshots=len(manifest),
        last_training_label_completed_utc=datetime.fromtimestamp(train_end/1000,timezone.utc).isoformat(),
        checks=["RSI fractional and integer reference recurrence","Bollinger rolling-window reference",
                "chronological label purge","model checkpoint counts","independent raw-minute and hourly funding replay",
                "nonoverlapping positions per symbol","forward input coverage for retained feature types"]))
    print("Verified",len(networks),"trained networks and",checked,"priced forward trade records")

if __name__=="__main__":
    main()
