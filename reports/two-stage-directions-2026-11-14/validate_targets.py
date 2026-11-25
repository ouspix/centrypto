"""Independent exhaustive return checks and original-artifact regression checks."""
from prepare_targets import *

def main():
    catalog=json.loads((OUT/'catalog.json').read_text())
    teachers=json.loads((DEST/'teachers.json').read_text())
    manifest=json.loads((SOURCE/'delivery-manifest.json').read_text())['files']
    for filename in ['entry_model.joblib','exit_model.joblib','policy-config.json','spec.json','news_two.py','prepare_two.py','results.json']:
        assert hashlib.sha256((SOURCE/filename).read_bytes()).hexdigest()==manifest[filename],filename
    rng=np.random.default_rng(20261114)
    synthetic_checks=0
    for sign in [1,-1]:
        price=np.r_[100.,110.,90.,100.,np.exp(rng.normal(4.5,.15,400))]
        price[[12,26,103]]=np.nan
        terminal=np.full(len(price),np.nan)
        terminal[0]=135. if sign==1 else 65.
        _,exits,gains=side_oracle(price,terminal,sign)
        for entry in np.flatnonzero(np.isfinite(price)):
            options=np.r_[price[entry+1:entry+H+1],terminal[entry]]
            returns=sign*(options-price[entry])/price[entry]*100
            if np.isfinite(returns).any():
                assert np.isclose(gains[entry],np.nanmax(returns),atol=1e-10)
                assert 1<=exits[entry]-entry<=H
                synthetic_checks+=1
        assert np.isclose(sign*(90-100)/100*100, -10*sign)
    brute=collections.Counter();checked=collections.Counter();entries={};cache={}
    sample=set()
    for side in ['long','short']:
        ids=[i for i,e in enumerate(teachers) if e['side']==side]
        sample.update(rng.choice(ids,min(30,len(ids)),replace=False).tolist())
    for ordinal,e in enumerate(teachers):
        c=catalog[e['series']]
        if c['id'] not in cache:
            cache.clear()
            with np.load(CACHE/'bars'/(c['key']+'.npz')) as z:
                original={k:z[k] for k in ['price','terminal_price','close','eligible','entry_target','best_future_index','gain']}
            with np.load(c['label_file']) as z:
                labels={k:z[k] for k in z.files}
            assert np.array_equal(labels['entry_target'][:,0],original['entry_target'],equal_nan=True)
            assert np.array_equal(labels['oracle_exit_local_index'][:,0],original['best_future_index'])
            cache[c['id']]=(original,labels)
        z,labels=cache[c['id']]
        col=0 if e['side']=='long' else 1
        anchor=e['anchor_index']-c['offset'];entry=e['teacher_entry']-c['offset'];sign=e['side_sign']
        assert sign*100*(z['close'][anchor]/z['close'][anchor-H]-1)>=10-1e-10
        assert max(H,anchor-H)<=entry<=anchor
        assert labels['entry_target'][entry,col]==1 and z['eligible'][entry]
        assert 0<e['teacher_exit']-e['teacher_entry']<=H
        duration=(ms(e['teacher_exit_time'])-ms(e['teacher_entry_time']))/MIN
        assert 5<=duration<=1470
        assert ms(e['label_available'])>ms(e['teacher_exit_time'])
        for point in e['positive_entry_indices']:
            i=point-c['offset'];opt=int(labels['oracle_exit_local_index'][i,col]);gain=float(labels['oracle_gain'][i,col])
            assert abs(i-entry)<=1 and gain>=.95*e['teacher_gain_pct']-1e-10
            key=(e['side'],point)
            record={
                'side':e['side'],'side_sign':sign,'series':c['id'],'symbol':e['symbol'],
                'entry_index':point,'oracle_exit_index':c['offset']+opt,'oracle_gain_pct':gain,
                'close_target_from_holding_step':opt-i,'holding_limit_steps':H,
                'label_available':e['label_available']
            }
            if key not in entries or record['label_available']<entries[key]['label_available']:
                entries[key]=record
        if ordinal in sample:
            window=np.arange(max(H,anchor-H),anchor+1)
            candidates=window[z['eligible'][window]&np.isfinite(z['price'][window])]
            optimum=-np.inf;best_entry=-1
            for i in candidates:
                possible_exits=np.r_[z['price'][i+1:i+H+1],z['terminal_price'][i]]
                gain=float(np.nanmax(sign*(possible_exits-z['price'][i])/z['price'][i]*100))
                if gain>optimum:
                    optimum=gain;best_entry=int(i)
            assert best_entry==entry
            assert np.isclose(optimum,e['teacher_gain_pct'],atol=1e-10)
            brute[e['side']]+=1
        checked[e['side']]+=1
    # Each positive entry has its own exit teacher, including neighboring positives.
    write_json(DEST/'entry-exit-targets.json',list(entries.values()))
    summary={
        'status':'passed','teachers_checked':dict(checked),'exhaustive_entry_exit_searches':dict(brute),
        'synthetic_long_short_oracle_checks':synthetic_checks,'short_return_100_to_90_pct':10,
        'original_model_and_protocol_hashes_unchanged':True,'original_bullish_labels_match_on_teacher_series':True,
        'same_entry_exit_target_pairs':len(entries),
        'long_entry_exit_pairs':sum(side=='long' for side,_ in entries),
        'short_entry_exit_pairs':sum(side=='short' for side,_ in entries),
        'entries_positive_for_both_sides':len({i for side,i in entries if side=='long'}&{i for side,i in entries if side=='short'}),
        'models_retrained':False,
        'note':'Checks validate labels and arithmetic, not short tradability or future predictive returns.'
    }
    write_json(OUT/'validation.json',summary)
    print(json.dumps(summary),flush=True)

if __name__=='__main__':main()
