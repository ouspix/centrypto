"""Independent payoff, split, mask, baseline and inference checks."""
import sys,joblib,urllib.parse
from engine import *
sys.path.insert(0,str(HERE))
from masked import cache_key
from schema import group_for
from analyze import load_runs
from inference import ResearchPolicy
from detectors import active_setups

def artifact(run,side,kind):
    seed=run['seed']+(10 if side=='short' else 0)+(1 if kind=='exit' else 0)
    key=run['models'][side+'_'+kind]['mask_key']
    return joblib.load(CACHE/'models'/run['fold'][:10]/f'{kind}_{side}_{seed}_{key}.joblib')

def main():
    partial='--partial' in sys.argv;runs=load_runs();checks=collections.Counter();data=FourData()
    if not partial:assert len(runs)==240
    plans=json.loads((HERE/'fold-plan.json').read_text());exp=json.loads((HERE/'experiment.json').read_text())
    expected={(v,s,p['start']) for v in exp['variants'] for s in exp['seeds'] for p in plans}
    actual={(r['variant'],r['seed'],r['fold']) for r in runs}
    assert len(actual)==len(runs) and actual<=expected
    if not partial:assert actual==expected
    assert lock()==json.loads((HERE/'experiment-lock.json').read_text())['files']
    for folder in ['two-stage-rebuild-2026-11-14','sma-four-models-no-news-2026-11-14']:
        baseline=HERE.parent/folder
        for name,digest in json.loads((baseline/'delivery-manifest.json').read_text())['files'].items():
            assert hashlib.sha256((baseline/name).read_bytes()).hexdigest()==digest,(folder,name)
            checks['preserved_baseline_files']+=1
    for name in ['candidates.npy','setups.npy']:
        assert hashlib.sha256((CACHE/name).read_bytes()).digest()==hashlib.sha256((CACHE.parent/'sma-four-models-no-news-2026-11-14'/name).read_bytes()).digest()
        checks['unchanged_candidate_arrays']+=1
    for p in plans:
        train,val=data.split(ms(p['start']),ms(p['validation_start']))
        assert not set(data.c['setup'][train])&set(data.c['setup'][val])
        assert data.completion[train].max()<ms(p['validation_start'])-1440*MIN
        assert data.completion[val].max()<ms(p['start'])-1440*MIN
        checks['purged_fold_checks']+=1
    native_groups=collections.defaultdict(list);verified_models=set()
    for run in runs:
        assert run['groups']==exp['variants'][run['variant']]
        assert run['test']['gross_pnl_usd']==totals(run['trades'])['gross_pnl_usd']
        used=set();busy={};models={}
        for side in ['long','short']:
            models[side]={}
            for kind in ['entry','exit']:
                a=artifact(run,side,kind);models[side][kind]=a;pre=a['preprocess'];identity=(run['fold'],side,kind,a['seed'],a['mask_key'])
                if identity in verified_models:continue
                verified_models.add(identity)
                assert cache_key(pre.mask)==a['mask_key'] and a['side']==side and a['kind']==kind
                assert not any('news' in n for n in a['input_names'])
                expected_mask=np.array([group_for(n,kind) in ['mandatory']+run['groups'] for n in pre.names])
                assert np.array_equal(pre.value_mask,expected_mask)
                assert np.array_equal(pre.mask,np.r_[expected_mask,expected_mask[pre.base.indicators]])
                best_ap=-np.inf;best_step=None
                for checkpoint in a['curve']:
                    if checkpoint['validation_ap']>best_ap+1e-12:best_ap=checkpoint['validation_ap'];best_step=checkpoint['updates']
                assert a['updates']==best_step
                checks['model_mask_and_checkpoint_checks']+=1
        for t in sorted(run['trades'],key=lambda r:r['entry_time']):
            e=t['entry_index'];c=data.c[t['candidate_id']];catalog=data.d.catalog[int(data.d.state['series'][e])]
            entry,exit=ms(t['entry_time']),ms(t['exit_time']);symbol=t['symbol'];step=t['exit_step']
            assert int(c['row'])==e and int(c['setup'])==t['setup_id']
            assert t['setup_id'] not in used;used.add(t['setup_id'])
            assert entry-55000>busy.get(symbol,-1)
            busy[symbol]=exit if t['scored'] else ms(catalog['end'])
            assert 5<=t['holding_minutes']<=1440 and 1<=step<=H
            assert exit-entry==step*BAR and int(data.setups[c['setup']]['time'])<=entry-55000
            assert t['notional_usd']==100
            if t['scored']:native_groups[catalog['key']].append((catalog,t))
            else:
                assert step==H and not np.isfinite(data.d.state['terminal_price'][e]) and t['return_pct'] is None
                checks['censored_deadlines_verified']+=1
            checks['trade_constraints_verified']+=1
        for side,sign in [('long',1),('short',-1)]:
            rows=[t for t in run['trades'] if t['side']==side]
            if not rows:continue
            ids=np.array([t['candidate_id'] for t in rows]);scores=entry_scores(data,models[side]['entry'],ids)
            assert np.allclose(scores,[t['entry_score'] for t in rows],atol=2e-6,rtol=0)
            assert np.all(scores>=run['policies'][side]['entry_threshold']-2e-6)
            checks['entry_scores_reproduced']+=len(rows)
            sample=[rows[0]] if len(rows)==1 else [rows[0],rows[-1]]
            paths=exit_predictions(data,models[side]['exit'],[t['entry_index'] for t in sample],sign,[run['policies'][side]['exit_threshold']])
            assert np.array_equal(paths['steps'][:,0],[t['exit_step'] for t in sample])
            checks['sampled_full_exit_paths_reproduced']+=len(sample)
        if run['trades']:
            t=min(run['trades'],key=lambda r:r['entry_time']);e=t['entry_index'];catalog=data.d.catalog[int(data.d.state['series'][e])]
            policy=ResearchPolicy.__new__(ResearchPolicy);policy.models=models
            policy.config={'sides':run['policies'],'pairs':CFG['pairs'],'entry_window_minutes':60,'holding_limit_minutes':1440}
            features=dict(zip(data.entry_base_names,np.r_[data.d.market[e],data.d.sma[e]]))
            with np.load(BASE_CACHE/'bars'/(catalog['key']+'.npz')) as bars:closes=bars['close'][:e-catalog['offset']+1]
            times=(ms(catalog['start'])+(np.arange(len(closes))+1)*BAR).tolist()
            # Each replay starts flat and excludes signals detected before its fold.
            prior=[(s['side'],s['pair_id'],times[s['detected_bar']]) for s in active_setups(closes,CFG['pairs'],CFG['entry_window_bars']) if times[s['detected_bar']]+5000<ms(run['fold'])]
            response=policy.decide_entry(closes,times,features,eligible=True,used_events=prior)
            assert response['action']=='enter' and response['side']==t['side'] and np.isclose(response['setup']['score'],t['entry_score'],atol=2e-6),(run['variant'],run['seed'],run['fold'],t,response)
            checks['first_trade_runtime_reproductions']+=1
        if run['variant']=='full' and run['seed']==exp['seeds'][0]:
            previous=json.loads((HERE.parent/'sma-four-models-no-news-2026-11-14'/(run['fold'][:10]+'-trades.json')).read_text())
            assert len(previous)==len(run['trades'])
            for a,b in zip(previous,run['trades']):
                assert {k:v for k,v in a.items() if k!='policy'}=={k:v for k,v in b.items() if k!='policy'}
            for side in ['long','short']:
                for kind in ['entry','exit']:
                    old=joblib.load(CACHE.parent/'sma-four-models-no-news-2026-11-14'/'fits'/run['fold'][:10]/(side+'_'+kind+'.joblib'))
                    assert old['updates']==models[side][kind]['updates']
                    for a,b in zip(old['model'].params,models[side][kind]['model'].params):assert np.array_equal(a,b)
                    checks['exact_baseline_network_reproductions']+=1
            checks['exact_baseline_trade_reproductions']+=len(previous)
    for key,group in native_groups.items():
        catalog=group[0][0];symbol=catalog['symbol']
        native={int(v[0]):v for v in gz(BASE_CACHE/'candles'/catalog['period']/(urllib.parse.quote(symbol,safe='')+'.json.gz'))['rows']}
        for _,t in group:
            actual=t['side_sign']*100*(float(native[ms(t['exit_time'])][1])/float(native[ms(t['entry_time'])][1])-1)
            assert np.isclose(actual,t['return_pct'],atol=1e-9,rtol=0),(key,t,actual)
            checks['independent_native_payoffs']+=1
    rng=np.random.default_rng(88);sample=rng.choice(len(data.c),40,replace=False);before=data.entry_rows(sample);original=data.c
    changed=np.array(data.c);changed['label']=1-changed['label'];changed['gain']=123456;data.c=changed
    assert np.allclose(before,data.entry_rows(sample),equal_nan=True);data.c=original
    class ForbiddenNews:
        def __getitem__(self,key):raise AssertionError('No-news input accessed news')
    old=data.d.news;data.d.news=ForbiddenNews();assert np.allclose(before,data.entry_rows(sample),equal_nan=True);data.d.news=old
    checks['no_news_or_target_input_mutation']=1
    if not partial:
        for variant in ['core','full']:
            policy=ResearchPolicy(HERE/'models'/variant)
            assert len({id(a['model']) for bykind in policy.models.values() for a in bykind.values()})==4
            for side in ['long','short']:assert policy.exit(side,{},1440)['action']=='exit'
            if variant=='full':
                for side in ['long','short']:
                    for kind in ['entry','exit']:
                        old=joblib.load(HERE.parent/'sma-four-models-no-news-2026-11-14'/(side+'_'+kind+'_model.joblib'))
                        now=policy.models[side][kind];assert old['updates']==now['updates']
                        for a,b in zip(old['model'].params,now['model'].params):assert np.array_equal(a,b)
                        checks['exact_final_baseline_network_reproductions']+=1
            checks['serialized_final_policies_loaded']+=1
        assert json.loads((HERE/'training-completion.json').read_text())['status']=='passed'
    result={'status':'passed','partial':partial,'runs_checked':len(runs),'checks':dict(checks),'experiment_lock_verified':True}
    save('partial-validation.json' if partial else 'validation.json',result);print(json.dumps(result),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
