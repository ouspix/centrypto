"""Post-fit payoff, chronology, serialization and inference checks."""
from policy import *
from analyze import read_trades
from lock import verify_lock,sha
from news import News

def main():
    # The model protocol stays frozen. A documented validator-only repair may
    # change this file; every source, feature and fitted-code hash remains checked.
    frozen=json.loads((HERE/'experiment-lock.json').read_text())
    amendment=json.loads((HERE/'verification-amendment.json').read_text()) if (HERE/'verification-amendment.json').exists() else None
    for filename,expected in frozen['files'].items():
        actual=sha(pathlib.Path(filename))
        if actual!=expected:
            assert pathlib.Path(filename)==pathlib.Path(__file__).resolve() and amendment
            assert amendment['before_sha256']==expected and amendment['after_sha256']==actual
    d=Data();rows=read_trades();audits=json.loads((HERE/'selection-audit.json').read_text());checks=collections.Counter()
    for a in audits:
        inner=np.array(a['inner_ids']);val=np.array(a['validation_ids'])
        assert d.completion[inner].max()<ms(a['validation_start'])-1440*MIN
        assert d.completion[val].max()<ms(a['start'])-1440*MIN
        assert all(d.target[i]==1 for i in a['inner_teacher_entries'])
        assert not any('news' in n for n in a['exit_retained_features'])
        checks['folds']+=1
    busy={}
    for r in sorted(rows,key=lambda r:(r['policy'],r['entry_time'])):
        e=r['entry_index'];t=r['exit_step'];sign=r['side_sign'];c=d.catalog[int(d.state['series'][e])]
        assert r['candidate_id']==e*2+(sign==-1)
        assert 1<=t<=H and ms(c['start'])<ms(r['entry_time'])<ms(r['exit_time'])<ms(c['end'])
        assert d.state['series'][e]==d.state['series'][e+t]
        p=d.state['terminal_price'][e] if t==H else d.state['price'][e+t]
        expected=sign*(p-d.state['price'][e])/d.state['price'][e]*100
        if r['scored']:assert np.isclose(expected,r['return_pct'],atol=1e-9)
        else:assert not np.isfinite(expected) and t==H
        assert 5<=r['holding_minutes']<=1440
        # continuous_replay starts a separate book for each held-out fold.
        key=(r['policy'],r['fold'],r['symbol']);assert int(d.state['time'][e])>busy.get(key,-1)
        busy[key]=ms(r['exit_time']) if r['scored'] else ms(c['end'])
        checks['trade_payoffs' if r['scored'] else 'censored_at_deadline']+=1
    # Direct source-candle spot checks, independent of the feature/target arrays.
    rng=np.random.default_rng(832)
    priced=[r for r in rows if r['scored']]
    for index in rng.choice(len(priced),min(24,len(priced)),replace=False):
        r=priced[int(index)];c=d.catalog[int(d.state['series'][r['entry_index']])]
        raw=gz(BASE_CACHE/'candles'/c['period']/(urllib.parse.quote(c['symbol'],safe='')+'.json.gz'))['rows']
        opens={int(z[0]):float(z[1]) for z in raw}
        assert np.isclose(r['side_sign']*(opens[ms(r['exit_time'])]-opens[ms(r['entry_time'])])/opens[ms(r['entry_time'])]*100,r['return_pct'])
        checks['original_candle_payoffs']+=1
    entry,exit,config=load_models();final=json.loads((HERE/'final-fit.json').read_text())
    chosen=np.array(final['validation_ids'],int);sample=rng.choice(chosen,min(30,len(chosen)),replace=False)
    values=d.entry_rows(sample);pred=predict(entry['model'],entry['preprocess'],values)
    import tempfile
    with tempfile.TemporaryDirectory(dir=CACHE) as temporary:
        file=pathlib.Path(temporary)/'roundtrip.joblib';joblib.dump(entry,file);restored=joblib.load(file)
        assert np.array_equal(pred,predict(restored['model'],restored['preprocess'],values));checks['serialization']+=1
        joblib.dump(exit,file);restored=joblib.load(file)
        teacher=np.array(final['inner_teacher_entries'][:20]);x=d.exit_rows(teacher,teacher//2+1)
        assert np.array_equal(predict(exit['model'],exit['preprocess'],x),predict(restored['model'],restored['preprocess'],x));checks['serialization']+=1
    def feature_dict(names,v):return {name:float(value) if np.isfinite(value) else None for name,value in zip(names,v)}
    for encoded,v in zip(sample,values):
        features=feature_dict(d.entry_names,v);features.pop('candidate_side')
        result=entry_action(entry,{**config,'cash':False,'entry_threshold':.5},features)
        long=score(entry,{**features,'candidate_side':1});short=score(entry,{**features,'candidate_side':-1})
        assert result['scores']=={'long':long,'short':short}
        expected='WAIT' if long==short or max(long,short)<.5 else ('OPEN_LONG' if long>short else 'OPEN_SHORT')
        assert result['action']==expected;checks['entry_api_actions']+=1
    for encoded in teacher:
        side='long' if encoded%2==0 else 'short';v=d.exit_rows(np.array([encoded]),np.array([encoded//2+1]))[0];features=feature_dict(d.exit_names,v)
        assert exit_action(exit,config,features,H,side)['action']=='CLOSE'
        value=score(exit,features)
        assert exit_action(exit,config,features,1,side)['action']==('CLOSE' if value>=config['exit_threshold'] else 'HOLD')
        try:exit_action(exit,config,{**features,'news_forbidden':0},1,side)
        except ValueError:pass
        else:raise AssertionError('News accepted by exit API')
        checks['exit_api_actions']+=3
    n=News(sorted({c['symbol'] for c in d.catalog}))
    # Independent loop over intervals checks stored counts, including mixed.
    eligible=d.eligible[d.state['time'][d.eligible]>=ms('2026-11-05T00:00:00Z')]
    for e in rng.choice(eligible,min(40,len(eligible)),replace=False):
        c=d.catalog[int(d.state['series'][e])];cut=int(d.state['time'][e]);events=n.index.get(c['symbol'],[])
        active=[ev for ev in events if ev['at']<=cut<ev['end'] and cut<ev['pub']+24*3600000]
        if d.news_values(np.array([e]),'news_feed_available')[0]>0:
            assert len(active)==d.news_values(np.array([e]),'news_events_24h')[0]
            assert sum(ev['direction']=='mixed' for ev in active)==d.news_values(np.array([e]),'news_mixed_count_24h')[0]
        checks['as_of_news_counts']+=1
    old_manifest=json.loads((BASE/'delivery-manifest.json').read_text())['files']
    for filename in ['entry_model.joblib','exit_model.joblib','spec.json','results.json','news_two.py']:
        assert sha(BASE/filename)==old_manifest[filename]
    checks['old_model_and_result_hashes_unchanged']=1
    save('example-entry-input.json',{'stage':'entry','features':feature_dict(d.entry_names,values[0])})
    payload=json.loads((HERE/'example-entry-input.json').read_text());payload['features'].pop('candidate_side');save('example-entry-input.json',payload)
    encoded=int(teacher[0]);v=d.exit_rows(np.array([encoded]),np.array([encoded//2+1]))[0]
    save('example-exit-input.json',{'stage':'exit','features':feature_dict(d.exit_names,v),'holding_step':1,'side':'long' if encoded%2==0 else 'short'})
    save('validation.json',{'status':'passed','checks':dict(checks),'no_position_overlap_within_each_replay':True,'fees_excluded':True,
        'verification_only_amendment':amendment,
        'scope':'Arithmetic, code/data hashes, news timing/relevance tests, chronological splits and runtime API. Does not establish predictive profitability or short tradability.'})
    clarification='Each outer fold is a separate replay book. Unpriceable deadline exits quarantine the symbol for the remainder of that replay; a later fold starts a new book. The fixed24h baseline has censored trades and no complete aggregate profit estimate.'
    report=(HERE/'REPORT.txt').read_text()
    if clarification not in report:(HERE/'REPORT.txt').write_text(report+'\n\n'+clarification+'\n')
    files=[p for p in HERE.iterdir() if p.is_file() and p.name!='delivery-manifest.json']
    save('delivery-manifest.json',{'files':{p.name:sha(p) for p in files}})
    print((HERE/'validation.json').read_text(),flush=True)

if __name__=='__main__':
    with threadpool_limits(limits=1):main()
