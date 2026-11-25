"""Independent source-time, replay-reconciliation and chronological-fit audits."""
import argparse,collections,hashlib,math
import joblib
from common import *
from news import NewsMap,doc_time
from reduction import predict_model

def sources():
    data=np.load(HERE/'features.npz');X=data['X'];names=data['feature_names'].tolist()
    meta=json.loads((HERE/'entry-metadata.json').read_text());bykey={m['key']:m for m in meta}
    assert len(bykey)==len(meta)==len(X)==1742
    assert not np.isinf(X).any()
    for m in meta:assert m['last_candle_close_ms']<=ms(m['cutoff'])==ms(m['entry_time'])-5000
    assert not {'return_pct','R','exit_price','entry_price','stop_price'}.intersection(names)
    lock=json.loads((HERE/'experiment-lock.json').read_text())
    for file,sha in lock['files'].items():assert hashlib.sha256((HERE/file).read_bytes()).hexdigest()==sha,file
    ticks=gz(CACHE/'ticks-expanded.json.gz');tick_checks=0
    for t in ticks:
        cut=ms(t['cutoff']);assert cut==ms(bykey[t['key']]['cutoff'])
        for row in t['recent']:assert cut-15*MIN<=ms(row['ts'])<=cut;tick_checks+=1
        for lag,row in t['anchors'].items():
            if row:assert 0<=cut-int(lag)*MIN-ms(row['ts'])<=120000;tick_checks+=1
    spot_rows=0;spot_files=0
    for file in (CACHE/'spot').glob('*.json.gz'):
        s=gz(file);rows=s['rows'];spot_files+=1
        assert len({int(r[0]) for r in rows})==len(rows),s['symbol']
        for r in rows:
            t,o,h,l,c,v,close,q,n,b,bq=map(float,r[:11])
            assert all(math.isfinite(vv) for vv in [t,o,h,l,c,v,close,q,n,b,bq])
            assert min(o,h,l,c)>0 and h>=max(o,l,c) and l<=min(o,h,c)
            assert t%MIN==0 and close==t+MIN-1 and v>=0 and q>=0 and n>=0
            assert -1e-8<=b<=v+1e-7 and -1e-8<=bq<=q+1e-7
        spot_rows+=len(rows)
    # Regenerate news inputs from frozen documents, including the repaired untraded MEME alias.
    universe=set()
    for rows in json.loads((HERE/'older-manifest.json').read_text())['periods'].values():universe.update(r['symbol'] for r in rows)
    universe.update(r['symbol'] for r in json.loads((OLD/'manifest.json').read_text())['symbols'])
    mapper=NewsMap(sorted(universe));audit=gz(CACHE/'entry-news-audit.json.gz');edge_checks=revision_checks=feature_checks=0
    for i,(m,a) in enumerate(zip(meta,audit)):
        assert m['key']==a['key'];cut=ms(m['cutoff'])
        nf,na=mapper.feature_row(m['symbol'],cut)
        assert na['direct_document_links']==a['document_links']
        for name,value in nf.items():
            actual=X[i,names.index(name)];assert np.isclose(actual,value,equal_nan=True), (m['key'],name,actual,value)
            feature_checks+=1
        for edge in a['document_links']:
            doc=mapper.docs[edge['documentId']]
            assert edge['symbol']==m['symbol'] and doc_time(doc)<=edge['link_available_ms']<=cut
            assert cut-24*3600000<=edge['published_ms']<=cut
            assert edge['term'].casefold() in doc['text'].casefold()
            edge_checks+=1
        for ev in a['active_analysis_refs']:
            assert ev['available_ms']<=cut<ev['expires_ms']
            for docid in ev['evidenceIds']:assert doc_time(mapper.docs[docid])<=cut
            revision_checks+=1
    old=csvrows(OLD/'trades.csv');new={(r['key'],int(r['slippage_bps_per_side'])):r for r in csvrows(HERE/'trades.csv')}
    for r in old:
        key='|'.join(r[k] for k in ['symbol','mode','entry_time']);n=new[key,int(r['slippage_bps_per_side'])]
        assert r['exit_time']==n['exit_time']
        for col in ['return_pct','R','entry','exit','stop','target']:assert math.isclose(float(r[col]),float(n[col]),rel_tol=1e-12,abs_tol=1e-12)
    quality=csvrows(HERE/'candle-quality.csv');assert sum(int(r['invalid_rows']) for r in quality)==0
    result={'feature_rows':len(meta),'feature_dimensions':len(names),'source_candles':sum(int(r['source_rows']) for r in quality),'invalid_source_candles':0,'feature_cutoff_checks':len(meta),'derivative_timestamp_checks':tick_checks,'spot_files':spot_files,'spot_candles_checked':spot_rows,'news_entry_document_links_checked':edge_checks,'active_analysis_references_checked':revision_checks,'regenerated_news_feature_values_checked':feature_checks,'original_execution_rows_reconciled':len(old),'locked_hashes_verified':len(lock['files']),'post_lock_repairs':len(lock.get('post_lock_repairs',[])),'status':'passed'}
    save('source-validation.json',result);print(json.dumps(result),flush=True)

def models():
    data=np.load(HERE/'features.npz');X=data['X'];names=data['feature_names'].tolist();meta=json.loads((HERE/'entry-metadata.json').read_text());bykey={m['key']:m for m in meta};ix={m['key']:i for i,m in enumerate(meta)}
    trades={r['key']:r for r in csvrows(HERE/'trades.csv') if r['slippage_bps_per_side']=='0'}
    groups=collections.defaultdict(list)
    for m in meta:groups[m['group']].append(m['key'])
    preds=csvrows(HERE/'predictions.csv');assert len({(p['experiment'],p['model'],p['key']) for p in preds})==len(preds)
    folds=json.loads((HERE/'fold-audit.json').read_text());inner=0
    for f in folds:
        tr=set(f['train_keys']);te=set(f['test_keys']);assert not tr&te
        tg={bykey[k]['group'] for k in tr};vg={bykey[k]['group'] for k in te};assert not tg&vg
        cutoff=ms(f['start'])-120*MIN
        for g in tg:
            assert max(ms(trades[k]['exit_time'])+65000 for k in groups[g])<cutoff
        for k in te:assert ms(bykey[k]['cutoff'])>=ms(f['start'])
    for f in json.loads((HERE/'selection-audit.json').read_text()):
        for variant in ['relevance','no_news_relevance']:
            detail=f[variant];assert len(detail['selected'])<=20
            for w in detail['inner_windows']:assert w['latest_training_label']<w['purge_cutoff']<w['validation_start'];inner+=1
            for n in detail['selected']:
                if n!='setup_continuation':assert next(e for e in detail['evidence'] if e['feature']==n)['qualified']
    for p in preds:
        assert float(p['return_pct'])==float(trades[p['key']]['return_pct'])
        assert (p['selected']=='True')==(float(p['prediction_pct'])>0)
        assert ms(p['latest_training_label'])<ms(p['training_cutoff'])<ms(p['fold_start'])
    # Recompute headline errors with an independently constructed episode-equal weight vector.
    comparisons=0
    for r in json.loads((HERE/'results.json').read_text())['results']:
        if r['cohort']!='all' or r['mode']!='both':continue
        ps=[p for p in preds if p['experiment']==r['experiment'] and p['model']==r['model']];counts=collections.Counter(p['group'] for p in ps)
        errors=[abs(float(p['prediction_pct'])-float(p['return_pct']))/counts[p['group']] for p in ps]
        assert math.isclose(sum(errors)/len(counts),r['prediction']['MAE_pp'],abs_tol=1e-10)
        selected=[float(p['return_pct']) for p in ps if p['selected']=='True']
        assert len(selected)==r['selected']['n']
        if selected:assert math.isclose(np.mean(selected),r['selected']['mean_return_pct'],abs_tol=1e-10)
        comparisons+=1
    artifact=joblib.load(HERE/'reduced-research-model.joblib');columns=artifact['columns'];prediction=predict_model(artifact['model'],X[:10],columns,artifact['means'],names);assert np.isfinite(prediction).all()
    save('model-validation.json',{'prediction_rows_checked':len(preds),'outer_folds_checked':len(folds),'inner_time_windows_checked':inner,'headline_metric_comparisons':comparisons,'selected_threshold':'prediction_pct > 0','episode_overlap_violations':0,'future_training_label_violations':0,'loaded_model_predictions_checked':len(prediction),'status':'passed'})
    print((HERE/'model-validation.json').read_text(),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--stage',choices=['sources','models','all'],default='all');args=p.parse_args()
    if args.stage in ['sources','all']:sources()
    if args.stage in ['models','all']:models()
