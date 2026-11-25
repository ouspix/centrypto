"""Dimension reduction is fitted inside each chronological training window."""
import collections,math
import numpy as np
from scipy.stats import rankdata
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.feature_selection import mutual_info_regression
from threadpoolctl import threadpool_limits
from common import SPEC,ms

NEWS_FAMILIES={'news','mappednews','whale'}
def administrative(name):
    return any(x in name for x in ['coverage_','_available','_observed_symbols_','snapshot_count','tick_age_seconds','quote_age_seconds','quote_fraction_'])

def group_weights(meta,at=None):
    counts=collections.Counter(m['group'] for m in meta)
    w=np.array([1/counts[m['group']] for m in meta])
    if at is not None:
        age=np.array([(at-ms(m['group_time']))/86400000 for m in meta]);w*=2**(-np.maximum(age,0)/60)
        w*=len(counts)/w.sum()
    return w

def fit_estimator(X,y,w,cols):
    if not len(cols):return None
    with threadpool_limits(limits=1):
        model=HistGradientBoostingRegressor(**SPEC['evaluation']['nonlinear']).fit(X[:,cols],y,sample_weight=w)
    return model

def predict_model(model,X,cols,means,names):
    if model is None:
        mode=names.index('setup_continuation');return np.array([means[int(r[mode])] for r in X])
    with threadpool_limits(limits=1):return model.predict(X[:,cols])

def mode_means(X,y,w,names):
    column=names.index('setup_continuation');fallback=float(np.average(y,weights=w));out={}
    for mode in [0,1]:
        mask=X[:,column]==mode;out[mode]=float(np.average(y[mask],weights=w[mask])) if mask.any() else fallback
    return out

def wide_columns(X,names):
    return [i for i,n in enumerate(names) if np.isfinite(X[:,i]).sum()>=10 and len(np.unique(X[np.isfinite(X[:,i]),i]))>1]

def correlation_filter(X,names,exclude_news=False):
    audit=[];eligible=[];coverage={};minimum=max(30,math.ceil(.2*len(X)))
    for i,name in enumerate(names):
        observed=X[np.isfinite(X[:,i]),i];coverage[i]=len(observed);reason=None
        if exclude_news and (name.split('_')[0] in NEWS_FAMILIES or name=='interaction_news_spot_flow'):reason='news_ablation'
        elif administrative(name):reason='collection_process_metadata'
        elif len(observed)<minimum:reason='insufficient_observed_history'
        else:
            unique,counts=np.unique(observed,return_counts=True)
            if len(unique)<2:reason='constant'
            elif counts.max()/len(observed)>=.99 and name!='setup_continuation':reason='near_constant'
        if reason:audit.append({'feature':name,'reason':reason,'observed':len(observed),'required_observed':minimum})
        else:eligible.append(i)
    if not eligible:return [],audit,{},np.empty((0,0)),[]
    Z=X[:,eligible].copy();med=np.nanmedian(Z,axis=0);Z=np.where(np.isfinite(Z),Z,med)
    ranked=rankdata(Z,axis=0);rho=np.corrcoef(ranked,rowvar=False)
    if len(eligible)==1:rho=np.array([[1.]])
    position={c:i for i,c in enumerate(eligible)};order=sorted(eligible,key=lambda i:(names[i]!='setup_continuation',-coverage[i],len(names[i]),names[i]))
    keep=[];representative={}
    for col in order:
        matches=[k for k in keep if abs(rho[position[col],position[k]])>=.90]
        if matches:
            rep=max(matches,key=lambda k:abs(rho[position[col],position[k]]));representative[col]=rep
            audit.append({'feature':names[col],'reason':'redundant','representative':names[rep],'spearman':float(rho[position[col],position[rep]]),'observed':coverage[col]})
        else:keep.append(col);representative[col]=col
    return keep,audit,representative,rho,eligible

def inner_windows(meta,label_available):
    groups=sorted(set(m['group'] for m in meta),key=lambda g:min(ms(m['group_time']) for m in meta if m['group']==g));end={g:max(label_available[i] for i,m in enumerate(meta) if m['group']==g) for g in groups}
    windows=[]
    for left,right in [(0.50,0.67),(.67,.84),(.84,1.0)]:
        a=int(len(groups)*left);b=int(len(groups)*right);valid_groups=set(groups[a:b])
        if not valid_groups:continue
        start=min(ms(m['group_time']) for m in meta if m['group'] in valid_groups);purge=start-120*60000
        train_groups={g for g in groups[:a] if end[g]<purge};tr=np.array([i for i,m in enumerate(meta) if m['group'] in train_groups],dtype=int);va=np.array([i for i,m in enumerate(meta) if m['group'] in valid_groups],dtype=int)
        if len(tr)>=80 and len(train_groups)>=50 and len(valid_groups)>=15:windows.append((tr,va,start,purge))
    return windows

def relevance_filter(X,y,meta,label_available,names,outer_reps,outer_mapping,exclude_news=False):
    by_rep=collections.defaultdict(list);windows=[]
    for number,(tr,va,start,purge) in enumerate(inner_windows(meta,label_available)):
        inner_reps,_,_,_,_=correlation_filter(X[tr],names,exclude_news=exclude_news)
        if not inner_reps:continue
        # Nonlinear screening on training episodes, not repeated entry variants.
        gs=collections.defaultdict(list)
        for i in tr:gs[meta[i]['group']].append(i)
        z=[];target=[]
        for ids in gs.values():
            v=X[np.ix_(ids,inner_reps)];obs=np.isfinite(v);sums=np.where(obs,v,0).sum(axis=0);counts=obs.sum(axis=0)
            z.append(np.divide(sums,counts,out=np.full(len(inner_reps),np.nan),where=counts>0));target.append(float(np.mean(y[ids])))
        Z=np.array(z);med=np.nanmedian(Z,axis=0);Z=np.where(np.isfinite(Z),Z,med)
        with threadpool_limits(limits=1):mi=mutual_info_regression(Z,np.array(target),random_state=20261113+number,n_neighbors=5)
        order=np.argsort(-mi,kind='stable');candidates=[inner_reps[i] for i in order[:40] if mi[i]>0]
        mode=names.index('setup_continuation')
        if mode in inner_reps and mode not in candidates:candidates=(candidates[:39]+[mode])
        if not candidates:continue
        w=group_weights([meta[i] for i in tr],start);vw=group_weights([meta[i] for i in va]);model=fit_estimator(X[tr],y[tr],w,candidates)
        with threadpool_limits(limits=1):base_pred=model.predict(X[np.ix_(va,candidates)])
        base_mse=float(np.average((y[va]-base_pred)**2,weights=vw));rng=np.random.default_rng(20261113+number)
        clusters=collections.defaultdict(list)
        for position,col in enumerate(candidates):
            rep=outer_mapping.get(col)
            if rep is not None:clusters[rep].append(position)
        impacts={}
        # Permute a correlated group together, within the same entry mode to retain strategy composition.
        for rep,positions in clusters.items():
            changes=[]
            for repeat in range(3):
                ztest=X[np.ix_(va,candidates)].copy();perm=np.arange(len(va))
                for mode_value in [0,1]:
                    bucket=np.flatnonzero(X[va,mode]==mode_value);perm[bucket]=rng.permutation(bucket)
                ztest[:,positions]=ztest[np.ix_(perm,positions)]
                with threadpool_limits(limits=1):p=model.predict(ztest)
                changes.append(float(np.average((y[va]-p)**2,weights=vw)-base_mse))
            value=float(np.mean(changes));by_rep[rep].append({'window':number,'mse_improvement':value,'validation_events':len(set(meta[i]['group'] for i in va))});impacts[names[rep]]=value
        windows.append({'number':number,'train_rows':len(tr),'validation_rows':len(va),'validation_start':start,'purge_cutoff':purge,'latest_training_label':int(label_available[tr].max()),'candidates':[names[i] for i in candidates],'baseline_MSE':base_mse,'importance_by_outer_representative':impacts})
    evidence=[];qualified=[]
    for col in outer_reps:
        values=by_rep.get(col,[]);positive=sum(x['mse_improvement']>1e-6 for x in values);avg=float(np.average([x['mse_improvement'] for x in values],weights=[x['validation_events'] for x in values])) if values else 0
        record={'feature':names[col],'windows_evaluated':len(values),'positive_windows':positive,'mean_inner_MSE_improvement':avg,'qualified':positive>=2 and avg>1e-6}
        evidence.append(record)
        if record['qualified']:qualified.append((col,avg))
    qualified.sort(key=lambda x:(-x[1],names[x[0]]));selected=[x[0] for x in qualified[:20]]
    mode=names.index('setup_continuation')
    if selected and mode in outer_reps and mode not in selected:selected=selected[:19]+[mode]
    return selected,{'inner_windows':windows,'evidence':evidence,'selected':[names[c] for c in selected],'economic_features':sum(names[c]!='setup_continuation' for c in selected)}
