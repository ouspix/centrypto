"""Build one target per opportunity and fit separate entry heads for longs and shorts."""
from concurrent.futures import ProcessPoolExecutor
from unittest.mock import patch
import argparse
import csv
import joblib
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

from config import CACHE,HERE,START,DAY,MINUTE,CAL_START,TEST_START,MARK_STOP,FIT_STOP,ROLES
from config import BASE_SLIP,load,dump,save_json,iso,file_hash
from market_features import ENTRY_COLUMNS
from exit_policy import PATH,initialize,symbol_data,exit_points
from diagnostics import coefficients
from fit import centered
import features

MODEL=HERE/"entry-models.joblib"
ARMS={
    "market":("market",False,False),
    "availability":("availability",False,False),
    "news":("news",False,False),
    "market_90d":("market",True,False),
    "news_90d":("news",True,False),
    "relative_news":("news",False,True),
}

def build_targets():
    global EXIT_HEADS
    initialize()
    assert file_hash(PATH)==load(HERE/"exit-training.json")["models_sha256"]
    EXIT_HEADS=joblib.load(PATH)
    paths=sorted((CACHE/"market").glob("*.joblib"))
    (CACHE/"targets").mkdir(exist_ok=True)
    with ProcessPoolExecutor(max_workers=5) as pool:
        for i,(sym,n) in enumerate(pool.map(targets,paths),1):
            if i%25==0:
                print("Exit labels and plans",i,"/",len(paths),flush=True)

def targets(path):
    pack,px=symbol_data(path)
    sets={}
    for side,(sign,_,_) in ROLES.items():
        sets[side]={}
        for stage,p in pack["candidates"][side].items():
            end=exit_points(pack,px,side,stage,EXIT_HEADS[side])
            endtime=np.where(end>=0,START+end*MINUTE,-1)
            # The execution outcomes must mature before their next chronological block.
            stop={"train":CAL_START,"cal":TEST_START,"test":MARK_STOP}[stage]
            assert np.all(endtime[end>=0]<stop)
            y=px.payoff(p["minute"],end,sign,BASE_SLIP)*100.
            x=np.column_stack([pack["features"][p["row"]],(p["row"]-p["setup"])/12.])
            sets[side][stage]=dict(p,x=x,end=end,y=y)
    dump(CACHE/"targets"/path.name,dict(symbol=pack["symbol"],sides=sets))
    return pack["symbol"],len(sets)

def training_data(side,stage,news):
    if stage not in ("train","cal"):
        raise ValueError("Fitting may read only history before holdout")
    xs,ys,ats,syms=[],[],[],[]
    for path in sorted((CACHE/"targets").glob("*.joblib")):
        q=joblib.load(path)
        symbol=q["symbol"]
        p=q["sides"][side][stage]
        y=p["y"]
        at=p["decision"]
        if not len(y):
            continue
        x=p["x"]
        z=news.join(at,np.full(len(y),symbol),x,ENTRY_COLUMNS)
        xs.append(np.column_stack((x,z)))
        ys.append(y)
        ats.append(at)
        syms.extend([symbol]*len(y))
    return dict(x=np.concatenate(xs),y=np.concatenate(ys),at=np.concatenate(ats),symbols=np.asarray(syms))

def joiner():
    with patch.object(features,"CACHE",CACHE),patch.object(features,"HERE",HERE):
        return features.News()

def fit():
    news=joiner()
    out,stats,baseline={},{},{}
    with (HERE/"fit-weights.csv").open("w",newline="") as fp:
        writer=csv.writer(fp)
        writer.writerow(["side","policy","utc_month","priced_rows","weight"])
        for side in ROLES:
            p,q=(training_data(side,stage,news) for stage in ("train","cal"))
            ok=np.isfinite(p["y"])
            cq=np.isfinite(q["y"])
            y=p["y"]
            at=p["at"]
            assert max(at)<FIT_STOP and max(q["at"])<TEST_START
            baseline[side]=float(q["y"][cq].mean())
            _,inv,counts=np.unique(at,return_inverse=True,return_counts=True)
            missing=np.bincount(inv,weights=~ok)>0
            lex=np.lexsort((p["symbols"],at))
            nonidentical=(at[lex][1:]==at[lex][:-1])&(p["symbols"][lex][1:]!=p["symbols"][lex][:-1])
            mixed=np.unique(at[lex][1:][nonidentical])
            complete=(~missing[inv])&np.isin(at,mixed)
            month=(at//DAY).astype("datetime64[D]").astype("datetime64[M]").astype(str)
            norm=500./({"long":138532,"short":78264}[side])
            audit=dict(training=dict(eligible=len(y),priced=int(ok.sum()),dates=len(np.unique(at[ok]//DAY)),
                       first=iso(at[ok].min()),last=iso(at[ok].max()),assets=len(np.unique(p["symbols"][ok])),
                       news_4h=int(p["x"][ok,len(ENTRY_COLUMNS)+3].sum()),
                       recent_archive=int(p["x"][ok,len(ENTRY_COLUMNS)].sum())),
                       calibration=dict(eligible=len(cq),priced=int(cq.sum()),unresolved=int((~cq).sum()),
                       first=iso(min(q["at"])),last=iso(max(q["at"])),mean_payoff_bps=baseline[side]))
            out[side]={}
            for arm,(group,decay,relative) in ARMS.items():
                mask=ok&complete if relative else ok
                times=at[mask]
                w=np.exp2(-(FIT_STOP-times)/(90*DAY)) if decay else np.ones(len(times))
                if relative:
                    w=1./counts[inv[mask]]
                cols=len(ENTRY_COLUMNS)+{"market":0,"availability":len(features.AVAIL),
                                         "news":len(features.AVAIL)+len(features.CONTENT)}[group]
                prep=SimpleImputer(strategy="median",add_indicator=True,keep_empty_features=True)
                v=prep.fit_transform(p["x"][mask,:cols])
                sc=StandardScaler().fit(v,sample_weight=w)
                v=sc.transform(v)
                target=y[mask]
                if relative:
                    v=centered(v,times)
                    target=centered(target,times)
                alpha=float(norm*w.sum())
                reg=Ridge(alpha=alpha,fit_intercept=not relative).fit(v,target,sample_weight=w)
                h=dict(imputer=prep,scaler=sc,ridge=reg,columns=cols,relative=relative)
                info=dict(rows=len(times),weight=float(w.sum()),alpha=alpha,normalized_penalty=norm)
                if not relative:
                    result=coefficients(predict(h,q["x"][cq]),q["y"][cq])
                    info["calibration"]=result
                    h.update(slope=result["slope"],intercept=result["intercept"])
                out[side][arm]=h
                audit[arm]=info
                for m in np.unique(month[mask]):
                    chosen=month[mask]==m
                    writer.writerow([side,arm,m,int(chosen.sum()),float(w[chosen].sum())])
            stats[side]=audit
            print(side,audit["training"],audit["calibration"],flush=True)
    dump(MODEL,dict(heads=out,constant=baseline))
    save_json(HERE/"entry-training.json",dict(entry_models_sha256=file_hash(MODEL),exit_models_sha256=file_hash(PATH),roles=stats,
        constant_bps=baseline,columns=ENTRY_COLUMNS+features.AVAIL+features.CONTENT))

def predict(h,x):
    return h["ridge"].predict(h["scaler"].transform(h["imputer"].transform(x[:,:h["columns"]])))

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("stage",choices=("targets","fit"))
    {"targets":build_targets,"fit":fit}[p.parse_args().stage]()
