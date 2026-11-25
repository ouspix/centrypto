import joblib,urllib.parse
from engine import *
from inference import ResearchPolicy
def main():
    data=FourData();rows=list(csv.DictReader((HERE/'predictions.csv').open()));checks=collections.Counter();source={};models={};last={};used={};setups_used=set();rng=np.random.default_rng(88)
    assert lock()==json.loads((HERE/'experiment-lock.json').read_text())['files']
    for r in sorted(rows,key=lambda r:r['entry_time']):
        cid=int(r['candidate_id']);c=data.c[cid];e=int(c['row']);side=int(c['side']);s=data.d.catalog[int(data.d.state['series'][e])]
        entry,exit=ms(r['entry_time']),ms(r['exit_time']);scored=r['scored']=='True';symbol=r['symbol'];fold=r['fold'];step=int(r['exit_step'])
        assert (fold,int(c['setup'])) not in setups_used;setups_used.add((fold,int(c['setup'])))
        assert entry-55000>last.get((fold,symbol),-1);last[(fold,symbol)]=exit
        assert 5<=float(r['holding_minutes'])<=1440 and int(data.setups[c['setup']]['time'])<=entry-55000
        if s['key'] not in source:source[s['key']]={int(v[0]):v for v in gz(BASE_CACHE/'candles'/s['period']/(urllib.parse.quote(symbol,safe='')+'.json.gz'))['rows']}
        native=source[s['key']]
        if scored:
            actual=side*100*(float(native[exit][1])/float(native[entry][1])-1)
            assert np.isclose(actual,float(r['return_pct']),atol=1e-9),(symbol,actual,r['return_pct'])
            checks['independent_native_candle_payoffs']+=1
        else:assert step==H and not np.isfinite(data.d.state['terminal_price'][e])
        if fold not in models:
            audit=json.loads((HERE/(fold[:10]+'-audit.json')).read_text());path=CACHE/'fits'/fold[:10]
            policy=ResearchPolicy.__new__(ResearchPolicy)
            policy.config={'pairs':CFG['pairs'],'entry_window_minutes':60,'holding_limit_minutes':1440,'sides':audit['policies']}
            policy.models={name:{kind:joblib.load(path/(name+'_'+kind+'.joblib')) for kind in ['entry','exit']} for name in ['long','short']};models[fold]=policy
        policy=models[fold]
        encoded=np.array([e*2+(side==-1)]);raw=data.d.entry_rows(encoded)[0,:-1];features=dict(zip(data.d.entry_names[:-1],raw))
        with np.load(BASE_CACHE/'bars'/(s['key']+'.npz')) as bars:close=bars['close'][:e-s['offset']+1]
        times=(ms(s['start'])+(np.arange(len(close))+1)*BAR).tolist()
        key=(fold,symbol);seen=used.setdefault(key,[])
        result=policy.decide_entry(close,times,features,eligible=True,used_events=seen)
        assert result['action']=='enter' and result['side']==r['side'],(r,result)
        assert result['setup']['pair_id']==int(c['pair']) and np.isclose(result['setup']['score'],float(r['entry_score']),atol=2e-6)
        seen.append(result['event_key']);checks['runtime_entry_reproductions']+=1
        assert policy.decide_entry(close,times,features,eligible=False)['action']=='wait'
        assert policy.decide_entry(close,times,features,eligible=True,already_open=True)['action']=='wait'
        # Runtime and replay use the same strict side-adjusted position state.
        point=e+step;exit_raw=data.exit_rows(np.array([e]),np.array([point]),side)[0];exit_features=dict(zip(data.exit_names,exit_raw))
        response=policy.exit(r['side'],exit_features,step*5)
        assert response['action']=='exit';checks['runtime_exit_reproductions']+=1
    for fold,policy in models.items():
        audit=json.loads((HERE/(fold[:10]+'-audit.json')).read_text());p=audit['plan'];train,val=data.split(ms(p['start']),ms(p['validation_start']))
        assert not(set(data.c['setup'][train])&set(data.c['setup'][val]))
        assert data.completion[train].max()<ms(p['validation_start'])-1440*MIN
        assert data.completion[val].max()<ms(p['start'])-1440*MIN;checks['purged_split_checks']+=1
        for side,name in [(1,'long'),(-1,'short')]:
            subset=[r for r in rows if r['fold']==fold and r['side']==name]
            if not subset:continue
            entries=np.array([int(r['entry_index']) for r in subset]);threshold=policy.config['sides'][name]['exit_threshold']
            result=exit_predictions(data,policy.models[name]['exit'],entries,side,[threshold])
            assert np.array_equal(result['steps'][:,0],np.array([int(r['exit_step']) for r in subset]));checks['full_exit_path_reproductions']+=len(entries)
    final=ResearchPolicy();assert len({id(final.models[s][k]['model']) for s in ['long','short'] for k in ['entry','exit']})==4
    for p in json.loads((HERE/'fold-plan.json').read_text()):
        train,val=data.split(ms(p['start']),ms(p['validation_start']))
        assert not(set(data.c['setup'][train])&set(data.c['setup'][val]))
        assert data.completion[train].max()<ms(p['validation_start'])-1440*MIN
        assert data.completion[val].max()<ms(p['start'])-1440*MIN
    checks['all_outer_fold_split_checks']=4
    for side in ['long','short']:
        assert final.models[side]['entry']['side']==side and final.models[side]['exit']['side']==side
        assert not any('news' in name for name in final.models[side]['exit']['input_names'])
        assert final.exit(side,{},1440)['action']=='exit'
    # Labels and hindsight gains must not enter either model's feature vectors.
    sample=rng.choice(np.arange(len(data.c)),40,replace=False);before=data.entry_rows(sample);original=data.c
    changed=np.array(data.c);changed['label']=1-changed['label'];changed['gain']=123456.;data.c=changed
    assert np.allclose(before,data.entry_rows(sample),equal_nan=True);data.c=original
    # Example current inputs and output are a serialization demonstration, not another test result.
    clean=lambda value:float(value) if np.isfinite(value) else None
    save('example-entry-input.json',{'symbol':rows[-1]['symbol'],'feature_values':{k:clean(v) for k,v in features.items()},'closed_prices':[clean(v) for v in close[-100:]],'closed_times':times[-100:],
      'eligible':True,'note':'Example schema only; never treat historical feature values as live inputs.'})
    example=json.loads((HERE/'example-entry-input.json').read_text())
    output=final.decide_entry(example['closed_prices'],example['closed_times'],example['feature_values'],eligible=example['eligible'])
    save('example-entry-output.json',output);checks['final_serialized_entry_example']=1
    save('validation.json',{'status':'passed','checks':dict(checks),'four_distinct_final_models':True,'target_mutation_cannot_change_inputs':True,
      'exit_has_no_news':True,'all_holding_periods_at_most_24h':True,'experiment_lock_verified':True,'original_files_verified':verify_original()})
    print(json.dumps({'validation':'passed','checks':dict(checks)}),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
