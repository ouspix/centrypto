"""Verify the fit's saved inputs, sampled added targets and shared backtest."""
from collections import Counter
import json

import joblib
import numpy as np

from extend_history import HERE, ROOT, CACHE, WARMUP, SYMBOLS, BEGIN, SPLIT
from fit_extended import ARMS, LOCK, MODEL, HURDLE, FIT_END, CALIBRATE, SELECT, examples_paths
from decisions import DAY, MINUTE, SIGN, iso, load, file_hash, save_json
from run_common import funding_hours, trade_costs
from decisions import read_json


def verify():
    lock=load(LOCK)
    assert file_hash(MODEL)==lock["model_sha256"]
    for file,expected in lock["input_hashes"].items():
        assert file_hash(ROOT/file)==expected,file
    results=load(HERE/"benchmark.json")
    assert results["research_lock_sha256"]==file_hash(LOCK)
    for file,expected in results["source_hashes"].items():
        assert file_hash(ROOT/file)==expected,file
    archive=load(HERE/"archive-inputs.json")
    assert file_hash(CACHE/"minutes.npy")==archive["minute_grid_sha256"]
    assert file_hash(CACHE/"funding.json.gz")==archive["funding_subset_sha256"]
    grid=np.load(CACHE/"minutes.npy",mmap_mode="r")
    rates=read_json(CACHE/"funding.json.gz")
    rng=np.random.default_rng(3572026)
    sample_count,funding_count=0,0
    by_side={s:Counter() for s in SIGN}
    for symbol,path in examples_paths()["extended"].items():
        opens=grid[SYMBOLS.index(symbol),:,0]
        pack=joblib.load(path)
        symbol_rates=rates.get(symbol,{})
        for side,r in pack.items():
            permitted=np.flatnonzero(np.isfinite(r["y"]))
            by_side[side].update(iso(t//DAY*DAY)[:10] for t in r["decision"][permitted])
            for j in rng.choice(permitted,min(64,len(permitted)),replace=False):
                t=int(r["decision"][j])+55_000
                exit_at=int(r["end"][j])
                assert 0 < exit_at-t <= DAY
                hours=list(funding_hours(t,exit_at))
                payment=sum(opens[(h-WARMUP)//MINUTE]*symbol_rates[str(h)] for h in hours)
                p0,p1=opens[(t-WARMUP)//MINUTE],opens[(exit_at-WARMUP)//MINUTE]
                net=trade_costs(p0,p1,SIGN[side],payment)["net"]*100
                assert np.isclose(net,r["y"][j],rtol=1e-8,atol=1e-7),(symbol,side,iso(t))
                sample_count+=1
                funding_count+=bool(hours)
    days={iso(t)[:10] for t in range(BEGIN,FIT_END,DAY)}
    for side,r in lock["training"].items():
        assert by_side[side]==r["extended"]["daily"]
        assert not set(r["extended"]["daily"])&set(r["shared"]["daily"])
        assert set(r["extended"]["daily"])|set(r["shared"]["daily"])==days
        assert r["rows"]==r["extended"]["rows"]+r["shared"]["rows"]
    for mode,result in results["modes"].items():
        assert tuple(result["arms"])==ARMS
        supports=[]
        for arm,r in result["arms"].items():
            assert r["hurdle_bps"]==HURDLE
            assert r["peak_entry_notional"]<=1000 and r["trades"]==len(r["ledger"])
            assert all(t["score"]>HURDLE for t in r["ledger"])
            if r["net"] is not None:
                assert np.isclose(r["net"],sum(t["net"] for t in r["ledger"]),atol=1e-8)
            supports.append(r["eligible"])
        assert len(set(supports))==1
        for r in result["comparisons"].values():
            if r["net_difference"] is not None:
                assert np.isclose(r["net_difference"],sum(r["paired"]["daily"].values()),atol=1e-8)
    save_json(HERE/"verification.json",dict(input_hashes_verified=len(lock["input_hashes"]),
       model_sha256=lock["model_sha256"],priced_targets_sampled=sample_count,targets_with_settlements=funding_count,
       contiguous_dates_per_side=len(days),same_decision_population=True,prior_benchmark_and_control_reproduced=True))
    print("Verified",len(days),"training dates per side,",sample_count,"sampled added targets and all backtest ledgers.")


if __name__=="__main__":
    verify()
