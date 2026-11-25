from repair_data import *
from causal_candidates import CausalData
from repair_network import predict as new_predict
from network import predict as old_predict
from engine import replay, totals
import itertools, time

def models_for(fold, repaired=True):
    result=[]
    for seed in SEEDS:
        sides={}
        for side,offset in [('long',0),('short',10)]:
            sides[side]={}
            for kind,increment in [('entry',0),('exit',1)]:
                if repaired: path=CACHE/'models'/fold/f'{side}_{kind}_{seed}.joblib'
                else:
                    old=json.loads((OLD_CACHE/'runs'/f'full__{seed}__{fold}.json').read_text());key=old['models'][side+'_'+kind]['mask_key']
                    path=OLD_CACHE/'models'/fold/f'{kind}_{side}_{seed+offset+increment}_{key}.joblib'
                sides[side][kind]=joblib.load(path)
        result.append(sides)
    return result

def exit_predictions_all(data, models, entries, side, thresholds, repaired):
    n=len(entries); count=len(models)+int(repaired)
    steps=np.full((count,n,len(thresholds)),H,int); pending=np.zeros_like(steps,bool)
    reasons=np.zeros_like(steps,'i1');hi=data.d.state['price'][entries].copy();lo=hi.copy()
    predictor=new_predict if repaired else old_predict
    for t in range(1,H):
        active=np.flatnonzero((steps==H).any(axis=(0,2)))
        if not len(active):break
        rows=entries[active]+t;close=data.d.state['close'][rows]
        hi[active]=np.maximum(hi[active],np.where(np.isfinite(close),close,-np.inf));lo[active]=np.minimum(lo[active],np.where(np.isfinite(close),close,np.inf))
        raw=data.exit_rows(entries[active],rows,side,hi[active],lo[active]) if repaired else FourData.exit_rows(data,entries[active],rows,side,hi[active],lo[active])
        scores=np.array([predictor(m,raw) for m in models])
        if repaired:scores=np.vstack([scores,scores.mean(axis=0)])
        bad=~np.isfinite(raw[:,[data.exit_names.index(n) for n in EXIT_CORE]]).all(axis=1) if repaired else np.zeros(len(active),bool)
        tradable=np.isfinite(data.d.state['price'][rows])
        for m in range(count):
            for k,threshold in enumerate(thresholds):
                want=(scores[m]>=threshold)|bad
                if repaired: pending[m,active,k] |= want
                else: pending[m,active,k] = want  # Preserve frozen baseline execution semantics.
                reasons[m,active[bad & (steps[m,active,k]==H)],k]=1
                take=active[pending[m,active,k]&tradable&(steps[m,active,k]==H)]
                steps[m,take,k]=t
    output=[]
    for m in range(count):
        prices=data.d.state['price'][entries[:,None]+steps[m]].copy();times=data.d.state['time'][entries[:,None]+steps[m]]+55000
        for k in range(len(thresholds)):
            terminal=steps[m,:,k]==H;prices[terminal,k]=data.d.state['terminal_price'][entries[terminal]];times[terminal,k]=data.d.state['terminal_time'][entries[terminal]]
        valid=np.isfinite(prices)&np.isfinite(data.d.state['price'][entries,None])&(times>0);profit=side*100*(prices/data.d.state['price'][entries,None]-1)
        output.append({'entries':entries,'steps':steps[m],'time':times,'valid':valid,'return':profit,'quality_exit':reasons[m]})
    return output

def prepare_all(data, models, start, end, repaired=True, quality=True, label=''):
    count=len(models)+int(repaired);out=[{} for _ in range(count)]
    predictor=new_predict if repaired else old_predict
    entry_thresholds=CFG['entry_thresholds'] if repaired else OLD_CFG['entry_thresholds']
    exit_thresholds=CFG['exit_thresholds'] if repaired else OLD_CFG['exit_thresholds']
    for sign,side in [(1,'long'),(-1,'short')]:
        ids=data.replay_ids(start,end,sign,quality=quality);scores=[]
        for model in models:
            score=np.empty(len(ids))
            for i in range(0,len(ids),4096):
                raw=data.entry_rows(ids[i:i+4096]) if repaired else FourData.entry_rows(data,ids[i:i+4096])
                score[i:i+4096]=predictor(model[side]['entry'],raw)
            scores.append(score)
        scores=np.array(scores)
        if repaired:scores=np.vstack([scores,scores.mean(axis=0)])
        keep=scores.max(axis=0)>=min(entry_thresholds); ids=ids[keep];scores=scores[:,keep]
        entries=np.unique(data.c['row'][ids]);started=time.time()
        exits=exit_predictions_all(data,[m[side]['exit'] for m in models],entries,sign,exit_thresholds,repaired)
        for m in range(count):out[m][side]={'ids':ids,'score':scores[m],'exits':exits[m],'thresholds':exit_thresholds}
        print(json.dumps({'prepared':label,'side':side,'exit_entries':len(entries),'seconds':time.time()-started}),flush=True)
    return out

def cash():return {'cash':True,'entry_threshold':None,'exit_threshold':None}

def run(data,prepared,policies,fold,name):
    trades,meta=replay(data,prepared,policies,fold,name)
    for t in trades:
        ex=prepared[t['side']]['exits'];j=int(np.searchsorted(ex['entries'],t['entry_index']));k=prepared[t['side']]['thresholds'].index(t['exit_threshold'])
        t['quality_exit']=bool(ex['quality_exit'][j,k])
        t['unpriced_entry']=not bool(np.isfinite(data.d.state['price'][t['entry_index']]))
    return trades,meta

def block_bound(trades, days):
    if any(not t['scored'] for t in trades): return {'pass':False,'reason':'unpriced_exit','lower_bound':None}
    values=np.array([sum(t['return_pct'] for t in trades if t['entry_time'][:10]==day) for day in days])
    symbols=len({t['symbol'] for t in trades});active_days=len({t['entry_time'][:10] for t in trades})
    if len(days):
        rng=np.random.default_rng(20261115);draws=rng.choice(values,(CFG['bootstrap_draws'],len(values)),replace=True).sum(axis=1)
        lower=float(np.quantile(draws,CFG['bootstrap_tail_probability']))
    else:lower=0.
    passed=len(trades)>=CFG['minimum_validation_trades'] and active_days>=CFG['minimum_validation_days'] and symbols>=CFG['minimum_validation_symbols'] and (values>0).sum()>=np.ceil(2*len(days)/3) and lower>0
    return {'pass':bool(passed),'lower_bound':lower,'trades':len(trades),'symbols':symbols,'active_days':active_days,'available_days':len(days),'positive_days':int((values>0).sum()),'day_pnl':dict(zip(days,values.tolist()))}

def select(data,prepared,fold,days,robust):
    trials={};policies={}
    for side in ['long','short']:
        best=cash();bestvalue=0.;trials[side]=[]
        for et,xt in itertools.product(CFG['entry_thresholds'],CFG['exit_thresholds']):
            pc={s:cash() for s in ['long','short']};pc[side]={'cash':False,'entry_threshold':et,'exit_threshold':xt}
            rows,_=run(data,prepared[-1] if robust else prepared[0],pc,fold,'validation');stat=totals(rows)
            record={'entry_threshold':et,'exit_threshold':xt,**stat}
            if robust:
                bound=block_bound(rows,days);members=[totals(run(data,p,pc,fold,'validation')[0]) for p in prepared[:-1]]
                record.update(bound=bound,members=members)
                valid=bound['pass'] and all(s['censored']==0 and s['gross_pnl_usd']>0 for s in members)
                value=bound['lower_bound'] if valid else -np.inf
            else:
                value=stat['gross_pnl_usd'] if stat['censored']==0 and stat['trades']>=5 else -np.inf
            if value>bestvalue:bestvalue=value;best=pc[side].copy()
            trials[side].append(record)
        policies[side]=best
    if robust:
        # Joint check prevents separately profitable policies from failing after shared blocking.
        combinations=[policies,{'long':policies['long'],'short':cash()},{'long':cash(),'short':policies['short']}]
        best={s:cash() for s in ['long','short']};value=0.;joint=[]
        for pc in combinations:
            rows,_=run(data,prepared[-1],pc,fold,'validation');bound=block_bound(rows,days)
            members=[totals(run(data,p,pc,fold,'validation')[0]) for p in prepared[:-1]]
            valid=bound['pass'] and all(s['censored']==0 and s['gross_pnl_usd']>0 for s in members)
            joint.append({'policy':pc,'bound':bound,'members':members})
            if valid and bound['lower_bound']>value:best=pc;value=bound['lower_bound']
        policies=best;trials['joint']=joint
    return policies,trials

def main():
    locked={n:file_hash(HERE/n) for n in ['repair_replay.py','causal_candidates.py','repair_network.py','repair_data.py','config.json']}
    if (HERE/'replay-lock.json').exists():assert json.loads((HERE/'replay-lock.json').read_text())['files']==locked,'Replay implementation changed; archive earlier cache first'
    else:write('replay-lock.json',{'files':locked,'test_outcomes_never_used_by_selector':True})
    data=CausalData();records=[];write('entry-availability.json',data.restored)
    for plan in PLANS:
        fold=plan['start'][:10];path=CACHE/'replays'/f'{fold}.json'
        if path.exists():records.extend(json.loads(path.read_text())['records']);continue
        models=models_for(fold);validation=prepare_all(data,models,ms(plan['validation_start']),ms(plan['start'])-1440*MIN,label=fold+' validation')
        ids=data.replay_ids(ms(plan['validation_start']),ms(plan['start'])-1440*MIN)
        days=sorted({iso(int(t)+55000)[:10] for t in data.d.state['time'][data.c['row'][ids]]})
        ensemble,grid=select(data,validation,plan['start'],days,True)
        single=[select(data,[p],plan['start'],days,False) for p in validation[:3]]
        write('selection/'+fold+'.json',{'ensemble':ensemble,'ensemble_grid':grid,'individuals':[{'seed':s,'policy':v[0],'grid':v[1]} for s,v in zip(SEEDS,single)]})
        test=prepare_all(data,models,ms(plan['start']),ms(plan['end']),label=fold+' test')
        foldrecords=[]
        for i,seed in enumerate(SEEDS):
            for variant,pc in [('repaired_individual',single[i][0]),('repaired_shared_policy',ensemble)]:
                rows,meta=run(data,test[i],pc,plan['start'],variant)
                foldrecords.append({'fold':plan['start'],'variant':variant,'seed':seed,'policy':pc,'stats':{**totals(rows),**meta},'by_side':{s:totals([t for t in rows if t['side']==s]) for s in ['long','short']},'trades':rows})
        rows,meta=run(data,test[-1],ensemble,plan['start'],'repaired_ensemble')
        foldrecords.append({'fold':plan['start'],'variant':'repaired_ensemble','seed':None,'policy':ensemble,'stats':{**totals(rows),**meta},'by_side':{s:totals([t for t in rows if t['side']==s]) for s in ['long','short']},'trades':rows})
        del validation,test
        oldmodels=models_for(fold,False)
        oldtest=prepare_all(data,oldmodels,ms(plan['start']),ms(plan['end']),False,False,label=fold+' baseline')
        for i,seed in enumerate(SEEDS):
            old=json.loads((OLD_CACHE/'runs'/f'full__{seed}__{fold}.json').read_text());pc=old['policies']
            for gated,variant in [(False,'baseline_coverage_fixed'),(True,'baseline_same_entry_quality')]:
                prep=oldtest[i]
                if gated:
                    prep={s:{**p,'ids':p['ids'][data.core_ok[p['ids']]],'score':p['score'][data.core_ok[p['ids']]]} for s,p in prep.items()}
                rows,meta=run(data,prep,pc,plan['start'],variant)
                foldrecords.append({'fold':plan['start'],'variant':variant,'seed':seed,'policy':pc,'stats':{**totals(rows),**meta},'by_side':{s:totals([t for t in rows if t['side']==s]) for s in ['long','short']},'trades':rows})
        del oldtest
        write('replays/'+fold+'.json',{'records':foldrecords},True);records.extend(foldrecords)
        write('replay-progress.json',{'fold':fold,'completed_folds':len(records)//13,'latest':[{k:r[k] for k in ['variant','seed','stats']} for r in foldrecords]})
        print(json.dumps({'fold_complete':fold}),flush=True)
    summary=[]
    for variant in sorted({r['variant'] for r in records}):
        for seed in sorted({r['seed'] for r in records if r['variant']==variant},key=str):
            chosen=[r for r in records if r['variant']==variant and r['seed']==seed];rows=[t for r in chosen for t in r['trades']]
            summary.append({'variant':variant,'seed':seed,**totals(rows),'quality_exits':sum(t['quality_exit'] for t in rows),'unpriced_entries':sum(t['unpriced_entry'] for t in rows),'by_side':{s:totals([t for t in rows if t['side']==s]) for s in ['long','short']}})
    write('results.json',{'summary':summary,'folds':[{k:v for k,v in r.items() if k!='trades'} for r in records]});print(json.dumps(summary),flush=True)

if __name__=='__main__':
    with threadpool_limits(limits=1): main()
