import time,copy,itertools,joblib,concurrent.futures,multiprocessing
from engine import *
from network import fit_binary
def fit_fold(plan):
    with threadpool_limits(limits=1):return fit_fold_inner(plan)
def fit_fold_inner(plan):
    started=time.time();data=FourData();start=ms(plan['start']);val_start=ms(plan['validation_start']);val_end=start-CFG['purge_minutes']*MIN
    train,val=data.split(start,val_start);models={};audit={'plan':plan,'sides':{},'checks':{}};folder=CACHE/'fits'/plan['start'][:10];folder.mkdir(parents=True,exist_ok=True)
    assert not set(data.c['setup'][train])&set(data.c['setup'][val])
    assert data.completion[train].max()<val_start-CFG['purge_minutes']*MIN
    assert data.completion[val].max()<start-CFG['purge_minutes']*MIN
    for side,name,seed_offset in [(1,'long',0),(-1,'short',10)]:
        ids=train[data.c['side'][train]==side];vid=val[data.c['side'][val]==side];y=np.array(data.c['label'][ids]);vy=np.array(data.c['label'][vid])
        counts={'training_candidates':len(ids),'training_setups':len(np.unique(data.c['setup'][ids])),'validation_candidates':len(vid),
            'positive_training_candidates':int(y.sum()),'positive_validation_candidates':int(vy.sum())}
        if min(int(y.sum()),int((y==0).sum()),int(vy.sum()),int((vy==0).sum()))<5:
            models[name]={'untrained':True};audit['sides'][name]={'counts':counts,'reason':'Insufficient labeled classes in earlier training/validation'};continue
        print(json.dumps({'fold':plan['start'],'side':name,'phase':'entry_fit','counts':counts}),flush=True)
        entry,entry_audit=fit_binary(data.entry_rows(ids),y,data.entry_rows(vid),vy,data.entry_names,CFG['network'],CFG['network']['seed']+seed_offset,
            {'kind':'entry','side':name,'news_allowed':True,'setup_context_names':CONTEXT_NAMES})
        ex,ey,ex_audit=data.exit_dataset(ids,side,CFG['exit_training_max_entries_per_side'],130+seed_offset)
        vx,evy,vx_audit=data.exit_dataset(vid,side,CFG['exit_validation_max_entries_per_side'],140+seed_offset)
        exit,exit_audit=fit_binary(ex,ey,vx,evy,data.exit_names,CFG['network'],CFG['network']['seed']+seed_offset+1,
            {'kind':'exit','side':name,'news_allowed':False})
        assert not any('news' in n for n in exit['input_names']);del ex,ey,vx,evy
        models[name]={'entry':entry,'exit':exit};audit['sides'][name]={'counts':counts,'entry':entry_audit,'exit':exit_audit,'exit_training':ex_audit,'exit_validation':vx_audit}
        joblib.dump(entry,folder/(name+'_entry.joblib'),compress=3);joblib.dump(exit,folder/(name+'_exit.joblib'),compress=3)
        print(json.dumps({'fold':plan['start'],'side':name,'phase':'models_fit','entry_updates':entry['updates'],'exit_updates':exit['updates']}),flush=True)
    prepared=prepare(data,models,val_start,val_end);policies={};audit['threshold_selection']={}
    for name in ['long','short']:
        best={'cash':True,'entry_threshold':None,'exit_threshold':None,'validation_pnl_usd':0.};choices=[]
        if name in prepared:
            for et,xt in itertools.product(CFG['entry_thresholds'],CFG['exit_thresholds']):
                config={s:{'cash':True} for s in ['long','short']};config[name]={'cash':False,'entry_threshold':et,'exit_threshold':xt}
                rows,meta=replay(data,prepared,config,plan['start']);stat=totals(rows);choices.append({'entry_threshold':et,'exit_threshold':xt,**stat})
                if stat['censored']==0 and stat['trades']>=CFG['minimum_validation_trades'] and stat['gross_pnl_usd']>best['validation_pnl_usd']+1e-9:
                    best={'cash':False,'entry_threshold':et,'exit_threshold':xt,'validation_pnl_usd':stat['gross_pnl_usd']}
        policies[name]=best;audit['threshold_selection'][name]=choices
    validation_rows,meta=replay(data,prepared,policies,plan['start']);audit['policies']=policies;audit['joint_validation']={**totals(validation_rows),**meta}
    rows=[]
    if not plan.get('final'):
        selected={name:models[name] if not policies[name]['cash'] else {'untrained':True} for name in models}
        thresholds={name:[policies[name]['exit_threshold']] for name in policies}
        prepared_test=prepare(data,selected,start,ms(plan['end']),thresholds)
        rows,test_meta=replay(data,prepared_test,policies,plan['start']);audit['test']={**totals(rows),**test_meta}
    else:
        for name in ['long','short']:
            assert not models[name].get('untrained'),f'Final {name} models missing'
            for kind in ['entry','exit']:
                artifact=models[name][kind];artifact['policy']=policies[name];artifact['training_cutoff']=plan['validation_start'];artifact['research_only']=True
                joblib.dump(artifact,HERE/(name+'_'+kind+'_model.joblib'),compress=3)
        save('policy-config.json',{'sides':policies,'pairs':CFG['pairs'],'entry_window_minutes':60,'holding_limit_minutes':1440,'fees':0,'research_only':True})
    audit['seconds']=time.time()-started;save(plan['start'][:10]+'-audit.json',audit)
    save(plan['start'][:10]+'-trades.json',rows);print(json.dumps({'fold_finished':plan['start'],'policies':policies,'test':audit.get('test'),'seconds':audit['seconds']}),flush=True)
    return {'audit':audit,'trades':rows}
def main():
    verify_original();locked=lock();save('experiment-lock.json',{'files':locked,'baseline_manifest_sha256':hashlib.sha256((SOURCE/'delivery-manifest.json').read_bytes()).hexdigest(),
      'datasets':{name:hashlib.sha256((CACHE/name).read_bytes()).hexdigest() for name in ['setups.npy','candidates.npy']},'test_outcomes_not_used_to_change_protocol':True})
    old=json.loads((SOURCE/'fold-plan.json').read_text());plans=[{k:p[k] for k in ['start','end','validation_start']} for p in old]
    save('fold-plan.json',plans);results=[]
    with concurrent.futures.ProcessPoolExecutor(max_workers=2,mp_context=multiprocessing.get_context('spawn')) as pool:
        futures=[pool.submit(fit_fold,p) for p in plans]
        for future in concurrent.futures.as_completed(futures):results.append(future.result())
    rows=sorted([r for result in results for r in result['trades']],key=lambda r:r['entry_time']);csvwrite('predictions.csv',rows)
    oldfinal=json.loads((SOURCE/'final-fit.json').read_text());final_start=ms(json.loads((SOURCE/'spec.json').read_text())['periods'][-1]['end'])+CFG['purge_minutes']*MIN
    final={'start':iso(final_start),'end':iso(final_start),'validation_start':oldfinal['validation_start'],'final':True};fit_fold(final)
    assert lock()==locked,'Experiment code changed during fit'
    save('training-completion.json',{'status':'passed','folds':len(results),'test':totals(rows),'by_side':{side:totals([r for r in rows if r['side']==side]) for side in ['long','short']},
      'four_final_models':True,'original_artifacts_verified':verify_original(),'lock_verified':True})
if __name__=='__main__':main()
