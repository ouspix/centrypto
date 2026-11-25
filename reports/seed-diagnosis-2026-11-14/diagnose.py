"""Frozen-model component swaps; test returns never choose a trading policy."""
import pathlib,sys,json,hashlib,itertools,concurrent.futures,multiprocessing,time,joblib
OUT=pathlib.Path(__file__).resolve().parent
BASE=OUT.parent/'feature-ablation-2026-11-14'
sys.path.insert(0,str(BASE))
from engine import *
sys.path.insert(0,str(BASE))
from scipy.stats import spearmanr
OUT_CACHE=CACHE.parent/OUT.name
SEEDS=[20261114,20261115,20261116]

def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,indent=2,allow_nan=False))

def original(fold,seed):return json.loads((CACHE/'runs'/f'full__{seed}__{fold[:10]}.json').read_text())

def model(fold,seed,side,kind):
    r=original(fold,seed);offset=(10 if side=='short' else 0)+(1 if kind=='exit' else 0)
    key=r['models'][side+'_'+kind]['mask_key']
    return joblib.load(CACHE/'models'/fold[:10]/f'{kind}_{side}_{seed+offset}_{key}.joblib')

def component_cache(task):
    plan,side=task;name='long' if side==1 else 'short';fold=plan['start'];data=FourData()
    with threadpool_limits(limits=1):
        models={s:{k:model(fold,s,name,k) for k in ['entry','exit']} for s in SEEDS}
        for window,start,end in [('validation',ms(plan['validation_start']),ms(fold)-1440*MIN),('test',ms(fold),ms(plan['end']))]:
            folder=OUT_CACHE/'components'/fold[:10]/name/window;folder.mkdir(parents=True,exist_ok=True)
            if (folder/'complete.json').exists():continue
            ids=data.replay_ids(start,end,side);scores={s:entry_scores(data,models[s]['entry'],ids) for s in SEEDS}
            entries=np.unique(data.c['row'][ids[np.logical_or.reduce([scores[s]>=.5 for s in SEEDS])]])
            np.savez_compressed(folder/'entries.npz',ids=ids,entries=entries,**{str(s):scores[s] for s in SEEDS})
            for s in SEEDS:
                exits=exit_predictions(data,models[s]['exit'],entries,side,CFG['exit_thresholds'])
                np.savez_compressed(folder/f'exit-{s}.npz',**exits)
            profile={'candidate_rows':len(ids),'unique_eligible_entries':len(np.unique(data.c['row'][ids])),'union_passing_entries':len(entries),'seeds':{},'entry_correlations':{}}
            for s in SEEDS:
                y=data.c['label'][ids];known=np.isfinite(y);a=scores[s]
                from sklearn.metrics import average_precision_score
                profile['seeds'][str(s)]={'score_quantiles':np.quantile(a,[0,.25,.5,.75,.9,.95,.99,1]).tolist(),
                    'passes':{str(t):int((a>=t).sum()) for t in CFG['entry_thresholds']},
                    'known_labels':int(known.sum()),'positives':int(np.nansum(y)),
                    'ap':float(average_precision_score(y[known],a[known])) if np.nansum(y)>0 else None,
                    'entry_updates':models[s]['entry']['updates'],'exit_updates':models[s]['exit']['updates']}
            for a,b in itertools.combinations(SEEDS,2):
                profile['entry_correlations'][f'{a}-{b}']={'spearman':float(spearmanr(scores[a],scores[b]).statistic),
                    'passing_jaccard':{str(t):float(np.sum((scores[a]>=t)&(scores[b]>=t))/max(1,np.sum((scores[a]>=t)|(scores[b]>=t)))) for t in CFG['entry_thresholds']}}
            profile['exit_timing']={}
            for a,b in itertools.combinations(SEEDS,2):
                with np.load(folder/f'exit-{a}.npz') as aa,np.load(folder/f'exit-{b}.npz') as bb:
                    ka=aa['steps'][:,1];kb=bb['steps'][:,1]
                    profile['exit_timing'][f'{a}-{b}']={'fixed_threshold':.5,'same_exit_fraction':float(np.mean(ka==kb)),
                        'median_abs_difference_minutes':float(np.median(abs(ka-kb))*5),'a_median_minutes':float(np.median(ka)*5),'b_median_minutes':float(np.median(kb)*5)}
            write(folder/'complete.json',profile)
    return {'fold':fold,'side':name}

def load_components(plan):
    result={}
    for window in ['validation','test']:
        result[window]={}
        for side in ['long','short']:
            folder=OUT_CACHE/'components'/plan['start'][:10]/side/window
            with np.load(folder/'entries.npz') as z:entry={k:z[k] for k in z.files}
            exits={}
            for seed in SEEDS:
                with np.load(folder/f'exit-{seed}.npz') as z:exits[seed]={k:z[k] for k in z.files}
            result[window][side]={'entry':entry,'exit':exits}
    return result

def prepared(components,entry_seed,exit_seed):
    out={}
    for side,c in components.items():
        score=c['entry'][str(entry_seed)];ids=c['entry']['ids'];keep=score>=.5
        out[side]={'ids':ids[keep],'score':score[keep],'exits':c['exit'][exit_seed],'thresholds':CFG['exit_thresholds']}
    return out

def select(data,prep,fold):
    policies={};trials={}
    for side in ['long','short']:
        best={'cash':True,'entry_threshold':None,'exit_threshold':None,'validation_pnl_usd':0.};trials[side]=[]
        for et,xt in itertools.product(CFG['entry_thresholds'],CFG['exit_thresholds']):
            policy={s:{'cash':True} for s in ['long','short']};policy[side]={'cash':False,'entry_threshold':et,'exit_threshold':xt}
            rows,_=replay(data,prep,policy,fold);stats=totals(rows);trials[side].append({'entry_threshold':et,'exit_threshold':xt,**stats})
            if stats['censored']==0 and stats['trades']>=CFG['minimum_validation_trades'] and stats['gross_pnl_usd']>best['validation_pnl_usd']+1e-9:
                best={'cash':False,'entry_threshold':et,'exit_threshold':xt,'validation_pnl_usd':stats['gross_pnl_usd']}
        policies[side]=best
    return policies,trials

def replay_fold(plan):
    with threadpool_limits(limits=1):return replay_fold_inner(plan)

def replay_fold_inner(plan):
    data=FourData();fold=plan['start'];components=load_components(plan);output=[];surfaces=[];diagonal_checks=0
    def evaluate(kind,e,x,p,policies,trials=None):
        prep=prepared(components['test'],e,x);rows,meta=replay(data,prep,policies,fold,kind)
        result={'kind':kind,'fold':fold,'entry_seed':e,'exit_seed':x,'policy_seed':p,'policies':policies,
            'test':{**totals(rows),**meta},'by_side':{s:totals([r for r in rows if r['side']==s]) for s in ['long','short']},'trades':rows}
        if trials is not None:result['validation_trials']=trials
        output.append(result);return result
    for e,x in itertools.product(SEEDS,repeat=2):
        val=prepared(components['validation'],e,x)
        policies,trials=select(data,val,fold)
        if e==x:
            previous=original(fold,e)
            assert policies==previous['policies'],(fold,e,policies,previous['policies'])
            assert trials==previous['selection'],(fold,e,'validation surface changed')
        evaluate('reselected',e,x,None,policies,trials)
        fixed={s:{'cash':False,'entry_threshold':.5,'exit_threshold':.5} for s in ['long','short']}
        evaluate('fixed_0.5',e,x,None,fixed)
        for p in SEEDS:
            r=evaluate('crossed',e,x,p,original(fold,p)['policies'])
            if e==x==p:
                old=original(fold,p)
                assert [{k:v for k,v in row.items() if k!='policy'} for row in old['trades']]==[{k:v for k,v in row.items() if k!='policy'} for row in r['trades']],(fold,p,'diagonal changed')
                diagonal_checks+=1
        if e==x:
            test=prepared(components['test'],e,x)
            for side in ['long','short']:
                for et,xt in itertools.product(CFG['entry_thresholds'],CFG['exit_thresholds']):
                    policy={s:{'cash':True} for s in ['long','short']};policy[side]={'cash':False,'entry_threshold':et,'exit_threshold':xt}
                    rows,_=replay(data,test,policy,fold)
                    v=next(t for t in trials[side] if t['entry_threshold']==et and t['exit_threshold']==xt)
                    surfaces.append({'fold':fold,'seed':e,'side':side,'entry_threshold':et,'exit_threshold':xt,'validation':v,'test':totals(rows)})
    write(OUT_CACHE/'replays'/(fold[:10]+'.json'),{'plan':plan,'results':output,'threshold_surfaces':surfaces,'exact_diagonal_checks':diagonal_checks})
    return {'fold':fold,'replays':len(output),'diagonal_checks':diagonal_checks}

def main():
    plans=json.loads((BASE/'fold-plan.json').read_text());OUT_CACHE.mkdir(parents=True,exist_ok=True)
    manifest=json.loads((BASE/'delivery-manifest.json').read_text())['files']
    for name,digest in manifest.items():assert hashlib.sha256((BASE/name).read_bytes()).hexdigest()==digest,name
    spec={'seeds':SEEDS,'folds':plans,'crossed_factors':['entry model seed','exit model seed','threshold/cash policy seed'],
        'comparisons':'27 crossed + 9 freshly validation-reselected + 9 fixed(.5/.5, both sides active) per fold; 54 single-side threshold diagnostics per fold.',
        'test_role':'Retrospective diagnosis only; no test-based model or threshold selection. Original unseen-by-model windows reused.',
        'fees':0,'notional_usd':100,'censoring':'Preserve missing exit prices; no total PnL or decomposition for incomplete combinations.',
        'baseline_manifest_hash':hashlib.sha256((BASE/'delivery-manifest.json').read_bytes()).hexdigest(),'script_hash':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
    write(OUT/'protocol.json',spec)
    with concurrent.futures.ProcessPoolExecutor(max_workers=8,mp_context=multiprocessing.get_context('spawn')) as pool:
        for result in pool.map(component_cache,[(p,s) for p in plans for s in [1,-1]]):print(json.dumps({'stage':'components',**result}),flush=True)
    with concurrent.futures.ProcessPoolExecutor(max_workers=4,mp_context=multiprocessing.get_context('spawn')) as pool:
        for result in pool.map(replay_fold,plans):print(json.dumps({'stage':'replays',**result}),flush=True)
    for name,digest in manifest.items():assert hashlib.sha256((BASE/name).read_bytes()).hexdigest()==digest,name
    write(OUT/'completion.json',{'status':'passed','exact_original_run_reproductions':12,'crossed_replays':108,'validation_reselected_replays':36,'fixed_threshold_replays':36,'single_side_threshold_diagnostics':216,'preserved_baseline_files':len(manifest)})
if __name__=='__main__':main()
