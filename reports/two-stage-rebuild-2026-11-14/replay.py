"""Side-aware chronological replay; occupancy decided without future outcomes."""
from model import *

def exit_paths(d,model,pre,candidates,threshold):
    candidates=np.asarray(candidates,int);entries,side=decode(candidates);n=len(entries)
    steps=np.full(n,H,int);done=np.zeros(n,bool);hi=d.state['price'][entries].copy();lo=hi.copy()
    for t in range(1,H):
        active=np.flatnonzero(~done)
        if not len(active):break
        rows=entries[active]+t;close=d.state['close'][rows]
        hi[active]=np.maximum(hi[active],np.where(np.isfinite(close),close,-np.inf));lo[active]=np.minimum(lo[active],np.where(np.isfinite(close),close,np.inf))
        x=d.exit_rows(candidates[active],rows,hi[active],lo[active]);score=model.predict(pre.transform(x))
        selected=active[(score>=threshold)&np.isfinite(d.state['price'][rows])]
        steps[selected]=t;done[selected]=True
    prices=d.state['price'][entries+steps].copy();times=d.state['time'][entries+steps]+55000
    terminal=steps==H;prices[terminal]=d.state['terminal_price'][entries[terminal]];times[terminal]=d.state['terminal_time'][entries[terminal]]
    valid=np.isfinite(prices)&(times>0)
    profit=np.where(valid,side*100*(prices/d.state['price'][entries]-1),np.nan)
    return {'steps':steps,'exit_time':times,'profit':profit,'valid':valid}

def entries_scores(d,artifact,ids):return predict(artifact['model'],artifact['preprocess'],d.entry_rows(ids))

def continuous_replay(d,entry_art,exit_art,start,end,entry_threshold,exit_threshold,policy='two_stage',fixed_exit=False):
    source_end=np.array([ms(c['end']) for c in d.catalog],np.int64)
    ids=d.eligible[(d.state['time'][d.eligible]>=start)&(d.state['time'][d.eligible]<end-1472*MIN)&
                   (d.state['time'][d.eligible]<source_end[d.state['series'][d.eligible]]-1472*MIN)]
    candidates=np.stack([ids*2,ids*2+1],axis=1).reshape(-1)
    scores=entries_scores(d,entry_art,candidates).reshape(-1,2)
    choice=np.argmax(scores,axis=1);best=scores[np.arange(len(ids)),choice]
    accept=(best>=entry_threshold)&(scores[:,0]!=scores[:,1])&np.isfinite(d.state['price'][ids])
    signal=ids[accept]*2+choice[accept];chosen_scores=best[accept];entries,side=decode(signal)
    if fixed_exit:
        p=d.state['terminal_price'][entries];times=d.state['terminal_time'][entries]
        outs={'steps':np.full(len(signal),H),'exit_time':times,'profit':side*100*(p/d.state['price'][entries]-1),'valid':np.isfinite(p)&(times>0)}
    else:outs=exit_paths(d,exit_art['model'],exit_art['preprocess'],signal,exit_threshold) if len(signal) else None
    busy={};rows=[]
    for j in np.argsort(d.state['time'][entries],kind='stable'):
        e=int(entries[j]);candidate=int(signal[j]);sid=int(d.state['series'][e]);c=d.catalog[sid];symbol=c['symbol'];at=int(d.state['time'][e]);fill=at+55000
        if at<=busy.get(symbol,-1):continue
        valid=bool(outs['valid'][j]);exit_time=int(outs['exit_time'][j]) if valid else fill+1440*MIN
        busy[symbol]=exit_time if valid else ms(c['end'])
        rows.append({'policy':policy,'symbol':symbol,'side':'long' if side[j]==1 else 'short','side_sign':int(side[j]),'period':c['period'],
                     'candidate_id':candidate,'entry_index':e,'entry_time':iso(fill),'exit_time':iso(exit_time),'holding_minutes':(exit_time-fill)/MIN,
                     'exit_step':int(outs['steps'][j]),'return_pct':float(outs['profit'][j]) if valid else None,'scored':valid,
                     'teacher_good_entry':bool(d.target[candidate]==1),'target_mature':bool(d.state['mature'][e]),
                     'news_feed_available':bool(d.news_values(np.array([e]),'news_feed_available')[0]>0),
                     'relevant_news_events':float(d.news_values(np.array([e]),'news_events_24h')[0]) if d.news_values(np.array([e]),'news_feed_available')[0]>0 else None,
                     'entry_score':float(chosen_scores[j])})
    return rows

def totals(rows):
    good=[r for r in rows if r['scored']];p=np.array([r['return_pct'] for r in good])
    return {'trades':len(rows),'scored_trades':len(good),'censored_trades':len(rows)-len(good),'data_complete':len(rows)==len(good),
            'gross_profit_usd':float(p.sum()) if len(rows)==len(good) else None,'priced_trades_gross_profit_usd':float(p.sum()),
            'mean_return_pct':float(p.mean()) if len(p) else None,'win_rate_pct':float(100*(p>0).mean()) if len(p) else None,
            'median_holding_minutes':float(np.median([r['holding_minutes'] for r in good])) if good else None,
            'deadline_trades':sum(r['exit_step']==H for r in good)}
