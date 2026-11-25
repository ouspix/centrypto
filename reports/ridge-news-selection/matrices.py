"""Build one point-in-time enriched record per original decision, preserving row order."""
from collections import Counter
import sys

import joblib
import numpy as np

from features import News, AVAIL, CONTENT
from inputs import HERE, CACHE, ROOT, DAY, MINUTE, prior, iso, file_hash, load, load_tape, dump, save_json

def train_rows(side,columns):
    sources=load(prior.LOCK)["input_hashes"]
    xs,ys,times,assets=[],[],[],[]
    rejected=Counter()
    for stage,paths in prior.examples_paths().items():
        for sym,path in paths.items():
            assert file_hash(path)==sources[str(path.relative_to(ROOT))]
            r=joblib.load(path)[side]
            ok=r["status"]=="priced"
            assert np.array_equal(ok,np.isfinite(r["y"]))
            assert np.all(r["end"][ok]<prior.MATURITY)
            rejected.update(r["decision"][~ok].tolist())
            if ok.any():
                xs.append(r["x"][ok][:,[r["names"].index(k) for k in columns]])
                ys.append(r["y"][ok])
                times.append(r["decision"][ok])
                assets.extend([sym]*int(ok.sum()))
    at=np.concatenate(times)
    return dict(x=np.concatenate(xs),y=np.concatenate(ys),at=at,assets=np.asarray(assets),
                complete=~np.isin(at,list(rejected)),unpriced_decisions=sum(rejected.values()))

def trace(pack,rows,columns,stage):
    if stage=="history":
        mask=np.array([r["setup_start"]>=prior.CALIBRATE and r["decision"]<prior.SELECT for r in rows])
    else:
        mask=np.ones(len(rows),bool)
    sub=[r for r,ok in zip(rows,mask,strict=True) if ok]
    if stage=="history":
        assert all(r["entry"]+DAY<prior.ms("2026-11-13T00:00:00Z") and r["end"]<=r["entry"]+DAY for r in sub)
    return dict(x=pack["x"][mask][:,[pack["names"].index(k) for k in columns]], at=np.array([r["decision"] for r in sub]),
                assets=np.array([r["symbol"] for r in sub]),ids=np.array([r["id"] for r in sub]),
                y=np.array([r["net_bps"] if r.get("net_bps") is not None else np.nan for r in sub]),
                status=[r["status"] for r in sub],last_end=iso(max(r["end"] for r in sub)))

def build():
    news=News(audit=True)
    old,_=prior.previous_model()
    stages={}
    for stage in ("history","development","benchmark"):
        tape,evidence=load_tape(stage)
        rr=prior.priced(tape,evidence,"observed")
        stages[stage]={s:trace(pack,rr[s],old[s]["columns"],stage) for s,pack in tape["sides"].items()}
    audit={}
    for side in prior.SIDES:
        cols=old[side]["columns"]
        stages["train"]={side:train_rows(side,cols)}
        for stage,data in stages.items():
            pack=data[side]
            news_x=news.join(pack["at"],pack["assets"],pack["x"],cols)
            pack["x"]=np.column_stack((pack["x"],news_x)).astype("f8")
            pack["columns"]=cols+AVAIL+CONTENT
            path=CACHE/(stage+"-"+side+".joblib")
            dump(path,pack)
            audit.setdefault(stage,{})[side]=dict(rows=len(news_x),priced=int(np.isfinite(pack["y"]).sum()),
                direct4h=int(news_x[:,3].sum()),recent_feed=int(news_x[:,0].sum()),file_sha256=file_hash(path),
                latest_end=pack.get("last_end"),excluded_training_rows=pack.get("unpriced_decisions"),
                statuses=dict(Counter(pack.get("status",[]))))
            print(stage,side,audit[stage][side],flush=True)
        del stages["train"]
    assert sum(x["rows"] for x in audit["train"].values())==326546
    assert sum(x["direct4h"] for x in audit["train"].values())==189914
    assert sum(x["rows"] for x in audit["benchmark"].values())==5211
    save_json(HERE/"matrices.json",audit)

if __name__=="__main__":
    build()
