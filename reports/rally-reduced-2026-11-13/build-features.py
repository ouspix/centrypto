"""Expanded as-of feature matrix, with the complete raw-news document mapping."""
import bisect,collections,hashlib,math
from common import *
from news import NewsMap

def main():
    old=module('wide_features',WIDE/'build-features.py');helper=module('prior_news',CTX/'features.py')
    entries=[r for r in csvrows(HERE/'trades.csv') if r['slippage_bps_per_side']=='0'];events=json.loads((HERE/'events.json').read_text())
    tick={r['key']:r for r in gz(CACHE/'ticks-expanded.json.gz')}
    universe=set()
    for rows in json.loads((HERE/'older-manifest.json').read_text())['periods'].values():universe.update(r['symbol'] for r in rows)
    universe.update(r['symbol'] for r in json.loads((OLD/'manifest.json').read_text())['symbols'])
    mapper=NewsMap(sorted(universe));save('news-mapping-edges.json',mapper.edges);save('news-alias-provenance.json',mapper.alias_audit)
    save('news-mapping-summary.json',{'documents':len(mapper.docs),'asset_document_links':len(mapper.edges),'mapped_documents':len(set(e['documentId'] for e in mapper.edges)),'linked_symbols':len(mapper.index),'methods':dict(collections.Counter(e['method'] for e in mapper.edges)),'market_context_documents':len(mapper.market_docs),'learned_aliases':len(mapper.alias_audit),'first_available':iso(mapper.doc_times[0]),'last_available':iso(mapper.doc_times[-1])})
    meta=[];rows=[];news_audit=[];funding_zeros=0
    for period in SPEC['periods']:
        a_by_symbol,_=period_arrays(period);old.START=ms(period['start']);old.END=ms(period['end']);old.N=(old.END-old.START)//MIN
        close=np.array([a[:,3] for a in a_by_symbol.values()]);bench_cache={};breadth_cache={};spotcache={}
        subset=[e for e in entries if e['period']==period['id']]
        for e in subset:
            key=e['key'];cut=ms(e['entry_time'])-5000;j=(cut-MIN-old.START)//MIN;last_close=old.START+(j+1)*MIN;assert last_close<=cut<ms(e['entry_time'])
            a=a_by_symbol[e['symbol']];f=old.candle_features(a,j,'perp_')
            for sym,prefix in [('BTC','btc_'),('ETH','eth_')]:
                bench=a_by_symbol[sym]
                if (sym,j) not in bench_cache:bench_cache[(sym,j)]=old.candle_features(bench,j,prefix,windows=[5,15,60,240,1440])
                bf=bench_cache[(sym,j)];f.update(bf)
                for w in [5,15,60,240,1440]:f[f'relative_{sym.lower()}_return_{w}m']=f[f'perp_return_pct_{w}m']-bf[f'{prefix}return_pct_{w}m']
                for w in [60,240]:
                    x=old.window(a,j,w+1);y=old.window(bench,j,w+1);ar=np.diff(np.log(x[:,3]));br=np.diff(np.log(y[:,3]));ok=np.isfinite(ar)&np.isfinite(br);corr=beta=np.nan
                    if ok.sum()>=.8*w and np.std(ar[ok])>0 and np.std(br[ok])>0:corr=float(np.corrcoef(ar[ok],br[ok])[0,1]);beta=float(np.cov(ar[ok],br[ok])[0,1]/np.var(br[ok],ddof=1))
                    f[f'relative_{sym.lower()}_correlation_{w}m']=corr;f[f'relative_{sym.lower()}_beta_{w}m']=beta
            if j not in breadth_cache:
                b={}
                for w in [5,60,240,1440]:
                    v=100*(close[:,j]/close[:,j-w]-1) if j>=w else np.full(len(close),np.nan);v=v[np.isfinite(v)]
                    b[f'breadth_observed_symbols_{w}m']=len(v);b[f'breadth_positive_fraction_{w}m']=float(np.mean(v>0)) if len(v) else np.nan
                    b[f'breadth_median_return_{w}m']=float(np.median(v)) if len(v) else np.nan;b[f'breadth_dispersion_{w}m']=float(np.std(v)) if len(v) else np.nan;b[f'breadth_rally_fraction_{w}m']=float(np.mean(v>=2)) if len(v) else np.nan
                breadth_cache[j]=b
            f.update(breadth_cache[j]);d=tick[key]
            # Historical collector defaulted missing funding to zero; conservatively mark indistinguishable zero values unknown.
            for t in d['recent']+list(d['anchors'].values()):
                if t and t.get('fundingRate')==0:t['fundingRate']=None;funding_zeros+=1
            for t in d['recent']:assert ms(t['ts'])<=cut
            f.update(old.derivative_features(d,cut))
            symbol=e['symbol']
            if symbol not in spotcache:
                raw=gz(CACHE/'spot'/(urllib.parse.quote(symbol,safe='')+'.json.gz'));rr=raw['rows'];spotcache[symbol]=(raw,[int(r[0]) for r in rr])
            sr,times=spotcache[symbol];lo=bisect.bisect_left(times,cut-1441*MIN);hi=bisect.bisect_right(times,(cut//MIN-1)*MIN)
            relevant=[]
            for raw in sr['rows'][lo:hi]:
                if int(raw[6])>cut:continue
                r=raw.copy();mult=sr.get('multiplier',1)
                if mult!=1:
                    for q in [1,2,3,4]:r[q]=float(r[q])*mult
                    for q in [5,9]:r[q]=float(r[q])/mult
                relevant.append(r)
            f.update(old.spot_features({'status':'observed' if relevant else sr['status'],'rows':relevant},j,cut,a))
            nf,na=mapper.feature_row(symbol,cut);f.update(old.news_features(na,{'news_known':na['news_known']},cut,mapper.events));f.update(nf)
            news_audit.append({'key':key,'cutoff':iso(cut),'news_known':na['news_known'],'document_links':na['direct_document_links'],'whale_reports':na['whale_reports'],'active_analysis_refs':[{'analysisId':x['analysisId'],'revisionId':x['revisionId'],'available_ms':x['available_ms'],'expires_ms':x['expires_ms'],'evidenceIds':x['signal']['evidenceIds']} for x in na['active_news']]})
            date=dt.datetime.fromtimestamp(cut/1000,dt.timezone.utc);hour=date.hour+date.minute/60
            f.update(calendar_hour_sin=math.sin(2*math.pi*hour/24),calendar_hour_cos=math.cos(2*math.pi*hour/24),calendar_weekday_sin=math.sin(2*math.pi*date.weekday()/7),calendar_weekday_cos=math.cos(2*math.pi*date.weekday()/7),calendar_weekend=float(date.weekday()>=5),setup_continuation=float(e['mode']=='continuation'))
            at=ms(e['alert_time']);f['setup_alert_already_known']=float(at<=cut);f['setup_minutes_since_alert']=(cut-at)/MIN if at<=cut else np.nan
            f['setup_alert_return_pct']=float(e['five_minute_return_pct']) if at<=cut else np.nan;f['setup_alert_relative_volume']=float(e['relative_volume']) if at<=cut else np.nan
            for w in [360,1440]:
                prior=[v for v in events if cut-w*MIN<=ms(v['alert_time'])<=cut]
                f[f'setup_previous_symbol_alerts_{w}m']=sum(v['symbol']==symbol for v in prior);f[f'setup_previous_market_alerts_{w}m']=len(prior)
            pairs={'oi_funding':('derivative_oi_token_change_60m','derivative_funding_hourly_bps'),'price_oi':('perp_return_pct_15m','derivative_oi_token_change_15m'),'spot_flow_oi':('spot_buy_imbalance_15m','derivative_oi_token_change_15m'),'news_spot_flow':('news_directional_score','spot_buy_imbalance_15m'),'spread_participation':('liquidity_spread_bps','liquidity_100usd_to_minimum_depth'),'volume_oi':('perp_volume_ratio_15m','derivative_oi_token_change_15m')}
            for name,(left,right) in pairs.items():f['interaction_'+name]=f[left]*f[right]
            rows.append({name:old.scalar(v) for name,v in f.items()});meta.append({k:e[k] for k in ['key','symbol','mode','entry_time','alert_time','group','group_time','period','cohorts','original_entry']}|{'cutoff':iso(cut),'last_candle_close_ms':last_close,'group_day':e['group_time'][:10]})
            if len(rows)%200==0:print('Feature rows',len(rows),'/',len(entries),flush=True)
        print('Feature period complete',period['id'],len(subset),flush=True)
    names=sorted(set().union(*(r.keys() for r in rows)));X=np.array([[np.nan if r.get(n) is None else r[n] for n in names] for r in rows])
    np.savez_compressed(HERE/'features.npz',X=X,feature_names=np.array(names));save('entry-metadata.json',meta)
    registry=[]
    for i,name in enumerate(names):
        obs=X[np.isfinite(X[:,i]),i];registry.append({'name':name,'family':name.split('_')[0],'observed':len(obs),'missing':len(X)-len(obs),'unique':len(np.unique(obs))})
    writecsv('feature-registry.csv',registry);save('feature-registry.json',registry)
    payload=gzip.compress(json.dumps(news_audit,separators=(',',':')).encode());(CACHE/'entry-news-audit.json.gz').write_bytes(payload)
    coverage=[]
    for period in SPEC['periods']:
        ids=[i for i,m in enumerate(meta) if m['period']==period['id']]
        coverage.append({'period':period['id'],'entries':len(ids),'spot':sum(rows[i]['spot_available']==1 for i in ids),'derivatives':sum(rows[i]['derivative_available']==1 for i in ids),'fresh_quotes':sum(rows[i]['liquidity_available']==1 for i in ids),'news_feed':sum(rows[i]['mappednews_available']==1 for i in ids),'direct_or_project_news':sum(bool(news_audit[i]['document_links']) for i in ids),'whale_reports':sum(bool(news_audit[i]['whale_reports']) for i in ids)})
    save('feature-summary.json',{'rows':len(X),'dimensions':len(names),'nonconstant_observed_dimensions':sum(r['unique']>1 for r in registry),'families':dict(collections.Counter(r['family'] for r in registry)),'coverage':coverage,'default_zero_funding_values_marked_unknown':funding_zeros,'mapped_entry_document_links':sum(len(r['document_links']) for r in news_audit),'entry_news_audit_sha256':hashlib.sha256(payload).hexdigest()})
    print((HERE/'feature-summary.json').read_text(),flush=True)
if __name__=='__main__':main()
