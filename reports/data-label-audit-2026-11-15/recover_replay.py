"""Reconstruct a damaged derived record; preserve the damaged original."""
from audit_common import *
from masked import MaskedPreprocess,cache_key
from engine import prepare

def main():
    name='add_derivatives__20261115__2026-06-01.json';variant='add_derivatives';seed=20261115;p=PLANS[0];groups=['derivatives'];data=FourData();models={};desc={}
    for side,offset in [('long',0),('short',10)]:
        models[side]={}
        for kind,increment in [('entry',0),('exit',1)]:
            folder=CACHE/'prepared'/p['start'][:10]/side/kind;pre=joblib.load(folder/'preprocess.joblib');key=cache_key(MaskedPreprocess(pre,groups,kind).mask)
            a=joblib.load(CACHE/'models'/p['start'][:10]/f'{kind}_{side}_{seed+offset+increment}_{key}.joblib');models[side][kind]=a
            desc[side+'_'+kind]={'updates':a['updates'],'mask_key':key}
    val=prepare(data,models,ms(p['validation_start']),ms(p['start'])-1440*MIN);policies={};trials={}
    for side in models:
        best={'cash':True,'entry_threshold':None,'exit_threshold':None,'validation_pnl_usd':0.};trials[side]=[]
        for et,xt in itertools.product(CFG['entry_thresholds'],CFG['exit_thresholds']):
            policy={s:{'cash':True} for s in models};policy[side]={'cash':False,'entry_threshold':et,'exit_threshold':xt}
            trades,_=replay(data,val,policy,p['start']);stats=totals(trades);trials[side].append({'entry_threshold':et,'exit_threshold':xt,**stats})
            if not stats['censored'] and stats['trades']>=5 and stats['gross_pnl_usd']>best['validation_pnl_usd']+1e-9:best={'cash':False,'entry_threshold':et,'exit_threshold':xt,'validation_pnl_usd':stats['gross_pnl_usd']}
        policies[side]=best
    selected={s:models[s] if not policies[s]['cash'] else {'untrained':True} for s in models}
    test=prepare(data,selected,ms(p['start']),ms(p['end']),{s:[policies[s]['exit_threshold']] for s in models});trades,meta=replay(data,test,policies,p['start'],variant)
    recovered={'variant':variant,'seed':seed,'fold':p['start'],'end':p['end'],'groups':groups,'models':desc,'policies':policies,'selection':trials,'test':{**totals(trades),**meta},'by_side':{s:totals([t for t in trades if t['side']==s]) for s in models},'trades':trades,'final':False}
    others=[json.loads(f.read_text()) for f in (CACHE/'runs').glob(f'{variant}__{seed}__*.json') if f.name!=name]
    alltrades=trades+[t for r in others for t in r['trades']];actual=totals(alltrades)
    target=next(r for r in json.loads((BASE/'results.json').read_text())['variants'][variant]['seeds'] if r['seed']==seed)
    for k in ['trades','censored','priced','wins','losses']:assert actual[k]==target[k],k
    assert np.isclose(actual['priced_subtotal_usd'],target['priced_subtotal_usd'],atol=1e-8)
    out=OUT_CACHE/'recovered-runs';out.mkdir(exist_ok=True);(out/name).write_text(json.dumps(recovered))
    bad=(CACHE/'runs'/name).read_bytes();write('recovery-audit.json',{'status':'reconstructed_and_verified','original_preserved':True,'source':str(CACHE/'runs'/name),'original_sha256':hashlib.sha256(bad).hexdigest(),'leading_zero_bytes':next((i for i,v in enumerate(bad) if v),len(bad)),
        'reconstructed':str(out/name),'checks':'Reused saved model weights, frozen data and original validation selection; combined four-fold trade counts, wins/losses, censoring and PnL match the retained original aggregate.', 'fold_test':recovered['test']})
    print(json.dumps({'recovered':name,'test':recovered['test']}),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
