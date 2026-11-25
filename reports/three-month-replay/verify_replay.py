"""Verify the chronological split, modeled cashflows, and unchanged prospective bundle."""
from collections import Counter,defaultdict
import csv
import gzip
import json
import joblib
import numpy as np

from config import CACHE,HERE,ROOT,REPORTS,START,CAL_START,TEST_START,TEST_STOP,MARK_STOP,MINUTE,DAY,ROLES,FEE,SYMBOLS
from config import load,save_json,file_hash,iso

def verify():
    inputs=load(HERE/"candles.json")
    funding=load(HERE/"funding.json")
    news=load(HERE/"news-inputs.json")
    fit=load(HERE/"entry-training.json")
    exits=load(HERE/"exit-training.json")
    result=load(HERE/"results.json")
    assert file_hash(CACHE/"minutes.npy")==inputs["grid_sha256"]
    assert file_hash(CACHE/"funding.joblib")==funding["funding_sha256"]
    assert file_hash(CACHE/"stories.jsonl.gz")==news["article_sha256"]
    assert file_hash(HERE/"exit-models.joblib")==fit["exit_models_sha256"]==exits["models_sha256"]==result["exit_sha256"]
    assert file_hash(HERE/"entry-models.joblib")==fit["entry_models_sha256"]==result["entry_sha256"]
    assert result["candidate_dates"]==(TEST_STOP//DAY-TEST_START//DAY+1)
    by_stage=Counter()
    priced=Counter()
    latest=defaultdict(int)
    for path in (CACHE/"targets").glob("*.joblib"):
        part=joblib.load(path)
        for side in ROLES:
            for stage,pack in part["sides"][side].items():
                boundary={"train":CAL_START,"cal":TEST_START,"test":MARK_STOP}[stage]
                at=pack["decision"]
                outcome=pack["end"][pack["end"]>=0]*MINUTE+START
                assert np.all(outcome<boundary)
                assert np.all(at<boundary)
                if stage=="test":
                    assert np.all((at>=TEST_START)&(at<TEST_STOP))
                priced[side,stage]+=int(np.isfinite(pack["y"]).sum())
                by_stage[side,stage]+=len(at)
                if len(outcome):
                    latest[stage]=max(latest[stage],int(outcome.max()))
    for side,f in fit["roles"].items():
        assert priced[side,"train"]==f["training"]["priced"]
        assert priced[side,"cal"]==f["calibration"]["priced"]
        assert by_stage[side,"test"]==result["decisions_by_side"][side]
    candles=np.load(CACHE/"minutes.npy",mmap_mode="r")
    asset_idx={s:i for i,s in enumerate(SYMBOLS)}
    verified_trade_count=0
    by_policy=defaultdict(list)
    with gzip.open(HERE/"trade-ledgers.jsonl.gz","rt") as fp:
        for line in fp:
            r=json.loads(line)
            assert TEST_START<=r["decision"]<TEST_STOP and r["score"]>15
            assert r["decision"]<r["entry"]<r["end"]<=MARK_STOP
            if r["status"]=="priced":
                sign=ROLES[r["side"]][0]
                j=asset_idx[r["symbol"]]
                i,k=((r[x]-START)//MINUTE for x in ("entry","end"))
                slip=.0003 if r["execution"]=="stress" else .0001
                assert r["paid"]==candles[j,i,0]*(1+sign*slip)
                assert r["sold"]==candles[j,k,0]*(1-sign*slip)
                assert all(r["entry"]<t<=r["end"] for t,_,_ in r["funding_flows"])
                pn=sign*r["qty"]*(r["sold"]-r["paid"])-FEE*r["qty"]*(r["sold"]+r["paid"])
                pn+=sum(flow for _,flow,_ in r["funding_flows"])
                np.testing.assert_allclose(pn,r["net"],rtol=1e-11,atol=1e-10)
                verified_trade_count+=1
            by_policy[r["execution"],r["policy"]].append(r)
    ledger_count=0
    for (mode,policy),rows in by_policy.items():
        metrics=result["modes"][mode][policy]
        assert len(rows)==metrics["trades"]
        seen=set()
        held={}
        for r in rows:
            at=r["decision"]
            held={s:t for s,t in held.items() if at<=t}
            pair=(r["side"],r["setup"])
            assert r["symbol"] not in held and pair not in seen and len(held)<10
            held[r["symbol"]]=r["end"]
            seen.add(pair)
        if metrics["net"] is not None:
            np.testing.assert_allclose(metrics["net"],sum(r["net"] for r in rows),rtol=1e-10,atol=1e-8)
            ledger_count+=1
    with (HERE/"daily-equity.csv").open() as fp:
        day_rows=defaultdict(list)
        for r in csv.DictReader(fp):
            if r["marked_net_change_usd"]:
                day_rows[r["execution"],r["policy"]].append(float(r["marked_net_change_usd"]))
    for (mode,policy),items in day_rows.items():
        net=result["modes"][mode][policy]["net"]
        if net is not None:
            np.testing.assert_allclose(sum(items),net,atol=1e-8)
    forward=load(REPORTS/"capped-entry-value/forward-runtime-lock.json")["files"]
    for path,digest in forward.items():
        assert file_hash(ROOT/path)==digest,path
    manifests=[HERE/n for n in ("protocol.json","candles.json","funding.json","news-inputs.json",
        "exit-training.json","entry-training.json","results.json","trade-ledgers.jsonl.gz","daily-equity.csv")]
    manifests+=list(HERE.glob("*.py"))
    save_json(HERE/"verification.json",dict(train_calibration_holdout_separation=True,
        latest_base_outcome={s:iso(t) for s,t in sorted(latest.items())},priced_trades_reconciled=verified_trade_count,
        complete_ledgers_reconciled=ledger_count,forward_runtime_files_verified=len(forward),
        manifests={p.name:file_hash(p) for p in manifests}))
    print("Independently checked",verified_trade_count,"priced trades,",ledger_count,"complete ledgers")

if __name__=="__main__":
    verify()
