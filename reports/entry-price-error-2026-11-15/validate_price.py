from price_common import *
import price_network
import gzip,urllib.parse,joblib,shutil
from engine import totals

def main():
    lock=json.loads((HERE/'training-lock.json').read_text())
    for n,h in lock['files'].items():assert file_hash(HERE/n)==h,n
    for n,h in lock['frozen_baseline_models'].items():assert file_hash(REPAIR_CACHE/n)==h,n
    data=PriceData();splits=[]
    for p in PLANS:
        for side in [1,-1]:
            tr=data.episode_ids(p,'train',side);va=data.episode_ids(p,'validation',side);te=data.episode_ids(p,'test',side)
            assert not (set(tr)&set(va) or set(tr)&set(te) or set(va)&set(te))
            assert max(data.episodes[i]['completion'] for i in tr)<ms(p['validation_start'])-1440*MIN
            assert max(data.episodes[i]['completion'] for i in va)<ms(p['start'])-1440*MIN
            assert all(data.episodes[i]['start']>=ms(p['start']) for i in te)
            splits.append({'fold':p['start'],'side':side,'train':len(tr),'validation':len(va),'test':len(te)})
    assert not any('news' in n or 'oracle' in n or 'target' in n for n in data.entry_names)
    rng=np.random.default_rng(12891);sample=[]
    for side in [1,-1]:
        for qualifies in [True,False]:
            ids=[i for i,e in enumerate(data.episodes) if e['side']==side and e['qualifies']==qualifies]
            sample.extend(rng.choice(ids,5,replace=False).tolist())
    native={};audits=[]
    for i in sample:
        e=data.episodes[i];cat=data.d.catalog[e['series']];key=cat['key']
        if key not in native:
            p=BASE_CACHE/'candles'/cat['period']/(urllib.parse.quote(cat['symbol'],safe='')+'.json.gz')
            with gzip.open(p,'rt') as f:raw=json.load(f)['rows']
            native[key]={int(row[0]):float(row[1]) for row in raw}
        points=[]
        for cid,row in zip(e['ids'],e['rows']):
            at=int(data.d.state['time'][row])+55000;price=native[key][at]
            exits=np.array([native[key][at+k*BAR] for k in range(1,H+1)])
            gains=e['side']*(exits/price-1)
            points.append((float(gains.max()),int(row),price,int(cid)))
        best=sorted(points,key=lambda v:(-v[0],v[1]))[0]
        assert best[1]==e['target_row'] and best[3]==e['target_id']
        assert np.isclose(best[0],e['best_gain'],rtol=1e-10)
        assert np.isclose(best[2],e['target_price'],rtol=1e-12)
        audits.append({'setup':e['setup'],'symbol':cat['symbol'],'side':e['side'],'candidate_count':len(points),
            'raw_future_opens_checked':len(points)*H,'target_entry_time':iso(data.d.state['time'][e['target_row']]+55000)})
    allrecords=json.loads((HERE/'results.json').read_text())+json.loads((CACHE/'diagnostic-replays.json').read_text())
    count=0;unknown=0
    for record in allrecords:
        for trade in record['trades']:
            row=trade['entry_index'];side=trade['side_sign'];step=trade['exit_step'];entry=float(data.d.state['price'][row])
            exit_price=float(data.d.state['terminal_price'][row]) if step==H else float(data.d.state['price'][row+step])
            if trade['scored']:
                assert np.isfinite(entry) and np.isfinite(exit_price)
                assert np.isclose(side*100*(exit_price/entry-1),trade['return_pct'],rtol=1e-10,atol=1e-10)
                assert 0<trade['holding_minutes']<=1440
            else:unknown+=1;assert trade['return_pct'] is None
            count+=1
        assert totals(record['trades'])['gross_pnl_usd']==record['stats']['gross_pnl_usd']
    learning=[json.loads(p.read_text()) for p in (HERE/'training').glob('*.json')]
    assert len(learning)==24
    reduction=sum(a['curve'][-1]['train']['cost']<a['curve'][0]['train']['cost'] for a in learning)

    # Freeze last-fold ensemble; exits copied byte-for-byte from the current bundle.
    folder=CACHE/'bundle';folder.mkdir(exist_ok=True);fold=PLANS[-1]['start'][:10];checks={}
    for side in ['long','short']:
        path=folder/f'{side}_entry_model.joblib'
        joblib.dump({'members':[joblib.load(CACHE/'models'/fold/f'{side}_entry_{seed}.joblib') for seed in SEEDS],
            'kind':'entry','side':side,'research_only':True,'objective':CFG['loss']},path,compress=3)
        checks[path.name]=file_hash(path)
        ex=folder/f'{side}_exit_model.joblib';shutil.copyfile(REPAIR/'models'/ex.name,ex)
        checks[ex.name]=file_hash(ex);assert checks[ex.name]==file_hash(REPAIR/'models'/ex.name)
    policy=json.loads((HERE/'selection'/f'{fold}.json').read_text())['price_error']
    write('bundle/policy-config.json',{'sides':policy,'pairs':OLD_CFG['pairs'],'seeds':SEEDS,'holding_limit_minutes':1440,
        'entry_window_minutes':60,'fees':0,'funding_payments':0,'slippage':0,'research_only':True,'frozen_fold':PLANS[-1],
        'publication_time_required_for_runtime':True,'training_config':CFG},True)
    checks['policy-config.json']=file_hash(folder/'policy-config.json');write('bundle/checksums.json',checks,True)
    from price_policy import load_policy
    runtime=load_policy()
    assert runtime.entry([100.]*100,{},0)['action']=='wait'
    assert runtime.exit('long',{},1440,0)['reason']=='holding_deadline'
    runtime_parity=0
    from repair_network import predict
    for side in ['long','short']:
        pack=joblib.load(CACHE/'prepared'/fold/side/'validation.joblib',mmap_mode='r');raw=pack['raw'][:50]
        actual=predict(runtime.models[side]['entry'],raw)
        expected=np.mean([predict(joblib.load(CACHE/'models'/fold/f'{side}_entry_{seed}.joblib'),raw) for seed in SEEDS],axis=0)
        np.testing.assert_allclose(actual,expected,rtol=1e-12);runtime_parity+=len(raw)
    report={'status':'passed','baseline_models_hash_unchanged':len(lock['frozen_baseline_models']),
        'source_lock_passed':True,'split_checks':splits,'raw_target_audits':audits,
        'raw_future_opens_checked':sum(a['raw_future_opens_checked'] for a in audits),
        'trade_records_recomputed':count,'unknown_trade_records_preserved':unknown,
        'training_loss_reduced':reduction,'networks':len(learning),'runtime_ensemble_prediction_parity':runtime_parity,
        'frozen_exit_bundle_hash_identical':True,'frozen_current_replay_parity_all_four_folds':True,
        'runtime_wait_and_deadline_checks':True,'news_excluded':True,'receipt_time_limitation':'Original historical receipt times remain unavailable; event-time research only.'}
    write('validation.json',report);print(json.dumps({k:v for k,v in report.items() if k not in ['split_checks','raw_target_audits']}),flush=True)

if __name__=='__main__':
    with threadpool_limits(limits=1):main()
