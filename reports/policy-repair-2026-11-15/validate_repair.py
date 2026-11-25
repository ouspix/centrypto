from repair_common import *
from causal_candidates import CausalData
from repair_data import ENTRY_CORE
from repair_policy import Policy
from repair_replay import models_for, exit_predictions_all
from engine import exit_predictions as baseline_exits
import joblib, urllib.parse, gzip

def main():
    data=CausalData();records=[];checks=0;source_checks=[];raw_cache={}
    for plan in PLANS:
        records.extend(json.loads((CACHE/'replays'/f"{plan['start'][:10]}.json").read_text())['records'])
    for record in records:
        busy={}
        for t in record['trades']:
            e=t['entry_index'];step=t['exit_step'];end=e+step
            assert 1<=step<=H and 5<=t['holding_minutes']<=1440
            assert data.d.state['series'][e]==data.d.state['series'][end]
            assert int(data.d.state['time'][e])>busy.get(t['symbol'],-1)
            busy[t['symbol']]=ms(t['exit_time']) if t['scored'] else data.actual_ends[data.d.state['series'][e]]
            if t['scored']:
                price=data.d.state['price'][end] if step<H else data.d.state['terminal_price'][e]
                actual=t['side_sign']*100*(price/data.d.state['price'][e]-1)
                assert np.isclose(actual,t['return_pct'],atol=1e-10)
                assert ms(t['exit_time'])-ms(t['entry_time'])==step*BAR
            if t['unpriced_entry']:assert not t['scored']
            if record['variant'].startswith('repaired'):
                raw=data.entry_rows(np.array([t['candidate_id']]))
                assert np.isfinite(raw[:,[data.entry_names.index(n) for n in ENTRY_CORE]]).all()
            checks+=1
    # Independent native one-minute opens, not the prepared price column.
    all_trades=[t for r in records if r['variant'].startswith('repaired') for t in r['trades'] if t['scored']]
    chosen=np.linspace(0,len(all_trades)-1,min(40,len(all_trades)),dtype=int) if all_trades else []
    for index in chosen:
        t=all_trades[index];cat=data.d.catalog[data.d.state['series'][t['entry_index']]];key=cat['key']
        if key not in raw_cache:
            path=BASE_CACHE/'candles'/cat['period']/(urllib.parse.quote(cat['symbol'],safe='')+'.json.gz')
            with gzip.open(path,'rt') as f:raw_cache[key]={int(r[0]):float(r[1]) for r in json.load(f)['rows']}
        a=raw_cache[key][ms(t['entry_time'])];b=raw_cache[key][ms(t['exit_time'])]
        assert np.isclose(t['side_sign']*100*(b/a-1),t['return_pct'],atol=1e-10)
        source_checks.append({'symbol':t['symbol'],'entry_time':t['entry_time'],'exit_time':t['exit_time'],'matched':True})
    # A sample of baseline exits must be bit-identical to the old simulator.
    parity=0
    for plan in PLANS:
        models=models_for(plan['start'][:10],False)
        for sign,side in [(1,'long'),(-1,'short')]:
            ids=data.replay_ids(ms(plan['start']),ms(plan['end']),sign,quality=False)
            entries=np.unique(data.c['row'][ids]);entries=entries[np.isfinite(data.d.state['price'][entries])]
            entries=entries[np.linspace(0,len(entries)-1,min(30,len(entries)),dtype=int)]
            revised=exit_predictions_all(data,[models[0][side]['exit']],entries,sign,OLD_CFG['exit_thresholds'],False)[0]
            class LegacyView:
                d=data.d
                def exit_rows(self,*args,**kwargs):return FourData.exit_rows(data,*args,**kwargs)
            original=baseline_exits(LegacyView(),models[0][side]['exit'],entries,sign,OLD_CFG['exit_thresholds'])
            for key in ['steps','time','valid','return']:np.testing.assert_allclose(revised[key],original[key],equal_nan=True,atol=1e-10)
            parity+=len(entries)*3
    # Additional unknown entry rows must not change any fitted row or target.
    for plan in PLANS:
        train,val=data.split(ms(plan['start']),ms(plan['validation_start']))
        assert np.all(train<data.original_candidate_count) and np.all(val<data.original_candidate_count)
        for side in ['long','short']:
            folder=CACHE/'prepared'/plan['start'][:10]/side/'entry'
            for split,ids,xname,yname in [('train',train,'raw','y'),('validation',val,'vraw','vy')]:
                ids=ids[data.c['side'][ids]==(1 if side=='long' else -1)]
                np.testing.assert_array_equal(data.labels[ids],np.load(folder/(yname+'.npy')))
                np.testing.assert_allclose(data.entry_rows(ids),np.load(folder/(xname+'.npy')),equal_nan=True,atol=0)
    lost=json.loads((HERE.parent/'data-label-audit-2026-11-15/missing-exits.json').read_text())['cases']
    admitted=set(data.c['row'][data.replay_ids(ms(PLANS[0]['start']),ms(PLANS[0]['end']),quality=False)])
    # Old missing-exit evidence has globally indexed entry rows.
    removed=0
    for item in lost:
        entry=item.get('entry_index')
        if entry is not None:assert entry not in admitted;removed+=1
    original_reports=0
    for folder in [OLD,HERE.parent/'seed-diagnosis-2026-11-14']:
        for name,digest in json.loads((folder/'delivery-manifest.json').read_text())['files'].items():assert file_hash(folder/name)==digest;original_reports+=1
    for label in ['training','replay']:
        for name,digest in json.loads((HERE/(label+'-lock.json')).read_text())['files'].items():assert file_hash(HERE/name)==digest
    Policy(HERE/'models')
    write('validation.json',{'status':'passed','trade_records_recomputed':checks,'independent_raw_price_checks':source_checks,'baseline_exit_parity_comparisons':parity,'unchanged_training_and_validation_entry_matrices':16,'preserved_original_report_files':original_reports,'old_unpriced_entry_paths_excluded':removed,'new_unknown_entry_rows_do_not_enter_training':True,'fees':0,'historical_publication_certified':False,'research_periods_previously_examined':True})
    print(json.dumps({'status':'passed','trades':checks,'raw_price_checks':len(source_checks),'baseline_parity':parity,'removed_old_missing_paths':removed}),flush=True)

if __name__=='__main__':
    with threadpool_limits(limits=1):main()
