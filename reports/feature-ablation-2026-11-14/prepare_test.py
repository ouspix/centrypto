"""Independent diagnostic sets only; never used by fitting or policy selection."""
import joblib
from four_common import *
from data_four import FourData
def main():
    data=FourData();metadata=[]
    for p in json.loads((HERE/'fold-plan.json').read_text()):
        eligible=np.flatnonzero((data.setup_time>=ms(p['start']))&(data.completion<ms(p['end']))&np.isfinite(data.c['label']))
        fold=p['start'][:10];out=CACHE/'diagnostic-test'/fold;out.mkdir(parents=True,exist_ok=True)
        item={'fold':p['start'],'sides':{}}
        for side,name,offset in [(1,'long',0),(-1,'short',10)]:
            ids=eligible[data.c['side'][eligible]==side];x=data.entry_rows(ids);y=np.array(data.c['label'][ids]);item['sides'][name]={}
            for kind in ['entry','exit']:
                if kind=='exit':x,y,meta=data.exit_dataset(ids,side,CFG['exit_validation_max_entries_per_side'],150+offset)
                pre=joblib.load(CACHE/'prepared'/fold/name/kind/'preprocess.joblib')
                np.save(out/(name+'_'+kind+'_x.npy'),pre.transform(x));np.save(out/(name+'_'+kind+'_y.npy'),y)
                item['sides'][name][kind]={'rows':len(y),'positives':int(y.sum()),'prevalence':float(y.mean()) if len(y) else None}
        metadata.append(item)
    save('test-diagnostic-populations.json',metadata);print(json.dumps({'diagnostic_folds':len(metadata),'used_for_training':False}))
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
