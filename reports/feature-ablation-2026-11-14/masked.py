"""Optional groups remove values AND missingness signals, with paired initialization."""
import copy,hashlib,os,pathlib
import numpy as np
import joblib
from sklearn.metrics import average_precision_score
from network import Network
from schema import group_for
from four_common import CFG
class MaskedPreprocess:
    def __init__(self,base,active,kind):
        self.base=base;self.kind=kind;self.active_groups=['mandatory']+list(active)
        self.value_mask=np.array([group_for(n,kind) in self.active_groups for n in base.names],dtype='f4')
        self.mask=np.r_[self.value_mask,self.value_mask[base.indicators]].astype('f4')
        self.names=base.names;self.input_names=base.input_names
        self.active_names=[n for n,on in zip(base.names,self.value_mask) if on]
    def transform(self,x):return self.base.transform(x)*self.mask
def cache_key(mask):return hashlib.sha256(mask.tobytes()).hexdigest()[:16]
def fit_cached(folder,prepared,active,kind,side,seed):
    base=joblib.load(prepared/'preprocess.joblib');pre=MaskedPreprocess(base,active,kind);key=cache_key(pre.mask)
    path=folder/f'{kind}_{side}_{seed}_{key}.joblib'
    if path.exists():return joblib.load(path)
    x=np.load(prepared/'train-x.npy',mmap_mode='r');y=np.load(prepared/'train-y.npy',mmap_mode='r')
    vx=np.load(prepared/'val-x.npy',mmap_mode='r');vy=np.load(prepared/'val-y.npy',mmap_mode='r')
    # Copy only the masked matrices, keeping immutable full matrices shared on disk.
    x=np.asarray(x)*pre.mask;vx=np.asarray(vx)*pre.mask
    net=Network(x.shape[1],CFG['network'],seed);best=None;quality=-np.inf;curve=[]
    def checkpoint(step,model,info):
        nonlocal best,quality
        score=model.predict(vx);ap=float(average_precision_score(vy,score));curve.append({'updates':step,'validation_ap':ap,**info})
        if ap>quality+1e-12:quality=ap;best=copy.deepcopy(model);selected=step;checkpoint.selected=selected
    net.fit(x,y,checkpoint)
    artifact={'model':best,'preprocess':pre,'input_names':base.input_names,'updates':checkpoint.selected,'kind':kind,'side':side,'news_allowed':False,
        'active_names':pre.active_names,'active_transformed_dimensions':int(pre.mask.sum()),'fixed_transformed_dimensions':len(pre.mask),
        'seed':seed,'curve':curve,'mask_key':key,'research_only':True}
    tmp=path.with_suffix(f'.{os.getpid()}.tmp');joblib.dump(artifact,tmp,compress=3);os.replace(tmp,path)
    return artifact
