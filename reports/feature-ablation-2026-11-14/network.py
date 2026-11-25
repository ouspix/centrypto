import copy
import numpy as np
from scipy.special import expit
from sklearn.metrics import average_precision_score
class Network:
    def __init__(self,dim,config,seed):
        self.config=copy.deepcopy(config);self.rng=np.random.default_rng(seed);self.params=[]
        widths=[dim,*config['hidden'],1]
        for a,b in zip(widths[:-1],widths[1:]):self.params.extend([self.rng.normal(0,np.sqrt(2/(a+b)),(a,b)).astype('f4'),np.zeros(b,'f4')])
    def predict(self,x,cache=False):
        a=[x]
        for j in range(0,len(self.params)-2,2):a.append(np.tanh(a[-1]@self.params[j]+self.params[j+1]))
        p=expit(a[-1]@self.params[-2]+self.params[-1]).ravel();return (p,a) if cache else p
    def gradient(self,x,y):
        p,a=self.predict(x,True);delta=(p-y)[:,None]/len(y);grad=[None]*len(self.params);l2=self.config['l2']
        loss=float(-np.mean(y*np.log(np.maximum(p,1e-8))+(1-y)*np.log(np.maximum(1-p,1e-8))))
        for layer in range(len(self.params)//2-1,-1,-1):
            j=2*layer;w=self.params[j];grad[j]=a[layer].T@delta+2*l2*w;grad[j+1]=delta.sum(axis=0);loss+=float(l2*np.sum(w*w))
            if layer:delta=(delta@w.T)*(1-a[layer]**2)
        return loss,grad
    def fit(self,x,y,callback):
        groups=[np.flatnonzero(y==label) for label in [0,1]];assert all(len(g) for g in groups)
        m=[np.zeros_like(p) for p in self.params];v=[np.zeros_like(p) for p in self.params];losses=[]
        for step in range(1,self.config['updates']+1):
            ix=np.concatenate([self.rng.choice(g,self.config['batch']//2) for g in groups]);loss,grad=self.gradient(x[ix],y[ix]);losses.append(loss)
            norm=np.sqrt(sum(np.sum(g*g) for g in grad));scale=min(1.,5/max(norm,1e-12))
            for j,(p,g) in enumerate(zip(self.params,grad)):
                g=g*scale;m[j]=.9*m[j]+.1*g;v[j]=.999*v[j]+.001*g*g
                p-=self.config['learning_rate']*(m[j]/(1-.9**step))/(np.sqrt(v[j]/(1-.999**step))+1e-8)
            if step in self.config['checkpoints']:callback(step,self,{'balanced_bce':float(np.mean(losses[-100:]))})
        return self
def predict(artifact,raw):
    out=np.empty(len(raw))
    for i in range(0,len(raw),4096):out[i:i+4096]=artifact['model'].predict(artifact['preprocess'].transform(raw[i:i+4096]))
    return out
def fit_binary(raw,y,vraw,vy,names,config,seed,metadata):
    from four_common import Preprocess
    pre=Preprocess().fit(raw,names);x=pre.transform(raw);vx=pre.transform(vraw);model=Network(x.shape[1],config,seed)
    best=None;quality=-np.inf;curve=[]
    def callback(step,net,info):
        nonlocal best,quality
        p=net.predict(vx);ap=float(average_precision_score(vy,p));curve.append({'updates':step,**info,'validation_ap':ap})
        if ap>quality+1e-12:
            quality=ap;best={'model':copy.deepcopy(net),'preprocess':pre,'input_names':list(names),'updates':step,**metadata}
    model.fit(x,y,callback)
    audit={'training_rows':len(y),'training_positives':int(y.sum()),'validation_rows':len(vy),'validation_positives':int(vy.sum()),
        'dimensions':x.shape[1],'parameters':sum(p.size for p in model.params),'retained_features':pre.names,'selected_updates':best['updates'],'curve':curve}
    return best,audit
