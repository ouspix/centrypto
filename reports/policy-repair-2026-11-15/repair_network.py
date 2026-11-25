import copy, warnings
import numpy as np
from scipy.special import expit
from sklearn.metrics import average_precision_score, roc_auc_score
from repair_common import CFG
from network import Network

class QualityPreprocess:
    def fit(self, raw, names, core):
        self.input_names=list(names); self.core=list(core)
        observed=np.isfinite(raw).mean(axis=0)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',RuntimeWarning); spread=np.nanstd(raw,axis=0)
        core_ids=[names.index(n) for n in core]
        assert np.isfinite(raw[:,core_ids]).all(), 'Mandatory inputs must not be imputed'
        self.columns=np.flatnonzero((observed>=CFG['minimum_optional_training_coverage'])&(spread>1e-10))
        self.names=[names[i] for i in self.columns]
        v=raw[:,self.columns]; self.median=np.nanmedian(v,axis=0)
        filled=np.where(np.isfinite(v),v,self.median); self.mean=filled.mean(axis=0); self.scale=np.maximum(filled.std(axis=0),1e-8)
        self.coverage={n:float(p) for n,p in zip(names,observed)}
        self.dropped={n:('coverage_below_80pct' if observed[i]<CFG['minimum_optional_training_coverage'] else 'constant') for i,n in enumerate(names) if i not in self.columns}
        return self
    def transform(self, raw):
        v=raw[:,self.columns]; missing=~np.isfinite(v)
        values=np.clip((np.where(missing,self.median,v)-self.mean)/self.scale,-8,8)
        # Every retained feature has an indicator, including newly missing live values.
        return np.column_stack([values,missing]).astype('f4')
    def valid(self, raw):
        return np.isfinite(raw[:,[self.input_names.index(n) for n in self.core]]).all(axis=1)

class WeightedNetwork(Network):
    def fit_weighted(self,x,y,weights,callback):
        groups=[np.flatnonzero(y==label) for label in [0,1]]
        assert min(map(len,groups))>0
        probs=[weights[g]/weights[g].sum() for g in groups]
        m=[np.zeros_like(p) for p in self.params];v=[np.zeros_like(p) for p in self.params];losses=[]
        for step in range(1,self.config['updates']+1):
            ix=np.concatenate([self.rng.choice(g,self.config['batch']//2,p=p) for g,p in zip(groups,probs)])
            loss,grad=self.gradient(x[ix],y[ix]); losses.append(loss)
            norm=np.sqrt(sum(np.sum(g*g) for g in grad));scale=min(1.,5/max(norm,1e-12))
            for j,(p,g) in enumerate(zip(self.params,grad)):
                g=g*scale;m[j]=.9*m[j]+.1*g;v[j]=.999*v[j]+.001*g*g
                p-=self.config['learning_rate']*(m[j]/(1-.9**step))/(np.sqrt(v[j]/(1-.999**step))+1e-8)
            if step in self.config['checkpoints']:callback(step,self,{'balanced_bce':float(np.mean(losses[-100:]))})

def predict(artifact,raw,entry_rank=True):
    if 'members' in artifact:
        return np.mean([predict(m,raw,entry_rank) for m in artifact['members']],axis=0)
    values=np.empty(len(raw))
    for i in range(0,len(raw),4096): values[i:i+4096]=artifact['model'].predict(artifact['preprocess'].transform(raw[i:i+4096]))
    if artifact['kind']=='entry' and entry_rank:
        ref=artifact['rank_reference']; values=np.searchsorted(ref,values,side='right')/len(ref)
    return values

def fit(raw,y,vraw,vy,names,core,groups,reference_rows,seed,kind,side):
    pre=QualityPreprocess().fit(raw,names,core); x=pre.transform(raw);vx=pre.transform(vraw)
    # Equal total sampling weight per symbol/day and class, not per duplicate SMA row.
    keys=np.array([str(g)+'/'+str(int(label)) for g,label in zip(groups,y)])
    _,inverse,counts=np.unique(keys,return_inverse=True,return_counts=True); weights=1/counts[inverse]
    net=WeightedNetwork(x.shape[1],CFG['network'],seed);curve=[]
    def callback(step,model,info):
        p=model.predict(vx)
        curve.append({'updates':step,**info,'validation_ap':float(average_precision_score(vy,p)) if vy.sum() else None,'validation_auc':float(roc_auc_score(vy,p)) if len(np.unique(vy))==2 else None})
    net.fit_weighted(x,y,weights,callback)
    reference=np.sort(net.predict(x[reference_rows])) if kind=='entry' else None
    artifact={'model':net,'preprocess':pre,'input_names':names,'kind':kind,'side':side,'seed':seed,'rank_reference':reference,'curve':curve,'research_only':True,'selected_updates':CFG['network']['updates']}
    audit={'side':side,'kind':kind,'seed':seed,'training_rows':len(y),'positive':int(y.sum()),'validation_rows':len(vy),'validation_positive':int(vy.sum()),'retained_features':pre.names,'dropped_features':pre.dropped,'coverage':pre.coverage,'curve':curve,'selection':'fixed final checkpoint; validation metrics diagnostic only'}
    return artifact,audit
