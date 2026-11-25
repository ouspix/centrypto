from price_common import CFG, QualityPreprocess, ENTRY_CORE
import numpy as np
from network import Network

def stopping_loss(hazard,mask,cost,skip):
    """Exact differentiable expectation of first-entry price cost, including skip."""
    hazard=np.asarray(hazard,float);mask=np.asarray(mask,bool);cost=np.asarray(cost,float)
    h=np.where(mask,hazard,0.)
    continuation=np.empty_like(h);value=np.array(skip,float)
    for t in range(h.shape[1]-1,-1,-1):
        continuation[:,t]=value
        value=h[:,t]*cost[:,t]+(1-h[:,t])*value
    survival=np.cumprod(np.column_stack([np.ones(len(h)),1-h[:,:-1]]),axis=1)
    grad=survival*(cost-continuation)*h*(1-h)*mask/len(h)
    return float(value.mean()),grad,value

class PriceNetwork(Network):
    def gradient_episodes(self,x,index,mask,cost,skip):
        flat=index.ravel();h,a=self.predict(x[flat],True)
        loss,g,_=stopping_loss(h.reshape(index.shape),mask,cost,skip)
        delta=g.reshape(-1,1).astype('f4');grads=[None]*len(self.params)
        for layer in range(len(self.params)//2-1,-1,-1):
            j=2*layer;w=self.params[j];grads[j]=a[layer].T@delta+2*self.config['l2']*w
            grads[j+1]=delta.sum(axis=0);loss+=self.config['l2']*float(np.sum(w*w))
            if layer:delta=(delta@w.T)*(1-a[layer]**2)
        return loss,grads

    def train_episodes(self,x,pack,callback):
        _,inverse,counts=np.unique(pack['groups'],return_inverse=True,return_counts=True)
        weights=1/counts[inverse]
        # Match the old class-balanced intent without binary labels/loss on entry timing.
        for label in [False,True]:
            where=pack['success']==label
            if where.any():weights[where]/=weights[where].sum()
        weights/=weights.sum()
        m=[np.zeros_like(p) for p in self.params];v=[np.zeros_like(p) for p in self.params]
        callback(0,self,{})
        for step in range(1,self.config['updates']+1):
            ix=self.rng.choice(len(pack['index']),self.config['episode_batch'],p=weights)
            loss,grads=self.gradient_episodes(x,pack['index'][ix],pack['mask'][ix],pack['cost'][ix],pack['skip'][ix])
            norm=np.sqrt(sum(np.sum(g*g) for g in grads));scale=min(1.,5/max(norm,1e-12))
            for j,(p,g) in enumerate(zip(self.params,grads)):
                g=g*scale;m[j]=.9*m[j]+.1*g;v[j]=.999*v[j]+.001*g*g
                p-=self.config['learning_rate']*(m[j]/(1-.9**step))/(np.sqrt(v[j]/(1-.999**step))+1e-8)
            if step in self.config['checkpoints']:callback(step,self,{'batch_objective_with_l2':float(loss)})

def fit(pack,validation,names,seed,side):
    pre=QualityPreprocess().fit(pack['raw'],names,ENTRY_CORE)
    x=pre.transform(pack['raw']);vx=pre.transform(validation['raw'])
    net=PriceNetwork(x.shape[1],CFG['network'],seed);curve=[]
    def metrics(model,features,data):
        h=model.predict(features)[data['index']]
        _,_,cost=stopping_loss(h,data['mask'],data['cost'],data['skip'])
        skip=np.prod(1-np.where(data['mask'],h,0),axis=1)
        result={'cost':float(cost.mean()),'entry_probability':float((1-skip).mean())}
        for yes,name in [(True,'qualifying'),(False,'failed')]:
            m=data['success']==yes
            result[name+'_cost']=float(cost[m].mean()) if m.any() else None
            result[name+'_entry_probability']=float((1-skip[m]).mean()) if m.any() else None
        return result
    def callback(step,model,info):
        curve.append({'updates':step,**info,'train':metrics(model,x,pack),'validation':metrics(model,vx,validation)})
    net.train_episodes(x,pack,callback)
    _,unique=np.unique(pack['rows'],return_index=True)
    ref=np.sort(net.predict(x[unique]))
    return {'model':net,'preprocess':pre,'input_names':list(names),'rank_reference':ref,'kind':'entry',
        'side':side,'seed':seed,'curve':curve,'selected_updates':CFG['network']['updates'],
        'objective':'expected_normalized_absolute_entry_price_error_with_abstention_costs','research_only':True}, {
        'seed':seed,'side':side,'training_episodes':len(pack['index']),'training_candidates':len(pack['raw']),
        'training_qualifying':int(pack['success'].sum()),'validation_episodes':len(validation['index']),
        'validation_qualifying':int(validation['success'].sum()),'retained_features':pre.names,
        'dropped_features':pre.dropped,'curve':curve,'checkpoint_selection':'fixed 4000 updates; no test selection'}

def predict(model,raw,rank=True):
    if 'members' in model:return np.mean([predict(m,raw,rank) for m in model['members']],axis=0)
    value=np.empty(len(raw))
    for i in range(0,len(raw),4096):value[i:i+4096]=model['model'].predict(model['preprocess'].transform(raw[i:i+4096]))
    return np.searchsorted(model['rank_reference'],value,side='right')/len(model['rank_reference']) if rank else value
