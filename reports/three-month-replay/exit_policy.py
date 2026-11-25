"""Train and apply causal per-side exit classifiers on pre-holdout trajectories."""
from concurrent.futures import ProcessPoolExecutor
import joblib
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from config import CACHE,HERE,START,MINUTE,HOUR,DAY,HOLD,ROLES,FEE,BASE_SLIP,CAL_START
from config import dump,save_json,iso,file_hash
from market_features import EXIT_COLUMNS,MARKET_COLUMNS
from source_data import GRID,FUNDING

PATH=HERE/"exit-models.joblib"
TRAIN_STEPS=np.array([1,3,6,12,18,24,36,48,72,96,144,192,240,287])
ALL_STEPS=np.arange(1,HOLD+1)
MAX_FILL_DELAY=3
BATCH=256

class Prices:
    def __init__(self,opens,funding):
        self.opens=opens
        self.n=len(opens)
        indices=np.arange(self.n,dtype="i8")
        valid=np.isfinite(opens)&(opens>0)
        self.next=np.minimum.accumulate(np.where(valid,indices,self.n)[::-1])[::-1]
        self.previous=np.maximum.accumulate(np.where(valid,indices,-1))
        self.hour_minutes=HOUR//MINUTE
        hours=np.arange(0,self.n,self.hour_minutes)
        at=self.previous[hours]
        valid=(at>=0)&(hours-at<=5)
        rates=np.array([funding.get(START+t*MINUTE,np.nan) for t in hours])
        self.valuations=np.where(valid,opens[at],np.nan)
        self.hour_flows=self.valuations*rates
        self.flow=np.cumsum(np.r_[0.,np.nan_to_num(self.hour_flows)])
        self.missing=np.cumsum(np.r_[0,~np.isfinite(self.hour_flows)])

    def executable(self,plan):
        candidate=self.next[np.minimum(plan,self.n-1)]
        return np.where((candidate>=plan)&(candidate<=plan+MAX_FILL_DELAY)&(candidate<self.n),candidate,-1)

    def payoff(self,entry,end,sign,slip):
        first=self.opens[entry]
        last=np.where(end>=0,self.opens[end],np.nan)
        buy=first*(1+sign*slip)
        sell=last*(1-sign*slip)
        quantity=100/buy
        a=entry//self.hour_minutes+1
        b=np.maximum(end,0)//self.hour_minutes+1
        funding=sign*quantity*(self.flow[b]-self.flow[a])
        net=sign*quantity*(sell-buy)-FEE*quantity*(buy+sell)-funding
        return np.where((self.missing[a]==self.missing[b])&(end>entry),net,np.nan)

def states(pack,slots,entry,first,sign):
    # Keep a running peak and trough using past closes since the trade was filled.
    close=pack["close"][slots]
    ret=sign*(close/first[:,None]-1)
    scan=np.column_stack([np.zeros(len(ret)),ret])
    peak=np.fmax.accumulate(scan,axis=1)[:,1:]
    trough=np.fmin.accumulate(scan,axis=1)[:,1:]
    elapsed=(slots-entry[:,None])/HOLD
    return np.stack([100*ret,100*peak,100*trough,100*(peak-ret),elapsed],axis=2)

def samples(pack,prices,side):
    sign=ROLES[side][0]
    p=pack["candidates"][side]["train"]
    _,positions=np.unique(p["setup"],return_index=True)
    pos=np.sort(positions)
    pos=pos[np.isfinite(prices.opens[p["minute"][pos]])]
    data,labels,dates=[],[],[]
    for chunk in range(0,len(pos),BATCH):
        ii=pos[chunk:chunk+BATCH]
        at,ent=p["row"][ii],p["minute"][ii]
        rows=at[:,None]+ALL_STEPS
        target=prices.executable(ent[:,None]+5*ALL_STEPS)
        pnl=prices.payoff(ent[:,None],target,sign,BASE_SLIP)
        # A missing settlement makes the hindsight optimum unknowable.
        full_tail=(prices.executable(ent+5*HOLD)>=0)&np.isfinite(pnl[:,-1])
        train=full_tail & np.isfinite(pnl).any(1)
        if not train.any():
            continue
        best=np.argmax(np.where(np.isfinite(pnl[train]),pnl[train],-np.inf),axis=1)+1
        z=states(pack,rows[train],at[train],prices.opens[ent[train]],sign)[:,TRAIN_STEPS-1]
        idx=rows[train][:,TRAIN_STEPS-1]
        valid=np.isfinite(z[:,:,0])&(target[train][:,TRAIN_STEPS-1]>=0)
        y=TRAIN_STEPS>=best[:,None]
        x=np.concatenate((pack["features"][idx],z),axis=2)
        data.append(x[valid].astype("f4"))
        labels.append(y[valid])
        dates.extend([int(t) for t in p["decision"][ii[train]][valid.any(1)]])
    if not data:
        return None
    return np.concatenate(data),np.concatenate(labels),np.array(dates,dtype="i8")

def exit_points(pack,prices,side,stage,head):
    sign=ROLES[side][0]
    p=pack["candidates"][side][stage]
    ent=p["minute"]
    first=prices.opens[ent]
    stop=np.full(len(ent),-1,dtype="i8")
    col=len(MARKET_COLUMNS)
    coeff=head["coefficient"]
    x=np.where(np.isfinite(pack["features"]),pack["features"],head["median"][:col])
    static=x@coeff[:col]+head["intercept"]
    valid=np.flatnonzero(np.isfinite(first))
    for chunk in range(0,len(valid),BATCH):
        i=valid[chunk:chunk+BATCH]
        rows=p["row"][i,None]+ALL_STEPS
        target=prices.executable(ent[i,None]+5*ALL_STEPS)
        z=states(pack,rows,p["row"][i],first[i],sign)
        score=static[rows]+np.einsum("ijk,k->ij",np.where(np.isfinite(z),z,head["median"][col:]),coeff[col:])
        hit=(score>=0)&np.isfinite(z[:,:,0])&(target>=0)
        hit[:,-1]=target[:,-1]>=0
        pick=np.argmax(hit,axis=1)
        stop[i]=np.where(hit.any(1),target[np.arange(len(i)),pick],-1)
    return stop

def initialize():
    global RAW,RATES
    RAW=np.load(GRID,mmap_mode="r")
    RATES=joblib.load(FUNDING)

def symbol_data(path):
    from config import SYMBOLS
    pack=joblib.load(path)
    sym=pack["symbol"]
    return pack,Prices(RAW[SYMBOLS.index(sym),:,0],RATES[sym])

def one(path):
    pack,px=symbol_data(path)
    return pack["symbol"],{side:samples(pack,px,side) for side in ROLES}

def fit_exits():
    initialize()
    fits,audit={},{}
    parts={s:[] for s in ROLES}
    paths=sorted((CACHE/"market").glob("*.joblib"))
    with ProcessPoolExecutor(max_workers=5) as pool:
        for i,(symbol,part) in enumerate(pool.map(one,paths,chunksize=1),1):
            for s,z in part.items():
                if z is not None:
                    parts[s].append(z)
            if i%20==0:
                print("Exit training partitions",i,"/",len(paths),flush=True)
    for side,uu in parts.items():
        x,y,t=(np.concatenate(v) for v in zip(*uu,strict=True))
        assert max(t)+DAY+5*MINUTE<CAL_START and 0<y.sum()<len(y)
        imp=SimpleImputer(strategy="median",keep_empty_features=True)
        z=imp.fit_transform(x)
        scaler=StandardScaler()
        z=scaler.fit_transform(z)
        model=LogisticRegression(C=1.,max_iter=300,tol=1e-6).fit(z,y)
        coef=model.coef_[0]/scaler.scale_
        fits[side]=dict(columns=EXIT_COLUMNS,coefficient=coef,median=imp.statistics_,
                        intercept=float(model.intercept_[0]-scaler.mean_@coef))
        np.testing.assert_array_equal(model.predict(z[:1000]),(imp.transform(x[:1000])@coef+fits[side]["intercept"]>=0))
        audit[side]=dict(states=len(y),positions=len(t),decision_days=len(np.unique(t//DAY)),assets=len(uu),
                         first=iso(min(t)),last=iso(max(t)),exit_labels=int(y.sum()),features=len(EXIT_COLUMNS))
        print(side,audit[side],flush=True)
    dump(PATH,fits)
    save_json(HERE/"exit-training.json",dict(models_sha256=file_hash(PATH),roles=audit,exit_probability=.5))

if __name__=="__main__":
    fit_exits()
