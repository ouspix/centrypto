"""Fit normalized ridge objectives without consuming evaluation payoffs."""
from datetime import datetime,timezone
import csv
import sys
import joblib
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

from inputs import HERE,CACHE,ROOT,prior,DAY,load,save_json,dump,file_hash,iso
from features import AVAIL,CONTENT
from diagnostics import coefficients

ARMS=load(HERE/"protocol.json")["arms"]
MODEL=HERE/"models.joblib"
LOCK=HERE/"research-lock.json"

def centered(x,at):
    _,inv,n=np.unique(at,return_inverse=True,return_counts=True)
    if x.ndim==1:
        return x-(np.bincount(inv,weights=x)/n)[inv]
    means=np.zeros((len(n),x.shape[1]))
    np.add.at(means,inv,x)
    return x-(means/n[:,None])[inv]

def matrix(stage,side):
    path=CACHE/(stage+"-"+side+".joblib")
    assert file_hash(path)==load(HERE/"matrices.json")[stage][side]["file_sha256"]
    return joblib.load(path)

def predict(head,p):
    cols=[p["columns"].index(k) for k in head["columns"]]
    z=head["scaler"].transform(head["imputer"].transform(p["x"][:,cols]))
    raw=head["ridge"].predict(z)
    if head["relative"]:
        return centered(raw,p["at"])
    return raw

def weight_rows(arm,side,p,indices,w):
    dates=(p["at"][indices]//DAY).astype("datetime64[D]").astype("datetime64[M]").astype(str)
    symbols=p["assets"][indices]
    keys,inv,n=np.unique(np.char.add(np.char.add(dates,"/"),symbols),return_inverse=True,return_counts=True)
    masses=np.bincount(inv,weights=w)
    for key,count,mass in zip(keys,n,masses,strict=True):
        month,asset=key.split("/")
        yield [arm,side,month,asset,int(count),float(mass)]

def fit():
    if LOCK.exists():
        raise FileExistsError(LOCK)
    bundle={arm:{} for arm in ARMS}
    stats={}
    with (HERE/"training-weights.csv").open("w",newline="") as fp:
        writer=csv.writer(fp)
        writer.writerow(["arm","side","month","asset","decisions","total_weight"])
        for side in prior.SIDES:
            p,cal=matrix("train",side),matrix("history",side)
            ok=np.isfinite(cal["y"])
            yc=cal["y"][ok]
            constant=float(yc.mean())
            assert np.isclose(constant,prior.load(prior.LOCK)["constant_bps"][side])
            bundle["constant"][side]=constant
            n218=int((p["at"]>=prior.SPLIT).sum())
            norm=500./n218
            market=len(p["columns"])-len(AVAIL)-len(CONTENT)
            # Relative groups exclude any missing payoff and must offer at least two different assets.
            at=p["at"]
            order=np.lexsort((p["assets"],at))
            same_time=at[order][1:]==at[order][:-1]
            different_asset=p["assets"][order][1:]!=p["assets"][order][:-1]
            multi=np.isin(at,at[order][1:][same_time & different_asset]) & p["complete"]
            stats[side]={}
            for arm in ARMS[1:]:
                rel=arm=="relative_content"
                use=multi if rel else at>=prior.SPLIT if arm.endswith("218") else np.ones(len(at),bool)
                idx=np.flatnonzero(use)
                t=at[idx]
                weights=np.ones(len(idx))
                if arm.endswith("decay"):
                    weights=np.exp2(-(prior.FIT_END-t)/(90.*DAY))
                if rel:
                    _,inv,counts=np.unique(t,return_counts=True,return_inverse=True)
                    weights=1./counts[inv]
                stop=market if arm.startswith("market") else market+len(AVAIL) if arm.startswith("availability") else len(p["columns"])
                imp=SimpleImputer(strategy="median",add_indicator=True)
                z=imp.fit_transform(p["x"][idx,:stop])
                scaler=StandardScaler().fit(z,sample_weight=weights)
                z=scaler.transform(z)
                target=p["y"][idx]
                if rel:
                    z=centered(z,t)
                    target=centered(target,t)
                alpha=norm*weights.sum()
                fit=Ridge(alpha=alpha,fit_intercept=not rel).fit(z,target,sample_weight=weights)
                del z
                head=dict(imputer=imp,scaler=scaler,ridge=fit,columns=p["columns"][:stop],relative=rel)
                bundle[arm][side]=head
                summary=dict(rows=len(t),weight=float(weights.sum()),alpha=float(alpha),normalized_penalty=norm,
                             dates=len(np.unique(t//DAY)),groups=len(np.unique(t)),assets=len(np.unique(p["assets"][idx])))
                if not rel:
                    co=coefficients(predict(head,cal)[ok],yc)
                    head.update(slope=co["slope"],intercept=co["intercept"])
                    summary["calibration"]=co
                writer.writerows(weight_rows(arm,side,p,idx,weights))
                stats[side][arm]=summary
                print(side,arm,len(t),round(float(alpha),3),flush=True)
    dump(MODEL,bundle)
    paths=[HERE/n for n in ("protocol.json","inputs.py","features.py","matrices.py","fit.py","news-inputs.json","matrices.json","training-weights.csv","extractor-revision.json")]
    paths.extend([prior.LOCK, prior.OLD_LOCK,prior.BUNDLE,prior.HERE.with_name("entry-score-audit")/"prospective.json",
                  prior.HERE.with_name("capped-entry-value")/"forward-runtime-lock.json"])
    save_json(LOCK,dict(created=datetime.now(timezone.utc).isoformat(),model_sha256=file_hash(MODEL),
        inputs={str(p.relative_to(ROOT)):file_hash(p) for p in paths},training=stats,
        constant=bundle["constant"],hurdle=15,slots=10,calibration=load(HERE/"matrices.json")["history"]))

if __name__=="__main__":
    fit()
