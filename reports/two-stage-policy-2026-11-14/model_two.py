import copy
from scipy.special import expit
from threadpoolctl import threadpool_limits
from dataset_two import *
class BinaryNetwork:
    def __init__(self,dim,seed):
        self.rng=np.random.default_rng(seed);self.params=[]
        widths=[dim,*SPEC['network']['hidden'],1]
        for a,b in zip(widths[:-1],widths[1:]):self.params.extend([self.rng.normal(0,np.sqrt(2/(a+b)),(a,b)).astype('f4'),np.zeros(b,'f4')])
    def predict(self,x,cache=False):
        a=[x]
        for j in range(0,len(self.params)-2,2):a.append(np.tanh(a[-1]@self.params[j]+self.params[j+1]))
        p=expit(a[-1]@self.params[-2]+self.params[-1]).ravel();return (p,a) if cache else p
    def gradient(self,x,y):
        p,a=self.predict(x,True);delta=(p-y)[:,None]/len(y);grad=[None]*len(self.params);l2=SPEC['network']['l2'];loss=float(-np.mean(y*np.log(np.maximum(p,1e-8))+(1-y)*np.log(np.maximum(1-p,1e-8))))
        for layer in range(len(self.params)//2-1,-1,-1):
            j=2*layer;w=self.params[j];grad[j]=a[layer].T@delta+2*l2*w;grad[j+1]=delta.sum(axis=0);loss+=float(l2*np.sum(w*w))
            if layer:delta=(delta@w.T)*(1-a[layer]**2)
        return loss,grad
    def fit(self,x,y,callback):
        positive=np.flatnonzero(y==1);negative=np.flatnonzero(y==0);assert len(positive) and len(negative);cfg=SPEC['network'];m=[np.zeros_like(p) for p in self.params];v=[np.zeros_like(p) for p in self.params];callback(0,self,{})
        losses=[]
        for step in range(1,cfg['updates']+1):
            half=cfg['batch']//2;idx=np.r_[self.rng.choice(positive,half),self.rng.choice(negative,half)];loss,g=self.gradient(x[idx],y[idx]);norm=np.sqrt(sum(np.sum(z*z) for z in g));scale=min(1.,5/max(norm,1e-12))
            for j,(p,grad) in enumerate(zip(self.params,g)):
                grad=grad*scale;m[j]=.9*m[j]+.1*grad;v[j]=.999*v[j]+.001*grad*grad;p-=cfg['learning_rate']*(m[j]/(1-.9**step))/(np.sqrt(v[j]/(1-.999**step))+1e-8)
            losses.append(loss)
            if step in cfg['checkpoints']:callback(step,self,{'balanced_training_bce':float(np.mean(losses[-100:])),'gradient_norm':float(norm)})
        return self
def predict(model,pre,x):
    out=np.empty(len(x))
    for i in range(0,len(x),4096):out[i:i+4096]=model.predict(pre.transform(x[i:i+4096]))
    return out
