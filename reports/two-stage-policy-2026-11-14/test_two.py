"""Independent arithmetic, timing and training-target checks before fitting."""
from model_two import *
from features_two import market
from news_two import intervals,availability
from train_two import plan
def main():
    rng=np.random.default_rng(20261114);p=np.exp(rng.normal(size=80));p[[5,11,28]]=np.nan;value,index=future_best(p,12)
    for i in range(len(p)-1):
        ids=np.arange(i+1,min(len(p),i+13));ids=ids[np.isfinite(p[ids])]
        if len(ids):best=int(ids[np.argmax(p[ids])]);assert index[i]==best and value[i]==p[best]
    x=rng.normal(size=(17,8)).astype('f4');y=rng.integers(0,2,17).astype('f4');net=BinaryNetwork(8,34);loss,gradient=net.gradient(x,y);errors=[]
    for k,parameter in enumerate(net.params):
        for flat in [0,parameter.size//2,parameter.size-1]:
            ix=np.unravel_index(flat,parameter.shape);old=parameter[ix].copy();eps=.001;parameter[ix]=old+eps;up=net.gradient(x,y)[0];parameter[ix]=old-eps;down=net.gradient(x,y)[0];parameter[ix]=old;error=abs((up-down)/(2*eps)-gradient[k][ix]);errors.append(float(error));assert error<2e-4
    a=np.column_stack([np.arange(1.,601),np.arange(1.,601)+1,np.arange(1.,601)-.5,np.arange(1.,601)+.2,np.full(600,100.)]);before=market(a,'test_');later=a.copy();later[400:]*=2;after=market(later,'test_')
    for name in before:assert np.allclose(before[name][:400],after[name][:400],equal_nan=True)
    cut=np.arange(0,100,5);v=intervals(cut,[(10,30,1)]);w=intervals(cut,[(10,30,1),(50,70,2)]);assert np.array_equal(v[cut<50],w[cut<50]);assert availability({'availableAt':'2026-11-02T00:00:00Z','collectedAt':'2026-11-01T00:00:00Z','publishedAt':'2026-10-30T00:00:00Z'})==ms('2026-11-02T00:00:00Z')
    d=Data();sample=rng.choice(len(d.teachers),min(30,len(d.teachers)),replace=False);checked=0
    for k in sample:
        e=d.teachers[int(k)];c=d.catalog[e['series']];z=np.load(CACHE/'bars'/(c['key']+'.npz'));anchor=e['anchor_index']-c['offset'];entry=e['teacher_entry']-c['offset'];price=z['price'];assert 100*(z['close'][anchor]/z['close'][anchor-H]-1)>=10-1e-10;lo=max(H,anchor-H);candidates=np.arange(lo,anchor+1);candidates=candidates[z['eligible'][candidates]&np.isfinite(price[candidates])];best_return=-np.inf;best_entry=-1
        for i in candidates:
            future=np.r_[price[i+1:i+H+1],z['terminal_price'][i]];profit=100*(np.nanmax(future)/price[i]-1)
            if profit>best_return:best_return=profit;best_entry=int(i)
        assert entry==best_entry and np.isclose(best_return,e['teacher_gain_pct']);assert 0<e['teacher_exit']-e['teacher_entry']<=H;checked+=1
    assert not any('news' in n for n in d.exit_names);assert any('news' in n for n in d.entry_names);plans=[]
    source_end=np.array([ms(c['end']) for c in d.catalog]);possible=d.eligible[d.times[d.eligible]<source_end[d.state['series'][d.eligible]]-1472*MIN];assert np.all(d.state['series'][possible]==d.state['series'][possible+H])
    for period in SPEC['outer_tests']:
        f=plan(d,ms(period['start']));plans.append({'start':period['start'],'usable':f is not None,'inner_teacher_entries':len(f['inner_teacher_entries']) if f else 0,'validation_teacher_entries':len(f['validation_teacher_entries']) if f else 0})
        if f:
            it=np.array(f['inner_ids']);va=np.array(f['validation_ids']);assert d.completion[it].max()<ms(f['validation_start'])-1440*MIN;assert d.completion[va].max()<ms(period['start'])-1440*MIN;assert all(d.state['target'][e]==1 for e in f['inner_teacher_entries'])
    save('unit-validation.json',{'status':'passed','gradient_coordinates':len(errors),'maximum_gradient_error':max(errors),'future_best_matches_independent_scan':True,'future_market_mutation_preserves_past_features':True,'future_news_does_not_change_past_counts':True,'news_availability_uses_latest_of_publication_collection_availability':True,'independent_full_teacher_searches':checked,'exit_has_no_news_columns':True,'exit_training_entries_are_same_positive_entry_targets':True,'preflight_folds':plans});print((HERE/'unit-validation.json').read_text(),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
