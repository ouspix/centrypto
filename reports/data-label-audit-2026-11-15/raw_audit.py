from audit_common import *
import urllib.parse

def main():
    data=FourData()
    if (OUT/'liquidity.json').exists():return missing_audit(data)
    names=['liquidity_spread_bps','liquidity_log_min_side_usd','liquidity_imbalance'];tick_meta=[];examples=[]
    # Row-level freshness map is an audit artifact, never a replacement feature matrix.
    age=np.lib.format.open_memmap(OUT_CACHE/'tick-age-ms.npy',mode='w+',dtype='f4',shape=(len(data.d.state),));age[:]=np.nan
    for cat in data.d.catalog:
        file=BASE_CACHE/'ticks'/(cat['key']+'.json.gz')
        if not file.exists():continue
        rows=gz(file);counts=collections.Counter();first={};last={};raw_values={n:[] for n in names}
        for r in rows:
            counts['grid_rows']+=1
            if not r['ts']:counts['no_tick_within_120s']+=1;continue
            counts['matched_ticks']+=1;j=int(r['step']);cut=ms(cat['start'])+(j+1)*BAR+5000;a=cut-ms(r['ts']);age[cat['offset']+j]=a
            assert 0<=a<=120000
            cols=['bookBidPx','bookAskPx','bookBidSz','bookAskSz'];b,ask,bs,az=[r.get(k) for k in cols]
            for col in cols:
                if r.get(col) is not None:counts[col+'_observed']+=1
            prices=b is not None and ask is not None and b>0 and ask>b
            sizes=bs is not None and az is not None and bs>0 and az>0
            if prices:counts['valid_bid_ask_prices']+=1
            if prices and not sizes:counts['prices_without_valid_sizes']+=1
            if a>60000:counts['ticks_60_to_120s_old']+=1
            good=a<=60000 and prices and sizes
            if good:
                counts['usable_book']+=1;first.setdefault('usable',r['ts']);last['usable']=r['ts']
                vals=[10000*(ask-b)/((ask+b)/2),np.log1p(min(b*bs,ask*az)),(b*bs-ask*az)/(b*bs+ask*az)]
            else:vals=[np.nan]*3
            cached=data.d.market[cat['offset']+j,[data.d.market_names.index(n) for n in names]]
            assert np.allclose(vals,cached,equal_nan=True,rtol=1e-6,atol=1e-6),(cat['key'],j,vals,cached)
            for n,v in zip(names,vals):
                if np.isfinite(v):raw_values[n].append(v)
            if (prices and not sizes or good) and len([e for e in examples if e['case']==('usable' if good else 'prices_missing_sizes')])<5:
                examples.append({'case':'usable' if good else 'prices_missing_sizes','key':cat['key'],'step':j,'decision':iso(cut),'tick':r})
        tick_meta.append({'key':cat['key'],'symbol':cat['symbol'],'period':cat['period'],**dict(counts),'first_usable':first.get('usable'),'last_usable':last.get('usable'),
            'distinct_usable_values':{n:len(set(v)) for n,v in raw_values.items()}})
    age.flush();periods={}
    for period in ['apr','mayjun','recent']:
        subset=[r for r in tick_meta if r['period']==period];keys=['grid_rows','matched_ticks','no_tick_within_120s','bookBidPx_observed','bookAskPx_observed','bookBidSz_observed','bookAskSz_observed','valid_bid_ask_prices','prices_without_valid_sizes','ticks_60_to_120s_old','usable_book']
        periods[period]={k:sum(r.get(k,0) for r in subset) for k in keys}
        available=[r['first_usable'] for r in subset if r['first_usable']];periods[period]['first_usable']=min(available) if available else None
    write('liquidity.json',{'fields':names,'periods':periods,'series':tick_meta,'examples':examples,
        'checks':'Every matched tick was realigned and all three raw liquidity feature values were independently recomputed and matched to the frozen market matrix.',
        'timestamp_limit':'Tick timestamp is retained; a separate exchange-publication or collector-receipt timestamp is absent from the exported rows.'})
    missing_audit(data)

def missing_audit(data):
    import time
    runs=[]
    for p in (CACHE/'runs').glob('*.json'):
        for attempt in range(3):
            try:r=json.loads(p.read_text());break
            except json.JSONDecodeError:
                if attempt==2:
                    recovered=OUT_CACHE/'recovered-runs'/p.name
                    if recovered.exists():r=json.loads(recovered.read_text());break
                    raise AssertionError(('unreadable run',str(p),p.stat().st_size))
                time.sleep(.2)
        if not r['final']:runs.append(r)
    missing=collections.defaultdict(list)
    for r in runs:
        for t in r['trades']:
            if not t['scored']:missing[(t['period'],t['symbol'],t['entry_index'])].append({'variant':r['variant'],'seed':r['seed'],'fold':r['fold'],'trade':t})
    resolved=[];raw_cache={}
    for (period,symbol,e),occurrences in missing.items():
        cat=data.d.catalog[int(data.d.state['series'][e])];key=cat['key']
        if key not in raw_cache:
            raw=gz(BASE_CACHE/'candles'/period/(urllib.parse.quote(symbol,safe='')+'.json.gz'))['rows'];raw_cache[key]={int(r[0]):r for r in raw}
        native=raw_cache[key];t=occurrences[0]['trade'];wanted=ms(t['exit_time']);times=np.array(sorted(native));at=int(np.searchsorted(times,wanted));before=int(times[at-1]) if at else None;after=int(times[at]) if at<len(times) else None
        row=native.get(wanted)
        if row is not None:cause='source_row_exists_but_rejected_or_alignment_bug'
        elif wanted<times[0] or wanted>times[-1]:cause='outside_actual_source_coverage'
        else:cause='internal_source_gap'
        related=[{'variant':r['variant'],'seed':r['seed'],'holding_minutes':x['holding_minutes'],'scored':x['scored'],'exit_time':x['exit_time']} for r in runs for x in r['trades'] if x['entry_index']==e and x['side']==t['side']]
        resolved.append({'period':period,'symbol':symbol,'entry_index':e,'side':t['side'],'entry_time':t['entry_time'],'required_exit_time':t['exit_time'],'holding_minutes':t['holding_minutes'],
            'cause_in_frozen_source':cause,'source_exact_row':row,'first_source_time':iso(times[0]),'last_source_time':iso(times[-1]),'previous_source_time':iso(before) if before else None,'next_source_time':iso(after) if after else None,
            'minutes_before':(wanted-before)/MIN if before else None,'minutes_after':(after-wanted)/MIN if after else None,'missing_record_count':len(occurrences),'occurrences':occurrences,'same_entry_other_policy_exits':related})
    write('missing-exits.json',{'unpriced_trade_records':sum(len(v) for v in missing.values()),'unique_entry_paths':len(resolved),'cases':resolved,
        'limits':'Frozen source gaps do not by themselves prove delisting or exchange downtime; source DB spot checks are recorded separately.'})
    table('missing-exits.csv',[{k:v for k,v in r.items() if k not in ['occurrences','same_entry_other_policy_exits','source_exact_row']} for r in resolved])
    print(json.dumps({'liquidity':json.loads((OUT/'liquidity.json').read_text())['periods'],'missing_records':sum(len(v) for v in missing.values()),'unique_missing_paths':len(resolved),'causes':dict(collections.Counter(r['cause_in_frozen_source'] for r in resolved))}),flush=True)
if __name__=='__main__':main()
