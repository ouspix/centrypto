from four_common import *
from detectors import crossings,active_setups
from data_four import FourData
from network import Network
from engine import replay,exit_predictions
def main():
    rng=np.random.default_rng(9);p=100+np.sin(np.arange(500)/13)*8;changed=p.copy();changed[300:]+=20
    a=crossings(p,CFG['pairs']);b=crossings(changed,CFG['pairs']);mirror=crossings(200-p,CFG['pairs'])
    for pair in a:
        for side in ['long','short']:assert np.array_equal(a[pair][side][:300],b[pair][side][:300])
        assert np.array_equal(a[pair]['long'],mirror[pair]['short']);assert np.array_equal(a[pair]['short'],mirror[pair]['long'])
    for t in range(90,200):
        for setup in active_setups(p[:t],CFG['pairs'],12):
            assert 0<=setup['age_bars']<=12 and setup['detected_bar']==t-1-setup['age_bars']
    x=rng.normal(size=(19,7)).astype('f4');y=rng.integers(0,2,19).astype('f4');net=Network(7,CFG['network'],5);loss,grad=net.gradient(x,y);errors=[]
    for j,param in enumerate(net.params):
        for flat in [0,param.size//2,param.size-1]:
            index=np.unravel_index(flat,param.shape);old=param[index].copy();eps=.001
            param[index]=old+eps;up=net.gradient(x,y)[0];param[index]=old-eps;down=net.gradient(x,y)[0];param[index]=old
            error=abs((up-down)/(2*eps)-grad[j][index]);errors.append(float(error));assert error<2e-4
    data=FourData();assert not any('news' in n or 'entry_score' in n for n in data.exit_names)
    ids=np.flatnonzero(np.isfinite(data.c['label']));sample=rng.choice(ids,80,replace=False)
    for cid in sample:
        c=data.c[cid];setup=data.setups[c['setup']];row=int(c['row']);sign=int(c['side']);series=data.d.catalog[int(setup['series'])]
        assert int(setup['detect'])<=row<=int(setup['last']) and int(c['age'])<=12
        price=data.d.state['price'][row];future=data.d.state['price'][row+1:row+H+1]
        gain=float(np.nanmax(sign*(future/price-1)*100));assert np.isclose(gain,c['gain'],atol=1e-10)
        expected=gain>=10 and gain>=.95*float(setup['best_gain']);assert bool(c['label'])==expected
        rr=row+12;features=data.exit_rows(np.array([row]),np.array([rr]),sign)[0]
        assert np.isclose(features[data.exit_names.index('trade_return_pct')],sign*(data.d.state['close'][rr]/price-1)*100,equal_nan=True)
    # Test timing independently of learned weights, for both signs.
    class Identity:
        def transform(self,x):return x
    class Fixed:
        def __init__(self,value):self.value=value
        def predict(self,x):return np.full(len(x),self.value)
    for side in [1,-1]:
        candidate=data.c[sample[data.c['side'][sample]==side][0]];entry=int(candidate['row'])
        for value in [0,1]:
            out=exit_predictions(data,{'preprocess':Identity(),'model':Fixed(value)},[entry],side,[.5])
            if value==0:assert out['steps'][0,0]==H
            else:assert 1<=out['steps'][0,0]<=H
            assert out['time'][0,0]<=data.d.state['time'][entry]+55000+1440*MIN
    save('preflight-validation.json',{'status':'passed','causal_sma_and_mirrored_directions':True,'gradient_coordinates':len(errors),'maximum_gradient_error':max(errors),
        'independent_target_and_direction_checks':len(sample),'news_excluded_from_exit':True,'holding_deadline_checks':4,'original_files_verified':verify_original()})
    print(json.dumps({'preflight':'passed','target_checks':len(sample)}),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
