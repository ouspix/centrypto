import time,itertools,joblib,concurrent.futures,multiprocessing,os
from engine import *
from masked import fit_cached
EXPERIMENT=json.loads((HERE/'experiment.json').read_text())
DATA=None
def initialize():
    global DATA
    DATA=FourData()
def run(task):
    with threadpool_limits(limits=1):return run_inner(task)
def run_inner(task):
    p,variant,seed=task;started=time.time();data=DATA;groups=EXPERIMENT['variants'][variant];fold=p['start'][:10]
    result_path=CACHE/'runs'/f'{variant}__{seed}__{fold}.json'
    if result_path.exists() and not p.get('final'):
        cached=json.loads(result_path.read_text())
        return {k:cached[k] for k in ['fold','variant','seed','test','seconds','final']}
    cache=CACHE/'models'/fold;cache.mkdir(exist_ok=True,parents=True);models={};summary={}
    for side,offset in [('long',0),('short',10)]:
        models[side]={}
        for kind,increment in [('entry',0),('exit',1)]:
            model=fit_cached(cache,CACHE/'prepared'/fold/side/kind,groups,kind,side,seed+offset+increment);models[side][kind]=model
            summary[side+'_'+kind]={'updates':model['updates'],'active_dimensions':model['active_transformed_dimensions'],'fixed_dimensions':model['fixed_transformed_dimensions'],
                'mask_key':model['mask_key'],'validation_ap':next(c['validation_ap'] for c in model['curve'] if c['updates']==model['updates'])}
    start=ms(p['start']);val_start=ms(p['validation_start']);val_end=start-1440*MIN
    prepared=prepare(data,models,val_start,val_end);policies={};choices={}
    for side in ['long','short']:
        best={'cash':True,'entry_threshold':None,'exit_threshold':None,'validation_pnl_usd':0.};trials=[]
        for et,xt in itertools.product(CFG['entry_thresholds'],CFG['exit_thresholds']):
            config={s:{'cash':True} for s in ['long','short']};config[side]={'cash':False,'entry_threshold':et,'exit_threshold':xt}
            rows,meta=replay(data,prepared,config,p['start']);stat=totals(rows);trials.append({'entry_threshold':et,'exit_threshold':xt,**stat})
            if stat['censored']==0 and stat['trades']>=5 and stat['gross_pnl_usd']>best['validation_pnl_usd']+1e-9:
                best={'cash':False,'entry_threshold':et,'exit_threshold':xt,'validation_pnl_usd':stat['gross_pnl_usd']}
        policies[side]=best;choices[side]=trials
    validation,meta=replay(data,prepared,policies,p['start']);del prepared
    rows=[];test_meta={}
    if not p.get('final'):
        selected={s:models[s] if not policies[s]['cash'] else {'untrained':True} for s in models}
        prepared=prepare(data,selected,start,ms(p['end']),{s:[policies[s]['exit_threshold']] for s in policies})
        rows,test_meta=replay(data,prepared,policies,p['start'],variant);del prepared
    else:
        output=HERE/'models'/variant;output.mkdir(parents=True,exist_ok=True)
        for side in models:
            for kind in models[side]:
                model=models[side][kind];model['policy']=policies[side];joblib.dump(model,output/(side+'_'+kind+'_model.joblib'),compress=3)
        (output/'policy-config.json').write_text(json.dumps({'sides':policies,'pairs':CFG['pairs'],'entry_window_minutes':60,'holding_limit_minutes':1440,
            'active_optional_groups':groups,'mandatory_features':json.loads((HERE/'feature-schema.json').read_text()),'fees':0,'research_only':True},indent=2))
    result={'fold':p['start'],'end':p['end'],'variant':variant,'seed':seed,'groups':groups,'models':summary,'policies':policies,'selection':choices,
       'validation':totals(validation),'test':{**totals(rows),**test_meta},'by_side':{s:totals([r for r in rows if r['side']==s]) for s in ['long','short']},
       'trades':rows,'seconds':time.time()-started,'final':bool(p.get('final'))}
    key=f'{variant}__{seed}__{fold}';save('runs/'+key+'.json',result,True)
    return {k:result[k] for k in ['fold','variant','seed','test','seconds','final']}
def main():
    verify_original();locked=lock()
    if (HERE/'experiment-lock.json').exists():assert json.loads((HERE/'experiment-lock.json').read_text())['files']==locked,'Refuse cached results after protocol edits'
    save('experiment-lock.json',{'files':locked,'candidate_hash':hashlib.sha256((CACHE/'candidates.npy').read_bytes()).hexdigest(),
       'setup_hash':hashlib.sha256((CACHE/'setups.npy').read_bytes()).hexdigest(),'rules_fixed_before_runs':True})
    plans=json.loads((HERE/'fold-plan.json').read_text())
    tasks=[(p,v,seed) for v in EXPERIMENT['variants'] for seed in EXPERIMENT['seeds'] for p in plans]
    progress=[]
    with concurrent.futures.ProcessPoolExecutor(max_workers=EXPERIMENT['workers'],mp_context=multiprocessing.get_context('spawn'),initializer=initialize) as pool:
        pending={pool.submit(run,t):t for t in tasks}
        for f in concurrent.futures.as_completed(pending):
            result=f.result();progress.append(result);save('progress.json',{'completed':len(progress),'total':len(tasks),'latest':result})
            print(json.dumps({'completed':len(progress),'total':len(tasks),**result}),flush=True)
    # Final core and full are prespecified, never the best retrospective variant.
    initialize();p=json.loads((HERE.parent/'sma-four-models-no-news-2026-11-14/2026-11-15-audit.json').read_text())['plan']
    for variant in ['core','full']:run((p,variant,EXPERIMENT['seeds'][0]))
    assert lock()==locked
    save('training-completion.json',{'status':'passed','outer_runs':len(progress),'seeds':EXPERIMENT['seeds'],'variants':len(EXPERIMENT['variants']),
        'final_core_and_full_models_saved':True,'original_files_verified':verify_original(),'experiment_lock_verified':True})
if __name__=='__main__':main()
