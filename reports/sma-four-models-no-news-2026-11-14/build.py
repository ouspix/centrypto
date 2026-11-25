from four_common import *
from detectors import crossings
SETUP_DTYPE=[('id','i4'),('series','i4'),('detect','i4'),('last','i4'),('side','i1'),('pair','i1'),('time','i8'),('completion','i8'),('known','?'),('best_gain','f8')]
CANDIDATE_DTYPE=[('setup','i4'),('row','i4'),('pair','i1'),('side','i1'),('age','i1'),('label','f4'),('gain','f8')]
def main():
    verify_original();d=Data();setups=[];candidates=[];count=collections.Counter()
    for c in d.catalog:
        o,n=c['offset'],c['bars'];price=np.asarray(d.state['price'][o:o+n]);eligible=d.state['eligible'][o:o+n]&np.isfinite(price)
        with np.load(BASE_CACHE/'bars'/(c['key']+'.npz')) as z:signals=crossings(z['close'],CFG['pairs'])
        finite=np.isfinite(price);cum=np.cumsum(np.r_[0,finite]);coverage=np.zeros(n)
        if n>H:coverage[:n-H]=(cum[H+1:]-cum[1:n-H+1])/H
        quality=(coverage>=CFG['minimum_future_price_coverage'])&np.isfinite(d.state['terminal_price'][o:o+n])
        for pair_id,pair in enumerate(CFG['pairs']):
            for side,name,other in [(1,'long','short'),(-1,'short','long')]:
                cross=np.flatnonzero(signals[tuple(pair)][name]);opposite=np.flatnonzero(signals[tuple(pair)][other])
                cached=d.sma[o:o+n,d.sma_names.index(f'sma_pair_{pair[0]}_{pair[1]}_cross_'+('up' if side==1 else 'down'))]
                assert np.array_equal(signals[tuple(pair)][name],np.nan_to_num(cached)>0),c['key']
                for start in cross:
                    nexts=opposite[opposite>start];last=min(n-1,int(start)+CFG['entry_window_bars'],int(nexts[0])-1 if len(nexts) else n-1)
                    local=np.arange(start,last+1);local=local[eligible[local]]
                    if not len(local):continue
                    rows=o+local;sid=len(setups);col=0 if side==1 else 1;gains=np.array(d.oracle_gains[rows,col])
                    known=bool(quality[local].all() and np.isfinite(gains).all() and start+CFG['entry_window_bars']+H<n)
                    best=float(gains.max()) if known else np.nan
                    at=int(d.state['time'][o+start]);completion=at+CFG['conservative_label_maturity_minutes']*MIN
                    setups.append((sid,c['id'],o+start,o+last,side,pair_id,at,completion,known,best))
                    for row,age,gain in zip(rows,local-start,gains):
                        y=float(gain>=CFG['success_gain_pct'] and gain>=CFG['near_optimal_fraction']*best) if known else np.nan
                        candidates.append((sid,int(row),pair_id,side,int(age),y,float(gain)))
                    count[c['period']+'_'+name+'_setups']+=1
        if (c['id']+1)%150==0:print(json.dumps({'series':c['id']+1,'setups':len(setups),'candidates':len(candidates)}),flush=True)
    setup=np.array(setups,dtype=SETUP_DTYPE);candidate=np.array(candidates,dtype=CANDIDATE_DTYPE)
    np.save(CACHE/'setups.npy',setup);np.save(CACHE/'candidates.npy',candidate)
    profile={'counts':dict(count),'setups':len(setup),'candidate_rows':len(candidate),'by_side':{}}
    for side,name in [(1,'long'),(-1,'short')]:
        s=setup[setup['side']==side];v=s[s['known']];c=candidate[candidate['side']==side]
        profile['by_side'][name]={'setups':len(s),'known_setups':len(v),'unknown_setups':int((~s['known']).sum()),
           'successful_10pct':int((v['best_gain']>=10).sum()),'failed_to_reach_10pct':int((v['best_gain']<10).sum()),
           'no_profitable_observed_entry_exit':int((v['best_gain']<=0).sum()),'positive_candidates':int((c['label']==1).sum()),
           'negative_candidates':int((c['label']==0).sum()),'unknown_candidates':int(np.isnan(c['label']).sum())}
    save('dataset-profile.json',profile);print(json.dumps(profile),flush=True)
if __name__=='__main__':main()
