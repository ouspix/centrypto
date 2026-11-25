import joblib
from four_common import *
from data_four import FourData
from masked import MaskedPreprocess
from schema import GROUPS,group_for
def main():
    data=FourData();rng=np.random.default_rng(14);plans=json.loads((HERE/'fold-plan.json').read_text());checks=0
    baseline=CACHE.parent/'sma-four-models-no-news-2026-11-14'
    for p in plans:
        train,val=data.split(ms(p['start']),ms(p['validation_start']))
        for side in ['long','short']:
            for kind in ['entry','exit']:
                path=CACHE/'prepared'/p['start'][:10]/side/kind;pre=joblib.load(path/'preprocess.joblib')
                old=joblib.load(baseline/'fits'/p['start'][:10]/(side+'_'+kind+'.joblib'))['preprocess']
                assert pre.names==old.names and pre.input_names==old.input_names
                for attr in ['columns','median','mean','scale','indicators']:assert np.array_equal(getattr(pre,attr),getattr(old,attr)),(p['start'],side,kind,attr)
                core=MaskedPreprocess(pre,[],kind);full=MaskedPreprocess(pre,GROUPS,kind);assert np.all(full.mask==1)
                raw=rng.normal(size=(30,len(pre.input_names))).astype('f4');changed=raw.copy()
                optional=[i for i,n in enumerate(pre.input_names) if group_for(n,kind)!='mandatory'];changed[:,optional]=np.nan
                assert np.array_equal(core.transform(raw),core.transform(changed))
                changed[:,optional]=1e20;assert np.array_equal(core.transform(raw),core.transform(changed))
                assert np.array_equal(full.transform(raw),pre.transform(raw));checks+=1
                for g in GROUPS:
                    off=MaskedPreprocess(pre,[x for x in GROUPS if x!=g],kind)
                    for j,n in enumerate(pre.names):
                        if group_for(n,kind)==g:
                            assert off.mask[j]==0
                            if j in pre.indicators:assert off.mask[len(pre.names)+int(np.flatnonzero(pre.indicators==j)[0])]==0
    save('preflight-validation.json',{'status':'passed','matching_baseline_preprocessors':checks,'inactive_values_and_missingness_masked':True,
       'all_groups_partitioned':True,'full_mask_reproduces_original_transform':True,'original_files_verified':verify_original()})
    save('experiment-lock.json',{'files':lock(),'rules_fixed_before_runs':True})
    print(json.dumps({'preflight':'passed','matching_preprocessors':checks}),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
