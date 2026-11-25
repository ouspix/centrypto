"""Independently check price paths, completed outcomes, funding and desk sizing limits."""
from collections import defaultdict
import gzip
import json

import joblib
import numpy as np

from brackets import HERE, MARK_STOP, minute
from desk_replay import CAPITAL, COST_RATE, LIMITS
from entry_fit import FAMILIES, load_data
from news_replay import CUTS, ENTRY_END, MARK, START_ADAPTATION
from settings import FEE, GATE, MINUTE, MODES, START, TEST_START, file_hash, load, ms, save_json
from source_data import FUNDING, GRID


def first_path(t, mode, frame, raw, pair, through, protection):
    sign=t["sign"]; ent=t["entry"]; j=t["asset"]
    bounds=pair
    paid=raw[j,ent,0]*(1+sign*MODES[mode][1])
    target=paid*(1+sign*bounds[0]/10000)
    stop=paid*(1-sign*bounds[1]/10000)
    hi,lo=raw[j,ent:through,1],raw[j,ent:through,2]
    stop_cross=np.flatnonzero(lo<=stop if sign==1 else hi>=stop)
    target_cross=np.flatnonzero(hi>=target if sign==1 else lo<=target)
    stop_end=ent+int(stop_cross[0])+1 if len(stop_cross) else np.inf
    target_end=ent+int(target_cross[0])+1 if len(target_cross) else np.inf
    close_ref=int(frame["end_"+mode]) if protection else None
    if protection:
        reason=int(frame["reason_"+mode]) if 0<=close_ref<=through else 0
        expected=close_ref if reason else None
        if stop_end<=through and (expected is None or stop_end<=expected):
            expected=stop_end
            reason=1
    else:
        expected=min(stop_end,target_end)
        reason=1 if stop_end<=target_end else 2
        if expected>through:
            expected=None
            reason=0
    assert expected==t["end"] and reason==t["reason"],(mode,t["id"],expected,t["end"],reason,t["reason"])
    np.testing.assert_allclose([paid,stop],[t["paid"],t["stop"]],atol=1e-9)
    if expected is None:return
    if reason==1:
        o=raw[j,expected-1,0]
        exit_price=min(stop,o) if sign==1 else max(stop,o)
    elif reason==2:
        exit_price=target
    else:
        exit_price=raw[j,expected,0]
    np.testing.assert_allclose(t["sold"],exit_price*(1-sign*MODES[mode][1]),atol=1e-9)


def reconcile(trades,begin,stop,raw,rates):
    first,last=minute(begin),minute(stop)
    cash,mtm=np.zeros((2,last-first+1))
    missing=0
    for t in trades:
        j=t["asset"]; sign=t["sign"]; size=t["size"]; q=t["qty"]; ent=t["entry"]
        end=t["end"]
        effective=end if end is not None else last
        assert t["score_bps"]>GATE
        assert size<=LIMITS["maxOrderUsd"]+1e-9 and size<=LIMITS["maxInstrumentUsd"]+1e-9
        risk_amount=size*(abs(1-t["stop"]/t["paid"])+COST_RATE)
        assert np.isclose(risk_amount,t["planned_risk"])
        assert risk_amount<=LIMITS["maxRiskPerTradeUsd"]+1e-9
        assert t["risk_before"]+risk_amount<=LIMITS["maxOpenRiskUsd"]+1e-9
        assert t["gross_before"]+size*(1+FEE)<=min(CAPITAL,t["equity_before"])*LIMITS["maxGrossLeverage"]+1e-9
        cash[ent-first]-=size*FEE
        end_mark=effective+int(end is None)
        last_price=t["paid"]
        for i,price in enumerate(raw[j,ent:end_mark,0]):
            if np.isfinite(price):last_price=price
            mtm[ent-first+i]+=q*sign*(last_price-t["paid"])
        funding=0.
        for h in range((ent//60+1)*60,effective+1,60):
            valid=raw[j,h-5:h+1,0]
            valid=valid[np.isfinite(valid)]
            rate=rates[t["symbol"]].get(START+h*MINUTE)
            if not len(valid) or rate is None:
                missing+=1
                continue
            v=-sign*q*valid[-1]*rate
            funding+=v
            cash[h-first]+=v
        np.testing.assert_allclose(t["funding"],funding,atol=1e-9)
        if end is not None:
            close=q*(sign*(t["sold"]-t["paid"])-FEE*t["sold"])
            cash[end-first]+=close
            np.testing.assert_allclose(t["net"],close-size*FEE+funding,atol=1e-9)
    eq=CAPITAL+cash.cumsum()+mtm
    return eq[-1]-CAPITAL,(np.maximum.accumulate(eq)-eq).max(),missing


def verify():
    source,x,_,_=load_data()
    raw=np.load(GRID,mmap_mode="r")
    rates=joblib.load(FUNDING)
    selected=load(HERE/"selection.json")["selected"]["pairs"]
    pairs={int(s):tuple(v) for s,v in selected.items()}
    complete=0
    held=0
    result=load(HERE/"results.json")
    for policy,full in source.items():
        frame=full[full.decision>=TEST_START].reset_index(drop=True)
        groups=defaultdict(list)
        with gzip.open(HERE/(policy+"-trades.jsonl.gz"),"rt") as fp:
            for line in fp:
                row=json.loads(line)
                mode=row["mode"]
                first_path(row,mode,frame.iloc[row["id"]],raw,pairs[row["sign"]],minute(MARK_STOP),policy!="bracket")
                groups[mode,row["model"]].append(row)
        for mode in MODES:
            for name,report in result["policies"][policy][mode].items():
                trades=groups[mode,name]
                net,dd,missing=reconcile(trades,TEST_START,MARK_STOP,raw,rates)
                assert len(trades)==report["trades"]
                assert missing==report["missing_funding_hours"]
                np.testing.assert_allclose([net,dd],[report["net"],report["max_drawdown"]],atol=1e-7)
                complete+=len(trades)
                held+=sum(t["end"] is None for t in trades)

    nresult=load(HERE/"news-results.json")
    with gzip.open(HERE/"news-trades.jsonl.gz","rt") as fp:
        groups=defaultdict(list)
        for line in fp:
            t=json.loads(line)
            groups[t["model"],t["mode"]].append(t)
    for name,modes in nresult["models"].items():
        _,policy,_=name.split("/")
        f=source[policy]
        f=f[(f.decision>=START_ADAPTATION)&(f.decision<ENTRY_END)].reset_index(drop=True)
        for mode,report in modes.items():
            trades=groups[name,mode]
            for t in trades:
                first_path(t,mode,f.iloc[t["id"]],raw,pairs[t["sign"]],minute(MARK),policy!="bracket")
            net,dd,missing=reconcile(trades,CUTS[-1],MARK,raw,rates)
            assert len(trades)==report["trades"] and missing==report["missing_funding_hours"]
            np.testing.assert_allclose([net,dd],[report["net"],report["max_drawdown"]],atol=1e-7)
            complete+=len(trades)
            held+=sum(t["end"] is None for t in trades)
    for family in FAMILIES:
        for details in load(HERE/(family+"-training.json"))["policies"].values():
            assert ms(details["final"]["matured_at"])<TEST_START
            for fold in details["folds"]:assert ms(fold["train"]["matured_at"])<ms(fold["begin"])
    forward=load(HERE.parents[1]/"capped-entry-value/forward-runtime-lock.json")["files"]
    for p,h in forward.items(): assert file_hash(HERE.parents[2]/p)==h
    receipt=dict(ledger_positions=complete,marked_open=held,forward_hashes=len(forward),
                 main_results=file_hash(HERE/"results.json"),news_results=file_hash(HERE/"news-results.json"))
    save_json(HERE/"verification.json",receipt)
    print(receipt,flush=True)


if __name__=="__main__":
    verify()
