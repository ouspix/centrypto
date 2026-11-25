"""A shared neural policy for entry payoff and continuous TP/SL."""
import numpy as np
from scipy.special import expit, softmax

VALUE_UNIT = 100.
REWARD_UNIT = 4.
GATE_TEMPERATURE = .25
SMOOTHING = .19
VALUE_WEIGHT = 1.
WEIGHT_DECAY = .0002
HIDDEN = (48, 24)


def grid(values):
    logs = np.log(np.asarray(values,dtype=np.float32))
    return (logs-logs[0])/(logs[-1]-logs[0])


def forward(x,params):
    w1,b1,w2,b2,w3,b3=params
    a=np.tanh(x@w1+b1)
    b=np.tanh(a@w2+b2)
    return a,b,b@w3+b3


def kernel(location, knots):
    p=softmax(-(location[:,None]-knots)**2/(2*SMOOTHING**2),axis=1)
    derivative=p*(knots-(p@knots)[:,None])/SMOOTHING**2
    return p,derivative


def objective(logits, dollars, payoff_bps, w, targets, stops, hurdle, frozen_target=None):
    """Return surrogate loss and output derivatives. The value label is detached."""
    u=expit(logits[:,1:])
    p,dp=kernel(u[:,0],targets)
    q,dq=kernel(u[:,1],stops)
    expected=np.einsum("bi,bij,bj->b",p,dollars,q)/REWARD_UNIT
    estimate=logits[:,0]
    enter=expit((estimate-hurdle/VALUE_UNIT)/GATE_TEMPERATURE)
    bracket_weight=.25+.75*enter
    outcome=(np.einsum("bi,bij,bj->b",p,payoff_bps,q)/VALUE_UNIT
             if frozen_target is None else frozen_target)
    error=estimate-outcome
    magnitude=abs(error)
    aux=np.where(magnitude<=1.,.5*error**2,magnitude-.5)
    gradient=np.empty_like(logits)
    gradient[:,0]=-.75*enter*(1-enter)*expected/GATE_TEMPERATURE+VALUE_WEIGHT*np.clip(error,-1,1)
    gradient[:,1]=-bracket_weight*np.einsum("bi,bij,bj->b",dp,dollars,q)/REWARD_UNIT
    gradient[:,2]=-bracket_weight*np.einsum("bi,bij,bj->b",p,dollars,dq)/REWARD_UNIT
    gradient[:,1:]*=u*(1-u)
    w=w/w.sum()
    return float(np.dot(w,-bracket_weight*expected+VALUE_WEIGHT*aux)),gradient*w[:,None],outcome


def fit(x, dollars, bps, w, targets, stops, hurdle, epochs=12, learning_rate=.002,
        initial=None, base_width=None):
    rng=np.random.default_rng(92)
    sizes=(x.shape[1],*HIDDEN,3)
    if initial is None:
        params=[]
        for n,m in zip(sizes,sizes[1:]):
            limit=np.sqrt(6./(n+m))
            params.extend([rng.uniform(-limit,limit,(n,m)).astype("f4"),np.zeros(m,dtype="f4")])
        if base_width is not None:
            params[0][base_width:]=0.
        params[-2]*=.25
    else:
        params=[v.copy() for v in initial]
    mean=[np.zeros_like(v) for v in params]
    variance=[np.zeros_like(v) for v in params]
    step=0
    history=[]
    for _ in range(epochs):
        loss=[]
        for ix in np.array_split(rng.permutation(len(x)),max(1,(len(x)+1023)//1024)):
            local=x[ix]
            a,b,y=forward(local,params)
            value,delta,_=objective(y,dollars[ix],bps[ix],w[ix],targets,stops,hurdle)
            dz2=(delta@params[4].T)*(1-b*b)
            dz1=(dz2@params[2].T)*(1-a*a)
            gradient=[local.T@dz1,dz1.sum(0),a.T@dz2,dz2.sum(0),b.T@delta,delta.sum(0)]
            step+=1
            for k,(param,grad) in enumerate(zip(params,gradient)):
                if k%2==0:
                    grad+=WEIGHT_DECAY*param
                mean[k]*=.9
                mean[k]+=.1*grad
                variance[k]*=.999
                variance[k]+=.001*grad*grad
                correction=(mean[k]/(1-.9**step))/(np.sqrt(variance[k]/(1-.999**step))+1e-8)
                param-=learning_rate*correction
            loss.append(value)
        history.append(float(np.mean(loss)))
    assert np.isfinite(history).all()
    return params,history


def predict(x, params, targets, stops):
    _,_,y=forward(x,params)
    levels=expit(y[:,1:].astype("f8"))
    low=np.log([targets[0],stops[0]])
    high=np.log([targets[-1],stops[-1]])
    widths=np.exp(low+(high-low)*levels)
    assert np.isfinite(widths).all()
    return y[:,0].astype("f8")*VALUE_UNIT,widths
