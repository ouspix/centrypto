from price_common import *
import price_network  # Pickled class registration.
import joblib,time
from repair_replay import models_for,exit_predictions_all,block_bound,cash
from repair_network import predict as score
from engine import replay,totals

def prepare(data,old,new,start,end,key):
    path=CACHE/'replays'/f'{key}-prepared.joblib'
    if path.exists():return joblib.load(path)
    prepared={name:[{} for _ in range(4)] for name in ['current','price_error']}
    for sign,side in [(1,'long'),(-1,'short')]:
        ids=data.replay_ids(start,end,sign,quality=True);raw=data.entry_rows(ids)
        scores={}
        for name,models in [('current',old),('price_error',new)]:
            v=np.array([score(m[side]['entry'],raw) for m in models]);scores[name]=np.vstack([v,v.mean(axis=0)])
        keep=np.logical_or.reduce([v.max(axis=0)>=min(CFG['entry_thresholds']) for v in scores.values()])
        ids=ids[keep];entries=np.unique(data.c['row'][ids]);started=time.time()
        # Exactly the same frozen exit predictions serve both entry methods.
        exits=exit_predictions_all(data,[m[side]['exit'] for m in old],entries,sign,[CFG['fixed_exit_threshold']],True)
        for name,values in scores.items():
            for k in range(4):prepared[name][k][side]={'ids':ids,'score':values[k,keep],'exits':exits[k],'thresholds':[CFG['fixed_exit_threshold']]}
        print(json.dumps({'prepared':key,'side':side,'exit_entries':len(entries),'seconds':round(time.time()-started,2)}),flush=True)
    path.parent.mkdir(exist_ok=True);joblib.dump(prepared,path,compress=3)
    return prepared

def run(data,prepared,policy,fold,name):
    rows,meta=replay(data,prepared,policy,fold,name)
    for t in rows:
        e=int(t['entry_index']);t['entry_price']=float(data.d.state['price'][e]) if np.isfinite(data.d.state['price'][e]) else None
        if t['entry_price'] is None:t['scored']=False;t['return_pct']=None
        ep=data.by_setup.get(t['setup_id'])
        t['target_scorable']=ep is not None
        if ep is not None:
            target=data.episodes[ep]
            t['target_price']=target['target_price'];t['target_qualifies']=target['qualifies']
            t['normalized_absolute_price_error_pct']=abs(t['entry_price']-target['target_price'])/target['target_price']*100 if t['entry_price'] else None
    return rows,meta

def select(data,prepared,p,days):
    policies={};trials={}
    for side in ['long','short']:
        best=cash();value=0.;trials[side]=[]
        for threshold in CFG['entry_thresholds']:
            policy={s:cash() for s in ['long','short']}
            policy[side]={'cash':False,'entry_threshold':threshold,'exit_threshold':CFG['fixed_exit_threshold']}
            trades,_=run(data,prepared[-1],policy,p['start'],'validation')
            bound=block_bound(trades,days)
            members=[totals(run(data,m,policy,p['start'],'validation')[0]) for m in prepared[:-1]]
            valid=bound['pass'] and all(m['censored']==0 and m['gross_pnl_usd']>0 for m in members)
            trials[side].append({'policy':policy[side],'bound':bound,'members':members})
            if valid and bound['lower_bound']>value:best=policy[side];value=bound['lower_bound']
        policies[side]=best
    combinations=[policies,{'long':policies['long'],'short':cash()},{'long':cash(),'short':policies['short']}]
    best={s:cash() for s in ['long','short']};value=0.;joint=[]
    for policy in combinations:
        trades,_=run(data,prepared[-1],policy,p['start'],'validation');bound=block_bound(trades,days)
        members=[totals(run(data,m,policy,p['start'],'validation')[0]) for m in prepared[:-1]]
        valid=bound['pass'] and all(m['censored']==0 and m['gross_pnl_usd']>0 for m in members)
        joint.append({'policy':policy,'bound':bound,'members':members})
        if valid and bound['lower_bound']>value:best=policy;value=bound['lower_bound']
    return best,{'sides':trials,'joint':joint}

def entry_diagnostics(data,p,models,policy,variant):
    output=[];details=[]
    for sign,side in [(1,'long'),(-1,'short')]:
        eids=data.episode_ids(p,'test',sign)
        if not len(eids):continue
        ids=np.concatenate([data.episodes[i]['ids'] for i in eids]);raw=data.entry_rows(ids)
        predictions=np.array([score(m[side]['entry'],raw) for m in models]).mean(axis=0)
        cursor=0
        for mode in ['selected_policy','fixed_training_percentile_90']:
            cursor=0;records=[]
            threshold=policy[side]['entry_threshold'] if mode=='selected_policy' else .9
            disabled=policy[side]['cash'] if mode=='selected_policy' else False
            for eid in eids:
                e=data.episodes[eid];n=len(e['ids']);v=predictions[cursor:cursor+n];cursor+=n
                hits=np.flatnonzero(v>=threshold) if not disabled else np.array([],int)
                k=int(hits[0]) if len(hits) else None
                distance=float(e['distance'][k]) if k is not None else None
                cost=float(e['costs'][k]) if k is not None else e['skip_cost']
                records.append({'fold':p['start'],'variant':variant,'mode':mode,'setup':e['setup'],'side':side,
                    'symbol':data.d.catalog[e['series']]['symbol'],'day':iso(e['start'])[:10],
                    'qualifies':e['qualifies'],'entered':k is not None,'normalized_absolute_price_error':distance,
                    'cost':cost,'target_gain':e['best_gain'],
                    'entry_id':int(e['ids'][k]) if k is not None else None,'target_id':e['target_id']})
            successful=[r for r in records if r['qualifies']];failed=[r for r in records if not r['qualifies']]
            taken=[r for r in successful if r['entered']]
            grouped={}
            for r in records:grouped.setdefault((r['symbol'],r['day']),[]).append(r['cost'])
            output.append({'fold':p['start'],'variant':variant,'side':side,'mode':mode,
                'setups':len(records),'qualifying_setups':len(successful),'failed_setups':len(failed),
                'entered_qualifying':len(taken),'entered_failed':sum(r['entered'] for r in failed),
                'price_error_pct':100*float(np.mean([r['normalized_absolute_price_error'] for r in taken])) if taken else None,
                'mean_cost':float(np.mean([r['cost'] for r in records])),
                'symbol_day_mean_cost':float(np.mean([np.mean(v) for v in grouped.values()]))})
            details.extend(records)
    return output,details

def main():
    locked={n:file_hash(HERE/n) for n in ['config.json','price_common.py','price_network.py','replay_price.py']}
    if (HERE/'replay-lock.json').exists():assert json.loads((HERE/'replay-lock.json').read_text())==locked
    else:write('replay-lock.json',locked)
    data=PriceData();records=[];diagnostics=[];detail=[]
    for p in PLANS:
        fold=p['start'][:10];dest=CACHE/'replays'/f'{fold}-results.json'
        if dest.exists():
            saved=json.loads(dest.read_text());records.extend(saved['records']);diagnostics.extend(saved['diagnostics']);detail.extend(saved['detail']);continue
        old=models_for(fold);new=[]
        for seed,m in zip(SEEDS,old):
            new.append({side:{'entry':joblib.load(CACHE/'models'/fold/f'{side}_entry_{seed}.joblib'),'exit':m[side]['exit']} for side in ['long','short']})
        validation=prepare(data,old,new,ms(p['validation_start']),ms(p['start'])-1440*MIN,fold+'-validation')
        ids=data.replay_ids(ms(p['validation_start']),ms(p['start'])-1440*MIN,quality=True)
        days=sorted({iso(int(t)+55000)[:10] for t in data.d.state['time'][data.c['row'][ids]]})
        newpolicy,trials=select(data,validation['price_error'],p,days)
        oldpolicy=json.loads((REPAIR/'selection'/f'{fold}.json').read_text())['ensemble']
        assert all(v['cash'] or v['exit_threshold']==CFG['fixed_exit_threshold'] for v in oldpolicy.values())
        write(f'selection/{fold}.json',{'current':oldpolicy,'price_error':newpolicy,'validation_only_trials':trials})
        # Policy is written/frozen before any test predictions or outcomes are inspected.
        test=prepare(data,old,new,ms(p['start']),ms(p['end']),fold+'-test')
        foldrecords=[];fd=[];dd=[]
        for variant,models,policy in [('current',old,oldpolicy),('price_error',new,newpolicy)]:
            for member in range(4):
                rows,meta=run(data,test[variant][member],policy,p['start'],variant)
                record={'fold':p['start'],'variant':variant,'seed':SEEDS[member] if member<3 else None,
                    'policy':policy,'stats':{**totals(rows),**meta},'by_side':{s:totals([r for r in rows if r['side']==s]) for s in ['long','short']},'trades':rows}
                foldrecords.append(record)
            summary,events=entry_diagnostics(data,p,models,policy,variant);fd.extend(summary);dd.extend(events)
        # Validate frozen baseline parity on exact candidate IDs, fills, and returns.
        previous=json.loads((REPAIR_CACHE/'replays'/f'{fold}.json').read_text())['records']
        prior=next(r for r in previous if r['variant']=='repaired_ensemble')
        now=next(r for r in foldrecords if r['variant']=='current' and r['seed'] is None)
        assert [(t['candidate_id'],t['exit_time']) for t in prior['trades']]==[(t['candidate_id'],t['exit_time']) for t in now['trades']]
        np.testing.assert_allclose([t['return_pct'] for t in prior['trades']],[t['return_pct'] for t in now['trades']],rtol=1e-12)
        write(str(dest.relative_to(CACHE)),{'records':foldrecords,'diagnostics':fd,'detail':dd},True)
        records.extend(foldrecords);diagnostics.extend(fd);detail.extend(dd)
        write('replay-progress.json',{'fold':fold,'folds_complete':len(records)//8,'ensemble':[{'variant':r['variant'],'stats':r['stats']} for r in foldrecords if r['seed'] is None]})
        print(json.dumps({'fold_complete':fold,'ensemble':[{k:r[k] for k in ['variant','stats']} for r in foldrecords if r['seed'] is None]}),flush=True)
    write('results.json',records);write('entry-diagnostics.json',diagnostics);write('entry-details.json',detail,True)

if __name__=='__main__':
    with threadpool_limits(limits=1):main()
