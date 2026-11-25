from data_four import *
from network import predict
def entry_scores(data,artifact,ids):
    score=np.empty(len(ids))
    for i in range(0,len(ids),4096):score[i:i+4096]=predict(artifact,data.entry_rows(ids[i:i+4096]))
    return score
def exit_predictions(data,artifact,entries,side,thresholds):
    entries=np.asarray(entries,int);n=len(entries);steps=np.full((n,len(thresholds)),H,int);hi=data.d.state['price'][entries].copy();lo=hi.copy()
    for t in range(1,H):
        active=np.flatnonzero((steps==H).any(axis=1))
        if not len(active):break
        rows=entries[active]+t;close=data.d.state['close'][rows]
        hi[active]=np.maximum(hi[active],np.where(np.isfinite(close),close,-np.inf));lo[active]=np.minimum(lo[active],np.where(np.isfinite(close),close,np.inf))
        raw=data.exit_rows(entries[active],rows,side,hi[active],lo[active]);scores=predict(artifact,raw)
        tradable=np.isfinite(data.d.state['price'][rows])
        for k,threshold in enumerate(thresholds):
            take=active[(scores>=threshold)&tradable&(steps[active,k]==H)];steps[take,k]=t
    prices=data.d.state['price'][entries[:,None]+steps].copy();times=data.d.state['time'][entries[:,None]+steps]+55000
    for k in range(len(thresholds)):
        terminal=steps[:,k]==H;prices[terminal,k]=data.d.state['terminal_price'][entries[terminal]];times[terminal,k]=data.d.state['terminal_time'][entries[terminal]]
    valid=np.isfinite(prices)&(times>0);profit=side*100*(prices/data.d.state['price'][entries,None]-1)
    return {'entries':entries,'steps':steps,'time':times,'valid':valid,'return':profit}
def prepare(data,models,start,end,thresholds=None):
    result={}
    for side,name in [(1,'long'),(-1,'short')]:
        model=models[name]
        if model.get('untrained'):continue
        ids=data.replay_ids(start,end,side);score=entry_scores(data,model['entry'],ids);keep=score>=min(CFG['entry_thresholds']);ids=ids[keep];score=score[keep]
        entries=np.unique(data.c['row'][ids]);th=thresholds[name] if thresholds else CFG['exit_thresholds']
        exits=exit_predictions(data,model['exit'],entries,side,th)
        result[name]={'ids':ids,'score':score,'exits':exits,'thresholds':th}
    return result
def replay(data,prepared,policies,fold,policy_name='sma_four'):
    candidates=[]
    for name,p in prepared.items():
        choice=policies[name]
        if choice['cash']:continue
        keep=p['score']>=choice['entry_threshold'];k=p['thresholds'].index(choice['exit_threshold'])
        for cid,score in zip(p['ids'][keep],p['score'][keep]):
            c=data.c[cid];e=int(c['row']);s=int(data.d.state['series'][e]);at=int(data.d.state['time'][e]);j=int(np.searchsorted(p['exits']['entries'],e))
            candidates.append((at,s,int(cid),float(score),j,k,name))
    groups=collections.defaultdict(list)
    for item in candidates:groups[item[:2]].append(item)
    busy={};used=set();trades=[];conflicts=0
    for (at,sid),group in sorted(groups.items()):
        catalog=data.d.catalog[sid];symbol=catalog['symbol']
        if at<=busy.get(symbol,-1):continue
        group=[r for r in group if int(data.c[r[2]]['setup']) not in used]
        if not group:continue
        if len({r[-1] for r in group})>1:conflicts+=1;continue
        at,sid,cid,score,j,k,name=min(group,key=lambda r:(-r[3],int(data.c[r[2]]['pair']),r[2]))
        c=data.c[cid];e=int(c['row']);ex=prepared[name]['exits'];valid=bool(ex['valid'][j,k]);entry=at+55000;end=int(ex['time'][j,k]) if valid else entry+H*BAR
        busy[symbol]=end if valid else ms(catalog['end']);used.add(int(c['setup']))
        trades.append({'policy':policy_name,'fold':fold,'symbol':symbol,'side':name,'side_sign':int(c['side']),'period':catalog['period'],
            'candidate_id':cid,'setup_id':int(c['setup']),'pair_fast':CFG['pairs'][int(c['pair'])][0],'pair_slow':CFG['pairs'][int(c['pair'])][1],
            'detection_time':iso(int(data.setups[int(c['setup'])]['time'])),'entry_index':e,'entry_time':iso(entry),'exit_time':iso(end),
            'entry_score':score,'entry_threshold':policies[name]['entry_threshold'],'exit_threshold':policies[name]['exit_threshold'],
            'exit_step':int(ex['steps'][j,k]),'holding_minutes':(end-entry)/MIN,'scored':valid,
            'return_pct':float(ex['return'][j,k]) if valid else None,'notional_usd':CFG['notional_usd']})
    return trades,{'direction_conflicts_waited':conflicts}
def totals(rows):
    good=[r for r in rows if r['scored']];p=np.array([float(r['return_pct']) for r in good]);complete=len(good)==len(rows)
    return {'trades':len(rows),'priced':len(good),'censored':len(rows)-len(good),'gross_pnl_usd':float(p.sum()) if complete else None,
        'priced_subtotal_usd':float(p.sum()),'mean_return_pct':float(p.mean()) if len(p) else None,'wins':int((p>0).sum()),'losses':int((p<0).sum()),
        'median_holding_minutes':float(np.median([r['holding_minutes'] for r in good])) if good else None,
        'notional_hours':sum(r['holding_minutes']/60*CFG['notional_usd'] for r in rows)}
