"""Purged chronological training of two side-conditioned supervised networks."""
import time,joblib,concurrent.futures,multiprocessing
from sklearn.metrics import average_precision_score,precision_recall_fscore_support
from replay import *
DATA=None

def initialize():
    global DATA
    DATA=Data()

def side_counts(d,ids):
    return {side:int(((d.target[ids]==1)&(ids%2==j)).sum()) for j,side in enumerate(['long','short'])}

def plan(d,end):
    train=d.labeled[d.completion[d.labeled]<end-1440*MIN];days=np.unique(d.times[train]//86400000)
    if len(days)<5:return None
    nd=SPEC['validation_days']
    while nd<len(days):
        val_start=int(days[-nd]*86400000);val=train[d.times[train]>=val_start]
        if min(side_counts(d,val).values())>=SPEC['validation_min_positive_entries']:break
        nd+=1
    inner=train[(d.times[train]<val_start)&(d.completion[train]<val_start-1440*MIN)]
    it=np.array([i for i in inner if i in d.teacher_by_entry],int)
    # A common, fixed priced subset avoids checkpoint-dependent censoring bias.
    vt=np.array([i for i in val if i in d.teacher_by_entry and np.isfinite(d.state['terminal_price'][i//2])],int)
    if len(inner)<200 or min(side_counts(d,it).values())<15 or min(side_counts(d,vt).values())<5:return None
    rows,_=decode(inner);known=d.news_values(rows,'news_feed_available')>0;relevant=d.news_values(rows,'news_events_24h')>0
    return {'test_start':iso(end),'inner_ids':inner.tolist(),'validation_ids':val.tolist(),
            'inner_teacher_entries':it.tolist(),'validation_teacher_entries':vt.tolist(),
            'validation_start':iso(val_start),'validation_end':iso(end-1440*MIN),
            'training_label_end':iso(int(d.completion[train].max())),
            'training_news_states':int(known.sum()),'training_relevant_news_states':int(relevant.sum()),
            'training_news_positive_targets':int(((d.target[inner]==1)&known).sum()),
            'training_relevant_news_positive_targets':int(((d.target[inner]==1)&relevant).sum()),
            'training_positives_by_side':side_counts(d,inner),'validation_positives_by_side':side_counts(d,val)}

def metrics(y,p,ids,threshold=None):
    out={'states':len(y),'positives':int((y==1).sum()),'positive_rate':float(np.mean(y)) if len(y) else None,
         'average_precision':float(average_precision_score(y,p)) if len(y) and np.any(y==1) else None,'by_side':{}}
    for j,side in enumerate(['long','short']):
        mask=ids%2==j;yy=y[mask];pp=p[mask]
        out['by_side'][side]={'states':len(yy),'positives':int((yy==1).sum()),
                              'average_precision':float(average_precision_score(yy,pp)) if len(yy) and np.any(yy==1) else None,
                              'positive_rate':float(yy.mean()) if len(yy) else None}
    aps=[v['average_precision'] for v in out['by_side'].values() if v['average_precision'] is not None]
    out['macro_side_average_precision']=float(np.mean(aps)) if aps else None
    if threshold is not None and len(y):
        precision,recall,f,_=precision_recall_fscore_support(y,p>=threshold,average='binary',zero_division=0)
        out.update(precision=float(precision),recall=float(recall),f1=float(f),predicted_positive_states=int((p>=threshold).sum()))
    return out

def permutation_audit(artifact,x,y,ids):
    baseline=metrics(y,predict(artifact['model'],artifact['preprocess'],x),ids)['macro_side_average_precision']
    names=artifact['input_names'];groups={'all_news':[i for i,n in enumerate(names) if n.startswith('news_')],
        'all_sma':[i for i,n in enumerate(names) if n.startswith('sma_')], 'candidate_side':[names.index('candidate_side')]}
    for a,b in PAIRS:groups[f'sma_pair_{a}_{b}']=[i for i,n in enumerate(names) if n==f'sma_gap_{a}_{b}' or n.startswith(f'sma_pair_{a}_{b}_')]
    results=[]
    for label,columns in groups.items():
        if not any(names[i] in artifact['preprocess'].names for i in columns):
            results.append({'group':label,'retained':False});continue
        changes=[]
        for seed in [17,23]:
            rng=np.random.default_rng(seed);mutated=x.copy()
            # Shuffle feature blocks within side; the side test necessarily swaps sides.
            strata=[np.arange(len(ids))] if label=='candidate_side' else [np.flatnonzero(ids%2==j) for j in [0,1]]
            for ix in strata:mutated[np.ix_(ix,columns)]=x[np.ix_(rng.permutation(ix),columns)]
            quality=metrics(y,predict(artifact['model'],artifact['preprocess'],mutated),ids)['macro_side_average_precision']
            changes.append(baseline-quality)
        results.append({'group':label,'retained':True,'validation_macro_ap_drop_mean':float(np.mean(changes)),'repeats':changes})
    return {'baseline_macro_ap':baseline,'groups':results,'note':'Earlier validation only; diagnostic association, not a retrained ablation or evidence of causal profitability. Not used for selection.'}

def fit(record,final=False):
    started=time.time();d=DATA;inner=np.array(record['inner_ids'],int);val=np.array(record['validation_ids'],int)
    it=np.array(record['inner_teacher_entries'],int);vt=np.array(record['validation_teacher_entries'],int)
    entry_raw=d.entry_rows(inner);entry_pre=Preprocess().fit(entry_raw,d.entry_names);entry_x=entry_pre.transform(entry_raw);entry_y=d.target[inner].copy()
    val_raw=d.entry_rows(val);val_y=d.target[val].copy();entry_net=BinaryNetwork(entry_x.shape[1],SPEC['network']['seed'])
    entry_curves=[];entry_best=None;entry_quality=-np.inf
    def entry_checkpoint(step,net,info):
        nonlocal entry_best,entry_quality
        m=metrics(val_y,predict(net,entry_pre,val_raw),val);entry_curves.append({'updates':step,**info,**m})
        if step and m['macro_side_average_precision']>entry_quality+1e-12:
            entry_quality=m['macro_side_average_precision'];entry_best={'model':copy.deepcopy(net),'preprocess':entry_pre,'updates':step,
                'input_names':d.entry_names,'kind':'entry','news_allowed':True,'side_conditioned':True,'validation_macro_side_ap':entry_quality}
    entry_net.fit(entry_x,entry_y,entry_checkpoint,decode(inner)[1]);del entry_raw,entry_x
    exit_raw,exit_y,exit_candidates=d.exit_training(it);exit_pre=Preprocess().fit(exit_raw,d.exit_names)
    assert not any('news' in n for n in exit_pre.input_names)
    exit_x=exit_pre.transform(exit_raw);exit_net=BinaryNetwork(exit_x.shape[1],SPEC['network']['seed']+1)
    exit_curves=[];exit_best=None;exit_quality=-np.inf
    def exit_checkpoint(step,net,info):
        nonlocal exit_best,exit_quality
        choices=[]
        if step:
            for threshold in [.25,.5,.75]:
                result=exit_paths(d,net,exit_pre,vt,threshold);assert result['valid'].all()
                per_side={side:float(result['profit'][vt%2==j].mean()) for j,side in enumerate(['long','short'])}
                value=float(np.mean(list(per_side.values())))
                choices.append({'threshold':threshold,'macro_side_teacher_return_pct':value,'by_side_return_pct':per_side})
                if value>exit_quality+1e-12:
                    exit_quality=value;exit_best={'model':copy.deepcopy(net),'preprocess':exit_pre,'updates':step,'input_names':d.exit_names,
                        'kind':'exit','news_allowed':False,'side_conditioned':True,'threshold':threshold,
                        'validation_macro_side_teacher_return_pct':value,'training_entry_ids':it.tolist()}
        exit_curves.append({'updates':step,**info,'choices':choices})
    exit_net.fit(exit_x,exit_y,exit_checkpoint,decode(exit_candidates)[1]);del exit_raw,exit_x
    best={'cash':True,'entry_threshold':None,'validation_profit_usd':0.,'trades':0};selections=[]
    for threshold in [.5,.75,.9]:
        rows=continuous_replay(d,entry_best,exit_best,ms(record['validation_start']),ms(record['validation_end']),threshold,exit_best['threshold'])
        stat=totals(rows);selections.append({'entry_threshold':threshold,**stat,'by_side':{side:totals([r for r in rows if r['side']==side]) for side in ['long','short']}})
        if stat['censored_trades']==0 and stat['trades']>=5 and stat['gross_profit_usd']>best['validation_profit_usd']+1e-9:
            best={'cash':False,'entry_threshold':threshold,'validation_profit_usd':stat['gross_profit_usd'],'trades':stat['trades']}
    audit={**record,'entry_training_states':len(inner),'entry_training_positives':int(entry_y.sum()),'exit_training_entries':len(it),
           'exit_training_rows':len(exit_y),'entry_retained_features':entry_pre.names,'exit_retained_features':exit_pre.names,
           'entry_input_dimensions':len(entry_pre.names)+len(entry_pre.indicators),'exit_input_dimensions':len(exit_pre.names)+len(exit_pre.indicators),
           'entry_curves':entry_curves,'exit_curves':exit_curves,'entry_updates':entry_best['updates'],'exit_updates':exit_best['updates'],
           'exit_threshold':exit_best['threshold'],'threshold_selection':selections,'selection':best,
           'validation_entry_metrics':metrics(val_y,predict(entry_best['model'],entry_pre,val_raw),val,best['entry_threshold']),
           'duration_seconds':time.time()-started}
    output=[];teacher_rows=[];test_metrics=None
    if not final:
        start,end=ms(record['start']),ms(record['end']);test_ids=d.labeled[(d.times[d.labeled]>=start)&(d.completion[d.labeled]<end)]
        test_metrics=metrics(d.target[test_ids],entries_scores(d,entry_best,test_ids),test_ids,best['entry_threshold']) if len(test_ids) else {'states':0}
        if not best['cash']:
            output=continuous_replay(d,entry_best,exit_best,start,end,best['entry_threshold'],exit_best['threshold'])
            output+=continuous_replay(d,entry_best,exit_best,start,end,best['entry_threshold'],exit_best['threshold'],policy='entry_fixed24h',fixed_exit=True)
        test_teacher=d.teacher_ids(start,end)
        result=exit_paths(d,exit_best['model'],exit_pre,test_teacher,exit_best['threshold']) if len(test_teacher) else None
        for j,e in enumerate(test_teacher):
            teacher_rows.append({'candidate_id':int(e),'entry_index':int(e)//2,'side':'long' if e%2==0 else 'short',
                'symbol':d.catalog[int(d.state['series'][int(e)//2])]['symbol'],'entry_time':iso(int(d.times[e])+55000),
                'teacher_gain_pct':d.teacher_by_entry[int(e)]['teacher_gain_pct'],
                'learned_exit_gain_pct':float(result['profit'][j]) if result['valid'][j] else None,'scored':bool(result['valid'][j]),
                'holding_minutes':int(result['steps'][j])*5,'fold':record['start']})
        for r in output:r['fold']=record['start']
    else:
        entry_best.update(policy_selection=best,history_end=record['validation_end']);exit_best.update(history_end=record['validation_end'])
        joblib.dump(entry_best,HERE/'entry_model.joblib',compress=3);joblib.dump(exit_best,HERE/'exit_model.joblib',compress=3)
        save('final-fit.json',audit)
        save('policy-config.json',{**best,'exit_threshold':exit_best['threshold'],'bar_minutes':5,'holding_limit_minutes':1440,
            'fees':0,'entry_news':True,'exit_news':False,'sides':['long','short'],'sma_pairs':PAIRS,'research_only':True})
        save('validation-feature-importance.json',permutation_audit(entry_best,val_raw,val_y,val))
    return {'audit':audit,'trades':output,'teacher_diagnostic':teacher_rows,'entry_test_metrics':test_metrics}

def worker(record):
    with threadpool_limits(limits=1):return fit(record)

def main():
    from lock import verify_lock
    lock=verify_lock();d=Data();plans=[];warmup=[]
    for window in SPEC['outer_tests']:
        p=plan(d,ms(window['start']))
        if p is None:warmup.append({**window,'reason':'Insufficient earlier purged targets in one or both directions'});continue
        plans.append({**p,**window})
    save('fold-plan.json',plans);save('warmup-folds.json',warmup)
    fingerprint=hashlib.sha256(json.dumps(lock,sort_keys=True).encode()).hexdigest()[:16];folder=CACHE/('fits-'+fingerprint);folder.mkdir(exist_ok=True)
    pending=[p for p in plans if not (folder/(p['start'][:10]+'.json')).exists()]
    with concurrent.futures.ProcessPoolExecutor(max_workers=3,mp_context=multiprocessing.get_context('spawn'),initializer=initialize) as pool:
        jobs={pool.submit(worker,p):p for p in pending}
        for job in concurrent.futures.as_completed(jobs):
            p=jobs[job];result=job.result();(folder/(p['start'][:10]+'.json')).write_text(json.dumps(result,allow_nan=False))
            print(json.dumps({'fold':p['start'],'seconds':result['audit']['duration_seconds'],'selection':result['audit']['selection'],
                              'test':totals([r for r in result['trades'] if r['policy']=='two_stage'])}),flush=True)
    completed=[json.loads((folder/(p['start'][:10]+'.json')).read_text()) for p in plans]
    save('selection-audit.json',[r['audit'] for r in completed]);save('entry-test-metrics.json',[{'fold':p['start'],**r['entry_test_metrics']} for p,r in zip(plans,completed)])
    csvwrite('predictions.csv',[r for f in completed for r in f['trades']]);csvwrite('teacher-exit-diagnostic.csv',[r for f in completed for r in f['teacher_diagnostic']])
    print('Chronological tests complete',flush=True)
    global DATA
    DATA=d;p=plan(d,ms(SPEC['periods'][-1]['end'])+1440*MIN);assert p is not None
    with threadpool_limits(limits=1):fit(p,final=True)
    print('Both final models saved',flush=True)

if __name__=='__main__':main()
