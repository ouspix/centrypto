"""Independent gradient check and exact reconstruction of implicated networks."""
from diagnose import *
from network import Network
from sklearn.metrics import average_precision_score
import copy

def gradient_check():
    rng=np.random.default_rng(981);cfg={**CFG['network'],'hidden':[5,3]};net=Network(4,cfg,481)
    net.params=[p.astype('f8') for p in net.params];x=rng.normal(size=(17,4));y=rng.integers(0,2,17).astype('f8')
    loss,grads=net.gradient(x,y)
    def independent_loss():
        a=x
        for i in range(0,len(net.params)-2,2):a=np.tanh(a.dot(net.params[i])+net.params[i+1])
        z=(a.dot(net.params[-2])+net.params[-1]).ravel()
        return float(np.mean(np.logaddexp(0,z)-y*z)+cfg['l2']*sum(np.square(net.params[i]).sum() for i in range(0,len(net.params),2)))
    assert abs(loss-independent_loss())<1e-12;errors=[]
    for j,p in enumerate(net.params):
        for index in np.ndindex(p.shape):
            old=p[index];eps=1e-5;p[index]=old+eps;up=independent_loss();p[index]=old-eps;down=independent_loss();p[index]=old
            errors.append(abs((up-down)/(2*eps)-grads[j][index]))
    assert max(errors)<1e-8,max(errors)
    return {'coordinates':len(errors),'max_absolute_error':max(errors),'independent_loss_agrees':True}

def reproduce(task):
    seed,kind=task;fold='2026-06-01T00:00:00Z';side='long';old=model(fold,seed,side,kind)
    folder=CACHE/'prepared'/fold[:10]/side/kind
    x=np.load(folder/'train-x.npy',mmap_mode='r');y=np.load(folder/'train-y.npy',mmap_mode='r')
    vx=np.load(folder/'val-x.npy',mmap_mode='r');vy=np.load(folder/'val-y.npy',mmap_mode='r')
    effective=seed+(1 if kind=='exit' else 0);net=Network(x.shape[1],CFG['network'],effective);best=None;quality=-np.inf;curves=[];selected=None
    def callback(step,network,info):
        nonlocal best,quality,selected
        ap=float(average_precision_score(vy,network.predict(vx)));curves.append({'updates':step,'validation_ap':ap,**info})
        if ap>quality+1e-12:quality=ap;selected=step;best=copy.deepcopy(network)
    with threadpool_limits(limits=1):net.fit(x,y,callback)
    assert selected==old['updates'] and curves==old['curve'],(seed,kind,selected,old['updates'])
    for a,b in zip(best.params,old['model'].params):assert np.array_equal(a,b),(seed,kind,'weight difference')
    result={'seed':seed,'kind':kind,'side':side,'fold':fold,'selected_updates':selected,'exact_weights_and_curves_match':True}
    write(OUT_CACHE/'training-checks'/f'{seed}-{kind}.json',result);return result

def main():
    gradient=gradient_check();tasks=list(itertools.product(SEEDS[:2],['entry','exit']))
    with concurrent.futures.ProcessPoolExecutor(max_workers=4,mp_context=multiprocessing.get_context('spawn')) as pool:
        repetitions=list(pool.map(reproduce,tasks))
    write(OUT/'training-checks.json',{'status':'passed','gradient':gradient,'retrained_networks':repetitions,
        'seed_controls':'Network uses one seeded RNG for initial weights and balanced minibatch draws. Prepared train/validation datasets and scaler are identical across seeds.',
        'scope':'All parameter derivatives on a small two-layer network; exact full-budget retraining of June long entry/exit for the profitable seed and one losing seed.'})
    print(json.dumps({'status':'passed','gradient':gradient,'exact_retrained_networks':len(repetitions)}),flush=True)
if __name__=='__main__':main()
