"""Run the separately registered challenger comparison on the released future tape."""
from datetime import date,datetime,timezone,timedelta
from unittest.mock import patch
import csv
import gzip
import sys

import joblib
import numpy as np

import features
from inputs import (HERE,ROOT,CACHE,prior,UNIVERSE,AssetIndex,ingest,story_archive,ms,DAY,BAR,load,save_json,file_hash,
                    StableExitInputs,fixed_exits,BUNDLE)
from features import AVAIL,CONTENT
from matrices import trace
from fit import LOCK,MODEL,ARMS
from challenger_replay import forecasts,evaluate_window,seed_priority,SEEDS,key
from fresh_market import FreshReplay,status
from decisions import SIDES

DECLARATION=HERE/"challenger-registration.json"
FROZEN=HERE.with_name("capped-entry-value")
SHADOW=CACHE/"forward"

def register():
    if DECLARATION.exists():
        raise FileExistsError(DECLARATION)
    window=load(FROZEN/"research-lock.json")["shadow"]
    now=datetime.now(timezone.utc).isoformat()
    assert ms(now)<ms(window["test_start"])
    files=[LOCK,MODEL,HERE/"protocol.json",FROZEN/"forward-runtime-lock.json"]
    files+=list(HERE.glob("*.py"))
    files.extend(HERE.with_name("gdelt-news-backfill")/k for k in ("ingest.py","story_archive.py","assets.py"))
    files.extend(HERE.with_name("entry-score-audit")/k for k in ("accounting.py","diagnostics.py"))
    files.extend([HERE.with_name("continuous-entry-value")/"stable_exits.py",FROZEN/"benchmark.py",
                  FROZEN/"portfolio.py",FROZEN/"decisions.py",FROZEN/"forecast.py"])
    save_json(DECLARATION,dict(registered_utc=now,window=window,benchmark="constant",arms=ARMS,seeds=SEEDS,
        primary_contrast=["content357","availability357"],secondary_contrasts=[["content_decay","content357"],
        ["relative_content","content357"],["content357","content218"]],execution=["observed","stress"],
        scope="Secondary research on the shared upcoming opportunities with corrected exits. Compare within this protocol.",
        inputs={str(p.relative_to(ROOT)):file_hash(p) for p in files}))

def forward_news(window):
    historical=load(HERE/"news-inputs.json")
    old=sorted(date.fromisoformat(s) for s in historical["days"])
    new=list(ingest.span(old[-1]+timedelta(days=1),date.fromisoformat(window["test_entry_end"][:10])-timedelta(days=1)))
    for d in old:
        assert file_hash(ingest.day_path(d))==historical["days"][d.isoformat()]["sha256"]
    ingest.collect(new,32,2)
    with patch.object(story_archive,"fetch_minutes",return_value=old+new):
        db,inventory,batches,broken=story_archive.build_index(AssetIndex(UNIVERSE),False)
    assert not broken
    with patch.object(story_archive,"CACHE",SHADOW):
        path,*_=story_archive.recover(db,"")
    db.close()
    np.save(SHADOW/"batches.npy",batches)
    save_json(SHADOW/"news-inputs.json",dict(article_sha256=file_hash(path),batches_sha256=file_hash(SHADOW/"batches.npy"),
        days={d:inventory[d]["day_file_sha256"] for d in inventory}))
    with patch.object(features,"CACHE",SHADOW),patch.object(features,"HERE",SHADOW):
        return features.News()

def correct_exits(tape,window):
    source=FreshReplay(window)
    stable=StableExitInputs(source)
    times=source.d.state["time"]
    cats={c["key"]:c for c in source.d.catalog}
    weights=joblib.load(BUNDLE)["exits"]
    for side,sign in (("long",1),("short",-1)):
        rows=tape["sides"][side]["records"]
        indexes=[]
        for r in rows:
            c=cats[r["key"]]
            off=c["offset"]
            i=off+np.searchsorted(times[off:off+c["bars"]],r["decision"])
            assert i<off+c["bars"] and times[i]==r["decision"]
            indexes.append(i)
        if not rows:
            continue
        for idx in np.array_split(np.arange(len(rows)),(len(rows)+3999)//4000):
            entries=np.asarray(indexes)[idx]
            np.testing.assert_array_equal(fixed_exits(source,entries,sign,weights[side]),[rows[i]["step"] for i in idx])
            for i,v in zip(idx,fixed_exits(stable,entries,sign,weights[side]),strict=True):
                r=rows[i]
                r["step"]=int(v)
                r["end"]=r["entry"]+(int(v)*BAR if v else DAY)

def run():
    decl=load(DECLARATION)
    window=decl["window"]
    status(window)
    for p,digest in decl["inputs"].items():
        assert file_hash(ROOT/p)==digest,p
    release=load(FROZEN/"forward-inputs.json")
    receipt=prior.BASE/"forward-data-lock.json"
    assert file_hash(receipt)==release["data_lock_sha256"] and release["scored_window"]==window
    assert file_hash(FROZEN/"shadow-forecasts.json")==release["result_sha256"]
    for name,digest in load(receipt)["files"].items():
        assert file_hash(prior.BASE/name)==digest
    tape=joblib.load(prior.BASE/"shadow.joblib")
    evidence=joblib.load(prior.BASE/"shadow-evidence.joblib")
    assert tape["window"]==window
    SHADOW.mkdir(exist_ok=True)
    news=forward_news(window)
    correct_exits(tape,window)
    rr=prior.priced(tape,evidence,"observed")
    panels={}
    bundle=joblib.load(MODEL)
    for side in SIDES:
        cols=bundle["market357"][side]["columns"]
        if not rr[side]:
            panels[side]=dict(ids=np.array([],int),x=np.empty((0,len(cols+AVAIL+CONTENT))),columns=cols+AVAIL+CONTENT)
            continue
        p=trace(tape["sides"][side],rr[side],cols,"shadow")
        p["x"]=np.column_stack((p["x"],news.join(p["at"],p["assets"],p["x"],cols)))
        p["columns"]=cols+AVAIL+CONTENT
        panels[side]=p
    signals,raw,covered=forecasts("shadow",bundle,lambda _,side:panels[side])
    begin,stop,end=[ms(window[k]) for k in ("test_start","test_entry_end","test_market_end")]
    result={}
    for mode in ("observed","stress"):
        rows=[r for rr in prior.priced(tape,evidence,mode).values() for r in rr if begin<=r["setup_start"]<=r["decision"]<stop]
        ss=dict(signals)
        for seed in SEEDS:
            ss["tie_"+str(seed)]={key(r):(signals["constant"][key(r)][0],seed_priority(seed,r)) for r in rows}
        result[mode]={}
        for pop,rs in (("all",rows),("news",[r for r in rows if key(r) in covered])):
            result[mode][pop]=evaluate_window(rs,tape["markets"],ss,raw,covered,begin,end,None)
    save_json(HERE/"forward-results.json",dict(declaration=file_hash(DECLARATION),
        original_release=file_hash(FROZEN/"forward-inputs.json"),news=file_hash(SHADOW/"news-inputs.json"),results=result))

if __name__=="__main__":
    {"register":register,"run":run}[sys.argv[1]]()
