"""Causal five-minute exits and one-position chronological entry replay."""
from model_two import *
def exit_paths(d,model,pre,entries,threshold):
    entries=np.asarray(entries,int);n=len(entries);steps=np.full(n,H,int);done=np.zeros(n,bool);hi=d.state['price'][entries].copy();lo=hi.copy();last_score=np.full(n,np.nan)
    for t in range(1,H):
        active=np.flatnonzero(~done)
        if not len(active):break
        rows=entries[active]+t;close=d.state['close'][rows];hi[active]=np.maximum(hi[active],np.where(np.isfinite(close),close,-np.inf));lo[active]=np.minimum(lo[active],np.where(np.isfinite(close),close,np.inf));x=d.exit_rows(entries[active],rows,hi[active],lo[active]);score=model.predict(pre.transform(x));last_score[active]=score;fill=np.isfinite(d.state['price'][rows]);leave=(score>=threshold)&fill;selected=active[leave];steps[selected]=t;done[selected]=True
    prices=d.state['price'][entries+steps].copy();times=d.times[entries+steps]+55000;terminal=steps==H;prices[terminal]=d.state['terminal_price'][entries[terminal]];times[terminal]=d.state['terminal_time'][entries[terminal]];valid=np.isfinite(prices)&(times>0);profit=np.where(valid,100*(prices/d.state['price'][entries]-1),np.nan)
    return {'steps':steps,'exit_time':times,'profit':profit,'valid':valid}
def entries_scores(d,artifact,ids):return predict(artifact['model'],artifact['preprocess'],d.entry_rows(ids))
def continuous_replay(d,entry_art,exit_art,start,end,entry_threshold,exit_threshold,policy='two_stage',fixed_exit=False):
    source_end=np.array([ms(c['end']) for c in d.catalog],np.int64);ids=d.eligible[(d.times[d.eligible]>=start)&(d.times[d.eligible]<end-1472*MIN)&(d.times[d.eligible]<source_end[d.state['series'][d.eligible]]-1472*MIN)];scores=entries_scores(d,entry_art,ids);signal=ids[(scores>=entry_threshold)&np.isfinite(d.state['price'][ids])];busy={};rows=[]
    if fixed_exit:
        p=d.state['terminal_price'][signal];times=d.state['terminal_time'][signal];outs={'steps':np.full(len(signal),H),'exit_time':times,'profit':100*(p/d.state['price'][signal]-1),'valid':np.isfinite(p)&(times>0)}
    else:outs=exit_paths(d,exit_art['model'],exit_art['preprocess'],signal,exit_threshold) if len(signal) else None
    # Every possible signal's exit is independent of other symbols. Occupancy then
    # admits only signals visible while flat; future outcomes never choose entries.
    for j in np.argsort(d.times[signal],kind='stable'):
        entry=int(signal[j]);sid=int(d.state['series'][entry]);c=d.catalog[sid];symbol=c['symbol'];at=int(d.times[entry]);fill=at+55000
        if at<=busy.get(symbol,-1):continue
        valid=bool(outs['valid'][j]);exit_time=int(outs['exit_time'][j]) if valid else fill+1470*MIN;busy[symbol]=exit_time
        rows.append({'policy':policy,'symbol':symbol,'period':c['period'],'entry_index':entry,'entry_time':iso(fill),'exit_time':iso(exit_time),'holding_minutes':(exit_time-fill)/MIN,'exit_step':int(outs['steps'][j]),'return_pct':float(outs['profit'][j]) if valid else None,'scored':valid,'teacher_good_entry':bool(d.state['target'][entry]==1),'target_mature':bool(d.state['mature'][entry]),'news_feed_available':bool(d.news[entry,d.news_names.index('news_feed_available')]),'entry_score':float(scores[np.searchsorted(ids,entry)])})
    return rows
def fixed_exit_same_entries(d,rows):
    out=[]
    for r in rows:
        e=r['entry_index'];p=d.state['terminal_price'][e];at=int(d.state['terminal_time'][e]);valid=np.isfinite(p) and at>0;out.append({**r,'policy':'same_entries_fixed24h','exit_step':H,'exit_time':iso(at) if valid else r['entry_time'],'holding_minutes':(at-(int(d.times[e])+55000))/MIN if valid else None,'return_pct':float(100*(p/d.state['price'][e]-1)) if valid else None,'scored':bool(valid)})
    return out
def totals(rows):
    good=[r for r in rows if r['scored']];p=np.array([r['return_pct'] for r in good]);return {'trades':len(rows),'scored_trades':len(good),'censored_trades':len(rows)-len(good),'gross_profit_usd':float(p.sum()),'mean_return_pct':float(p.mean()) if len(p) else None,'win_rate_pct':float(100*(p>0).mean()) if len(p) else None,'median_holding_minutes':float(np.median([r['holding_minutes'] for r in good])) if good else None,'deadline_trades':sum(r['exit_step']==H for r in good)}
