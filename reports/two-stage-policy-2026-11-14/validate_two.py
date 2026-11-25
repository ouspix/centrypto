"""Validate final data/model separation, chronology, fills and inference APIs."""
import io,joblib
from policy_two import *
def main():
    d=Data();lock=json.loads((HERE/'experiment-lock.json').read_text());audits=json.loads((HERE/'selection-audit.json').read_text());final=json.loads((HERE/'final-fit.json').read_text());entry,exit,config=load_models();assert len(audits)>0
    for name,sha in lock['code'].items():assert hashlib.sha256((HERE/name).read_bytes()).hexdigest()==sha,name
    for name,sha in lock['data'].items():assert hashlib.sha256((CACHE/name).read_bytes()).hexdigest()==sha,name
    for name,sha in lock['metadata'].items():assert hashlib.sha256((HERE/name).read_bytes()).hexdigest()==sha,name
    for f in audits+[final]:
        inner=np.array(f['inner_ids']);val=np.array(f['validation_ids']);assert not set(inner)&set(val);assert d.completion[inner].max()<ms(f['validation_start'])-1440*MIN;assert d.completion[val].max()<ms(f['validation_end']);assert all(d.state['target'][i]==1 for i in f['inner_teacher_entries']);assert set(f['inner_teacher_entries'])<=set(inner);assert not any('news' in n for n in f['exit_retained_features']);assert f['entry_updates']==next(c['updates'] for c in f['entry_curves'] if c['updates'] and c['average_precision']==max(c['average_precision'] for c in f['entry_curves'] if c['updates']))
        choices=[v for c in f['exit_curves'] for v in c['choices']];best=max(v['mean_teacher_entry_return_pct'] for v in choices);chosen=next(c for c in f['exit_curves'] if c['updates']==f['exit_updates']);assert any(v['threshold']==f['exit_threshold'] and np.isclose(v['mean_teacher_entry_return_pct'],best) for v in chosen['choices'])
        possible=[0.]+[c['gross_profit_usd'] for c in f['threshold_selection'] if c['censored_trades']==0 and c['trades']>=5];assert np.isclose(f['selection']['validation_profit_usd'],max(possible))
    assert any('news' in n for n in entry['preprocess'].names);assert not any('news' in n for n in exit['input_names']);assert set(exit['training_entry_ids'])==set(final['inner_teacher_entries'])
    rows=list(csv.DictReader((HERE/'predictions.csv').open())) if (HERE/'predictions.csv').exists() else [];groups=collections.defaultdict(list);payoffs=0
    for r in rows:
        e=int(r['entry_index']);step=int(r['exit_step']);f=next(f for f in audits if f['start']==r['fold']);assert ms(f['start'])<=d.times[e]<ms(f['end'])-1472*MIN;assert d.state['eligible'][e] and np.isfinite(d.state['price'][e]);assert 1<=step<=H;assert d.state['series'][e]==d.state['series'][e+step];assert ms(r['entry_time'])==d.times[e]+55000
        if r['scored']=='True':
            price=d.state['terminal_price'][e] if step==H else d.state['price'][e+step];at=int(d.state['terminal_time'][e]) if step==H else int(d.times[e+step])+55000;value=100*(price/d.state['price'][e]-1);assert np.isclose(value,float(r['return_pct']));assert at==ms(r['exit_time']);duration=(at-ms(r['entry_time']))/MIN;assert 5<=duration<=1470;assert duration<=1440 or step==H;payoffs+=1
        groups[(r['policy'],r['symbol'])].append(r)
    for rr in groups.values():
        rr.sort(key=lambda r:r['entry_time'])
        for a,b in zip(rr[:-1],rr[1:]):assert ms(a['exit_time'])<ms(b['entry_time'])
    source_checks=0;news_checks=0;raw_cache={};news_raw=gz(CACHE/'news-full.json.gz');docs={v['id']:v for v in news_raw['documents']};edges=json.loads((CACHE/'news-edges.json').read_text());by_symbol=collections.defaultdict(list)
    for edge in edges:by_symbol[edge['symbol']].append(edge)
    for r in [r for r in rows if r['scored']=='True'][::max(1,len(rows)//24)][:24]:
        e=int(r['entry_index']);c=d.catalog[int(d.state['series'][e])]
        if c['key'] not in raw_cache:raw_cache[c['key']]={int(v[0]):v for v in gz(CACHE/'candles'/c['period']/(urllib.parse.quote(c['symbol'],safe='')+'.json.gz'))['rows']}
        original=raw_cache[c['key']];at=ms(r['entry_time']);out=ms(r['exit_time']);assert np.isclose(original[at][1],d.state['price'][e],rtol=0,atol=1e-12);assert original[at-2*MIN][4]*original[at-2*MIN][5]>=10000;expected=100*(original[out][1]/original[at][1]-1);assert np.isclose(expected,float(r['return_pct']),rtol=0,atol=1e-9);source_checks+=1
        cut=int(d.times[e]);known=d.news[e,d.news_names.index('news_feed_available')]>0
        if known:
            stories=set()
            for edge in by_symbol[c['symbol']]:
                doc=docs[edge['document_id']];available=max(ms(doc[k]) if doc.get(k) else 0 for k in ['availableAt','collectedAt','publishedAt']);published=ms(doc['publishedAt'] or doc['collectedAt']);assert available==ms(edge['available_at'])
                if cut-3600000<available<=cut and published>cut-3600000:stories.add(doc['storyHash'])
            assert len(stories)==d.news[e,d.news_names.index('news_stories_1h')];news_checks+=1
    teachers=list(csv.DictReader((HERE/'teacher-exit-diagnostic.csv').open())) if (HERE/'teacher-exit-diagnostic.csv').exists() else []
    for r in teachers:assert float(r['learned_exit_gain_pct'])<=float(r['teacher_gain_pct'])+2e-5
    # Saved-model decisions match direct network predictions, with independent input sets.
    ids=np.array(final['validation_ids'][:64]);features=d.entry_rows(ids);direct=predict(entry['model'],entry['preprocess'],features);calls=0
    for j,i in enumerate(ids):
        values={n:float(v) if np.isfinite(v) else None for n,v in zip(d.entry_names,features[j])};got=entry_action(entry,config,values,True);expected='WAIT' if config['cash'] else 'BUY' if direct[j]>=config['entry_threshold'] else 'WAIT';assert got['action']==expected;calls+=1
        probe_config={**config,'cash':False,'entry_threshold':.5};probe=entry_action(entry,probe_config,values,True);assert probe['action']==('BUY' if direct[j]>=.5 else 'WAIT');assert np.isclose(probe['entry_score'],direct[j],atol=1e-5);calls+=1
    ens=np.array(final['validation_teacher_entries'][:4]);holding=np.array([1,6,24,72,144,287]);ee=np.repeat(ens,len(holding));rr=ee+np.tile(holding,len(ens));x=d.exit_rows(ee,rr);direct=predict(exit['model'],exit['preprocess'],x)
    for j in range(len(rr)):
        values={n:float(v) if np.isfinite(v) else None for n,v in zip(d.exit_names,x[j])};got=exit_action(exit,config,values,int(rr[j]-ee[j]));assert got['action']==('SELL' if direct[j]>=config['exit_threshold'] else 'HOLD');calls+=1
        try:exit_action(exit,config,{**values,'news_signal':1},int(rr[j]-ee[j]))
        except ValueError:pass
        else:raise AssertionError('Exit accepted news')
    assert exit_action(exit,config,{},H)['action']=='SELL'
    for artifact,raw in [(entry,features),(exit,x)]:
        stream=io.BytesIO();joblib.dump(artifact,stream);stream.seek(0);restored=joblib.load(stream);assert np.array_equal(predict(artifact['model'],artifact['preprocess'],raw),predict(restored['model'],restored['preprocess'],raw))
    # Entry cost and only observations through the current decision determine trade state.
    e=int(ens[0]);a=d.exit_rows([e],[e+6]);modified=Data.__new__(Data);modified.__dict__=d.__dict__.copy();modified.state=np.array(d.state);modified.state['close'][e+7:e+H+1]*=2;assert np.array_equal(a,modified.exit_rows([e],[e+6]),equal_nan=True)
    save('validation.json',{'status':'passed','chronological_folds':len(audits),'same_positive_targets_used_for_exit_training':True,'final_entry_news_dimensions':sum('news' in n for n in entry['preprocess'].names),'final_exit_news_dimensions':0,'news_trained_test_folds':sum(any('news' in n for n in f['entry_retained_features']) for f in audits),'recomputed_trade_payoffs':payoffs,'trades_checked_against_original_minute_records':source_checks,'independent_asof_news_story_count_checks':news_checks,'position_overlap_violations':0,'teacher_exit_upper_bounds_checked':len(teachers),'saved_model_action_calls':calls,'future_trade_observations_preserve_current_features':True,'serialization_roundtrips':2,'code_data_hashes_verified':True,'unit_checks':json.loads((HERE/'unit-validation.json').read_text())});print((HERE/'validation.json').read_text(),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
