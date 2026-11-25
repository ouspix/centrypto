"""Independently reconcile historical decisions, news timing, ledger economics and controls."""
from collections import Counter
import csv
import gzip
import json
import joblib
import numpy as np

from allocation import key, replay
from challenger_replay import forecasts,diagnose,ARMS,SEEDS
from fit import matrix, MODEL, LOCK
from inputs import HERE,CACHE,ROOT,prior,DAY,HOUR,MINUTE,load,iso,file_hash,save_json,load_tape
from story_archive import parsed_time

def news_samples():
    rng=np.random.default_rng(20261122)
    samples=[]
    for stage in ("train","history","benchmark"):
        for side in prior.SIDES:
            p=matrix(stage,side)
            for i in rng.choice(len(p["at"]),40,replace=False):
                at,sym=p["at"][i],p["assets"][i]
                cols=["processed_asset_4h","asset_articles","fresh_asset_30m","asset_recency","asset_domains"]
                samples.append((at,sym,[p["x"][i,p["columns"].index(c)] for c in cols]))
    active={sym:[] for _,sym,_ in samples}
    with gzip.open(CACHE/"stories.jsonl.gz","rt") as fp:
        for line in fp:
            row=json.loads(line)
            ready,expiry=map(parsed_time,(row["available_utc"],row["expiry_utc"]))
            source=[parsed_time(row[k]) for k in ("batch_utc","archive_last_modified_utc","publication_utc") if row[k]]
            assert ready==max(source)+15*MINUTE
            for sym in set(row["asset_symbols"]) & active.keys():
                active[sym].append((ready,expiry,row["domain"]))
    for at,sym,actual in samples:
        found=[r for r in active[sym] if at-4*HOUR<=r[0]<=at<r[1]]
        latest=max((r[0] for r in found),default=None)
        expected=[bool(found),np.log1p(len(found)),any(at-r[0]<=30*MINUTE for r in found),
                  1-(at-latest)/(4*HOUR) if found else 0,np.log1p(len({r[2] for r in found}))]
        np.testing.assert_allclose(expected,actual)
    return len(samples)

def verify():
    lock=load(LOCK)
    for p,digest in lock["inputs"].items():
        assert file_hash(ROOT/p)==digest,p
    assert file_hash(MODEL)==lock["model_sha256"]
    bundle=joblib.load(MODEL)
    for arm in ARMS[1:]:
        for side,h in bundle[arm].items():
            s=lock["training"][side][arm]
            assert np.isclose(h["ridge"].alpha/s["weight"],500/lock["training"][side]["market218"]["rows"])
            assert np.isfinite(h["ridge"].coef_).all() and np.isfinite(h["scaler"].scale_).all()
    result=load(HERE/"benchmark.json")
    prev=load(prior.HERE/"benchmark.json")
    for mode in ("observed","stress"):
        for arm,ref in (("market218","ridge_218"),("constant","constant_by_side")):
            ours=result["nov17"][mode]["all"]["arms"][arm]
            theirs=prev["modes"][mode]["arms"][ref]
            assert list(map(key,ours["ledger"]))==list(map(key,theirs["ledger"]))
            for a,b in zip(ours["ledger"],theirs["ledger"],strict=True):
                for k in ("decision","entry","end","paid","sold","net","fees","funding","score"):
                    np.testing.assert_allclose(a[k],b[k],rtol=1e-10,atol=1e-10)
    checks=0
    for windows in result.values():
        for modes in windows.values():
            for pop in modes.values():
                for arm in pop["arms"].values():
                    if "ledger" not in arm:
                        continue
                    ledger=arm["ledger"]
                    assert len(set(map(key,ledger)))==len(ledger)
                    net=0.
                    for r in ledger:
                        if r["status"]!="priced":
                            break
                        actual=(1 if r["side"]=="long" else -1)*r["qty"]*(r["sold"]-r["paid"])-r["fees"]-r["funding"]
                        np.testing.assert_allclose(actual,r["net"],atol=1e-10)
                        net+=actual
                    else:
                        np.testing.assert_allclose(net,arm["metrics"]["net"],atol=1e-8)
                        checks+=1
    old=load(prior.HERE.with_name("entry-score-audit")/"benchmark-audit.json")["frozen"]["arms"]["constant_by_side"]["ledger"]
    new=result["nov17"]["observed"]["all"]["arms"]["constant"]["ledger"]
    def compact(r):
        return dict(side=r["side"],symbol=r["symbol"],id=r["id"],decision=iso(r["decision"]),
                    entry=iso(r["entry"]),end=iso(r["end"]),net=r["net"],score=r["score"])
    first=next((a,b) for a,b in zip(old,new) if (key(a),a["end"],a["net"])!=(key(b),b["end"],b["net"]))
    old_ids,new_ids=set(map(key,old)),set(map(key,new))
    first_unique=min([("original",r) for r in old if key(r) not in new_ids]+[("corrected",r) for r in new if key(r) not in old_ids],
        key=lambda x:x[1]["decision"])
    spec=load(prior.HERE.with_name("entry-score-audit")/"original-calibration.json")
    save_json(HERE/"constant-reconciliation.json",dict(original=dict(exits="original exit feature inputs",
        constants=spec["constant"],net=sum(r["net"] for r in old),trades=len(old)),
        corrected=dict(exits="stable one-return variance inputs, same exit weights",constants=lock["constant"],
        net=sum(r["net"] for r in new),trades=len(new)),shared_ids=len(old_ids&new_ids),
        first_trade_term_divergence=list(map(compact,first)),
        first_exclusive_decision=dict(ledger=first_unique[0],trade=compact(first_unique[1]))))
    signals,raw,covered=forecasts("history",bundle)
    tape,evidence=load_tape("history")
    rows=[r for rs in prior.priced(tape,evidence,"observed").values() for r in rs
          if r["setup_start"]>=prior.CALIBRATE and r["decision"]<prior.SELECT]
    calibration={}
    for arm in ARMS:
        trades,_,info=replay(rows,signals[arm],prior.SELECT+DAY)
        calibration[arm]=diagnose(rows,arm,signals[arm],raw[arm],info["contested_candidates"],set(map(key,trades)))
    save_json(HERE/"calibration-diagnostics.json",calibration)
    from features import REGEX
    assert REGEX["listing"].search("Coinbase lists XYZ token") and REGEX["listing"].search("XYZ listed on Kraken")
    assert not REGEX["listing"].search("Malaysia adds Hyperliquid to its investor-alert list")
    assert not REGEX["listing"].search("A list of risks for Bitcoin")
    cases=news_samples()
    frozen=load(prior.HERE.with_name("capped-entry-value")/"forward-runtime-lock.json")
    for path,digest in frozen["files"].items():
        assert file_hash(ROOT/path)==digest
    save_json(HERE/"verification.json",dict(past_only_join_samples=cases,features_checked_per_sample=5,
        prior_controls_reproduced_in_both_modes=True,after_cost_ledgers_checked=checks,
        forward_runtime_files_verified=len(frozen["files"]),input_locks_verified=True,
        results_sha256=file_hash(HERE/"benchmark.json"),journal_sha256=file_hash(CACHE/"allocation-journal.csv.gz")))

if __name__=="__main__":
    verify()
