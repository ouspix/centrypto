"""Outer chronological evaluation; feature selection never sees outer outcomes."""
import collections,hashlib,math,time
import joblib
from scipy.stats import rankdata
from common import *
from reduction import *
MODELS=['historical_mean','wide_nonlinear','correlation_reduced','relevance_reduced','relevance_no_news']

def metrics(rows):
    if not rows:return {'n':0,'episodes':0,'mean_return_pct':None,'sum_pnl_usd':0,'mean_R':None,'profit_factor':None,'wins':0,'days':0}
    p=np.array([r['return_pct'] for r in rows]);r=np.array([x['R'] for x in rows]);gain=p[p>0].sum();loss=-p[p<0].sum()
    return {'n':len(rows),'episodes':len(set(x['group'] for x in rows)),'mean_return_pct':float(p.mean()),'sum_pnl_usd':float(p.sum()),'mean_R':float(r.mean()),'profit_factor':float(gain/loss) if loss else None,'wins':int((p>0).sum()),'days':len(set(x['group_time'][:10] for x in rows))}

def prediction_metrics(rows):
    y=np.array([r['return_pct'] for r in rows]);p=np.array([r['prediction_pct'] for r in rows]);w=group_weights(rows);mse=np.average((y-p)**2,weights=w);var=np.average((y-np.average(y,weights=w))**2,weights=w)
    return {'n':len(y),'MAE_pp':float(np.average(abs(y-p),weights=w)),'RMSE_pp':float(np.sqrt(mse)),'R2':float(1-mse/var) if var else None,'sign_accuracy_pct':float(np.average((y>0)==(p>0),weights=w)*100)}

def fold_start(meta):
    date=dt.datetime.fromisoformat(meta['group_time'].replace('Z','+00:00')).replace(hour=0,minute=0,second=0,microsecond=0)
    if meta['period']!='recent':date-=dt.timedelta(days=date.weekday())
    return int(date.timestamp()*1000)

def main():
    lock=json.loads((HERE/'experiment-lock.json').read_text())
    for file,sha in lock['files'].items():assert hashlib.sha256((HERE/file).read_bytes()).hexdigest()==sha,file
    data=np.load(HERE/'features.npz');X=data['X'];names=data['feature_names'].tolist();meta=json.loads((HERE/'entry-metadata.json').read_text());source=csvrows(HERE/'trades.csv')
    original={(r['key'],int(r['slippage_bps_per_side'])):r for r in source}
    y=np.array([float(original[(m['key'],0)]['return_pct']) for m in meta]);R=np.array([float(original[(m['key'],0)]['R']) for m in meta]);label=np.array([ms(original[(m['key'],0)]['exit_time'])+65000 for m in meta])
    groups=collections.defaultdict(list)
    for i,m in enumerate(meta):groups[m['group']].append(i)
    group_end={g:max(label[ids]) for g,ids in groups.items()};starts=np.array([fold_start(m) for m in meta]);all_predictions=[];folds=[];selection_log=[];fold_keys=[]
    news_observed=X[:,names.index('mappednews_available')]==1
    for experiment in ['all_history','news_window']:
        allowed=np.ones(len(meta),dtype=bool) if experiment=='all_history' else np.array([m['period']=='recent' for m in meta])&news_observed
        for start in sorted(set(starts[allowed])):
            test=np.flatnonzero((starts==start)&allowed);purge=start-120*60000
            tr=np.array([i for i,m in enumerate(meta) if allowed[i] and ms(m['group_time'])<start and group_end[m['group']]<purge],dtype=int)
            tg={meta[i]['group'] for i in tr};vg={meta[i]['group'] for i in test}
            if len(tg)<80 or len(tr)<120:
                folds.append({'experiment':experiment,'start':iso(start),'status':'warmup','train_rows':len(tr),'train_episodes':len(tg),'test_rows':len(test)});continue
            assert not tg.intersection(vg);assert label[tr].max()<purge;assert all(ms(meta[i]['cutoff'])>=start for i in test)
            t0=time.time();tm=[meta[i] for i in tr];w=group_weights(tm,start);means=mode_means(X[tr],y[tr],w,names)
            corr,audit,mapping,_,_=correlation_filter(X[tr],names);rel,rd=relevance_filter(X[tr],y[tr],tm,label[tr],names,corr,mapping)
            cn,an,mn,_,_=correlation_filter(X[tr],names,exclude_news=True);rn,rnd=relevance_filter(X[tr],y[tr],tm,label[tr],names,cn,mn,exclude_news=True)
            cols={'historical_mean':[],'wide_nonlinear':wide_columns(X[tr],names),'correlation_reduced':corr,'relevance_reduced':rel,'relevance_no_news':rn}
            for kind,columns in cols.items():
                model=fit_estimator(X[tr],y[tr],w,columns);prediction=predict_model(model,X[test],columns,means,names)
                assert np.isfinite(prediction).all()
                for i,p in zip(test,prediction):
                    m=meta[i];all_predictions.append({**m,'experiment':experiment,'fold_start':iso(start),'model':kind,'prediction_pct':float(p),'selected':bool(p>0),'return_pct':float(y[i]),'R':float(R[i]),'latest_training_label':iso(int(label[tr].max())),'training_cutoff':iso(purge),'feature_count':len(columns),'news_observed':bool(news_observed[i]),'spot_observed':bool(X[i,names.index('spot_available')]==1),'gap_affected':original[(m['key'],0)]['gap_affected']=='True'})
            record={'experiment':experiment,'start':iso(start),'status':'evaluated','train_rows':len(tr),'train_episodes':len(tg),'test_rows':len(test),'test_episodes':len(vg),'latest_training_label':iso(int(label[tr].max())),'purge_cutoff':iso(purge),'dimensions':{k:len(v) for k,v in cols.items()},'elapsed_seconds':round(time.time()-t0,2)}
            folds.append(record);selection_log.append({'experiment':experiment,'start':iso(start),'correlation_removals':audit,'relevance':rd,'no_news_relevance':rnd});fold_keys.append({'experiment':experiment,'start':iso(start),'train_keys':[meta[i]['key'] for i in tr],'test_keys':[meta[i]['key'] for i in test]})
            print(json.dumps(record),flush=True)
    assert all_predictions
    results=[]
    for exp in ['all_history','news_window']:
      for model in MODELS:
       for cohort in ['all','recent','strict','original','excluding_INIT','complete_path','spot_covered']:
        for mode in ['both','continuation','immediate']:
            rows=[r for r in all_predictions if r['experiment']==exp and r['model']==model and (mode=='both' or r['mode']==mode)
                  and (cohort!='recent' or r['period']=='recent') and (cohort!='strict' or 'strict' in r['cohorts'])
                  and (cohort!='original' or r['original_entry']=='True') and (cohort!='excluding_INIT' or r['symbol']!='INIT')
                  and (cohort!='complete_path' or not r['gap_affected']) and (cohort!='spot_covered' or r['spot_observed'])]
            if not rows:continue
            selected=[r for r in rows if r['selected']];sensitivity={}
            for slip in [0,5,10]:
                adjusted=[];missing=0
                for r in selected:
                    old=original.get((r['key'],slip))
                    if old:adjusted.append({**r,'return_pct':float(old['return_pct']),'R':float(old['R'])})
                    else:missing+=1
                sensitivity[str(slip)]={'performance':metrics(adjusted),'missing_original_execution':missing}
            results.append({'experiment':exp,'model':model,'cohort':cohort,'mode':mode,'prediction':prediction_metrics(rows),'all_candidates':metrics(rows),'selected':metrics(selected),'slippage':sensitivity})
    writecsv('predictions.csv',all_predictions);save('results.json',{'results':results,'folds':folds,'warnings':['Previously studied recent sample; no pristine prospective holdout.','Alternative entry variants overlap; aggregate sums are not an executable compounded portfolio.','Feature removal is about measured predictive support, not proof of causal irrelevance.']});save('selection-audit.json',selection_log);save('fold-audit.json',fold_keys)
    # Final diagnostic correlation and fitted research artifact; never used to score earlier outer folds.
    final_at=max(label)+1;w=group_weights(meta,final_at);means=mode_means(X,y,w,names);corr,audit,mapping,rho,eligible=correlation_filter(X,names)
    rel,detail=relevance_filter(X,y,meta,label,names,corr,mapping);model=fit_estimator(X,y,w,rel)
    artifact={'model':model,'columns':rel,'means':means,'feature_names':names,'spec':SPEC,'trained_through':iso(int(max(label))),'research_only':True}
    joblib.dump(artifact,HERE/'reduced-research-model.joblib',compress=3)
    save('final-selection.json',{'candidate_dimensions':len(names),'eligible_before_correlation':len(eligible),'correlation_representatives':len(corr),'final_selected':[names[i] for i in rel],'removed':audit,'relevance':detail})
    writecsv('feature-removals.csv',[{'feature':names[i],'status':'selected' if i in rel else 'correlation_representative_not_stably_predictive' if i in corr else next((r['reason'] for r in audit if r['feature']==names[i]),'unavailable'),'representative':names[mapping[i]] if i in mapping else '', 'family':names[i].split('_')[0]} for i in range(len(names))])
    if eligible:
        z=X[:,eligible];med=np.nanmedian(z,axis=0);z=np.where(np.isfinite(z),z,med);pearson=np.corrcoef(z,rowvar=False);pairs=[]
        for a in range(len(eligible)):
            for b in range(a+1,len(eligible)):
                if abs(rho[a,b])>=.85:pairs.append({'feature_a':names[eligible[a]],'feature_b':names[eligible[b]],'spearman':float(rho[a,b]),'pearson':float(pearson[a,b]),'basis':'Full-history descriptive, training-median imputed; not used for earlier fold decisions'})
        pairs.sort(key=lambda r:-abs(r['spearman']));writecsv('correlated-pairs.csv',pairs)
        np.savez_compressed(HERE/'correlation-matrices.npz',spearman=rho,pearson=pearson,feature_names=np.array([names[i] for i in eligible]))
    associations=[]
    for i,name in enumerate(names):
        valid=np.isfinite(X[:,i]);n=int(valid.sum())
        if n<30 or len(np.unique(X[valid,i]))<2:continue
        xp=X[valid,i];yp=y[valid];rp=R[valid]
        associations.append({'feature':name,'observed_rows':n,'pearson_return':float(np.corrcoef(xp,yp)[0,1]),'spearman_return':float(np.corrcoef(rankdata(xp),rankdata(yp))[0,1]),'spearman_R':float(np.corrcoef(rankdata(xp),rankdata(rp))[0,1]),'basis':'Descriptive full-history association, not causal evidence or a selection rule'})
    writecsv('target-associations.csv',sorted(associations,key=lambda x:-abs(x['spearman_return'])))
    save('training-validation.json',{'experiments':['all_history','news_window'],'evaluated_folds':sum(r['status']=='evaluated' for r in folds),'prediction_rows':len(all_predictions),'event_overlap_violations':0,'outer_training_label_violations':0,'candidate_dimensions':len(names),'final_correlation_dimensions':len(corr),'final_relevance_dimensions':len(rel),'final_selected':[names[i] for i in rel]})
    for r in results:
        if r['cohort']=='all' and r['mode']=='both':print(json.dumps({k:r[k] for k in ['experiment','model','prediction','selected']}),flush=True)
if __name__=='__main__':main()
