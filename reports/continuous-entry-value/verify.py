"""Verify frozen input hashes, calendar coverage, sampled labels, and overlap with the legacy tape."""
from collections import defaultdict
import gzip
import sys

import joblib
import numpy as np
from archive import HERE, CACHE
from prepare import START, SYMBOLS
from fit_continuous import (ARMS, BASE, BEGIN, FIT_END, LOCK, MODEL_PATH, block, file_hash, iso, load,
                            partition_inputs, priced, save_json, score, supplements)
from decisions import BAR, DAY, MINUTE, SIGN, ms, read_json
from run_common import funding_hours, trade_costs
from examples import rates_for
import examples
from stable_exits import apply_to,ZERO_VARIANCE


def main():
    lock = load(LOCK)
    assert file_hash(MODEL_PATH)==lock["bundle_sha256"]
    for name,digest in lock["source_hashes"].items():
        assert file_hash(HERE.parents[1]/name)==digest,name
    results = load(HERE/"benchmark.json")
    assert results["lock_sha256"]==file_hash(LOCK)
    assert results["stable_exit_sha256"]==file_hash(CACHE/"benchmark-stable-exits.joblib")
    for name,digest in results["inputs"].items():
        assert file_hash(BASE/name)==digest
    model = joblib.load(MODEL_PATH)
    tape = joblib.load(BASE/"history.joblib")
    supplements(tape)
    apply_to(tape,"history")
    historical = priced(tape,joblib.load(BASE/"history-evidence.joblib"),"observed")
    reference = {}
    for side,rows in historical.items():
        for r,ok in zip(rows,block(rows,0,FIT_END)):
            if ok:
                reference[(side,r["symbol"],r["decision"],r["setup_start"])] = r
    grid = np.load(CACHE/"minutes.npy",mmap_mode="r")
    examples.FUNDING = read_json(CACHE/"funding.json.gz")
    rng = np.random.default_rng(20261122)
    sampled = 0
    crossed_hours = 0
    compared = defaultdict(list)
    for sym,path in partition_inputs().items():
        packs = joblib.load(path)
        minute = grid[SYMBOLS.index(sym)]
        rates = rates_for(sym)
        for side,p in packs.items():
            mask = np.isfinite(p["y"])
            ids = np.flatnonzero(mask)
            assert len(set(zip(p["decision"],p["setup_start"]))) == len(p["decision"])
            for j in rng.choice(ids,min(64,len(ids)),replace=False):
                enter,end = int(p["decision"][j])+55000,int(p["end"][j])
                assert 0 < end-enter <= DAY and (end-enter)%BAR==0
                hours = list(funding_hours(enter,end))
                settlement = sum(minute[(h-START)//MINUTE,0]*rates[h] for h in hours)
                a,b = [minute[(t-START)//MINUTE,0] for t in (enter,end)]
                result = trade_costs(a,b,SIGN[side],settlement)["net"]*100
                assert np.isclose(result,p["y"][j],rtol=1e-8,atol=1e-7),(sym,result,p["y"][j])
                sampled += 1
                crossed_hours += bool(hours)
            for j in ids:
                r = reference.get((side,sym,p["decision"][j],p["setup_start"][j]))
                if r is not None:
                    compared[side].append((p["end"][j]==r["end"],p["y"][j]-r["net_bps"]))
    expected = {iso(t)[:10] for t in range(BEGIN,FIT_END,DAY)}
    for arm in ARMS:
        for side in ("long","short"):
            assert not ZERO_VARIANCE.intersection(model["models"][arm][side]["columns"])
            daily = lock["audit"][side]["arms"][arm]["daily_rows"]
            assert set(daily)==(expected if arm=="continuous" else set(lock["original_days"]))
            assert min(daily.values())>=1
    assert sampled>1000 and crossed_hours>100
    overlap = {}
    for s,vals in compared.items():
        same,delta = np.array(vals).T
        overlap[s] = dict(rows=len(vals),same_exit_fraction=float(same.mean()),
                          median_absolute_net_bps_difference=float(np.median(np.abs(delta))))
    save_json(HERE/"verification.json",dict(model_sha256=file_hash(MODEL_PATH),label_samples=sampled,
             samples_crossing_funding=crossed_hours,original_overlap=overlap,source_hashes_verified=len(lock["source_hashes"]),
             continuous_days_on_each_side=len(expected)))
    print("Verified",sampled,"sampled cash flows and",len(expected),"consecutive fitting dates for each side.")


if __name__=="__main__":
    main()
