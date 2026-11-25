import joblib
from sklearn.metrics import average_precision_score
from four_common import *
sys.path.insert(0,str(HERE))
from analyze import load_runs,summarize_numbers
from schema import GROUPS
def main():
    runs=load_runs();partial='--partial' in sys.argv
    if not partial:assert len(runs)==240
    cache=CACHE/'diagnostic-scores';cache.mkdir(exist_ok=True)
    matrices={};scores={};report=[]
    for run in runs:
        fold=run['fold'][:10];record={'fold':run['fold'],'variant':run['variant'],'seed':run['seed'],'models':{}}
        for side,offset in [('long',0),('short',10)]:
            for kind,increment in [('entry',0),('exit',1)]:
                desc=run['models'][side+'_'+kind];seed=run['seed']+offset+increment;filename=f'{kind}_{side}_{seed}_{desc["mask_key"]}.joblib';key=(fold,filename)
                saved=cache/(fold+'_'+filename+'.json')
                if key not in scores and saved.exists():scores[key]=json.loads(saved.read_text())
                if key not in scores:
                    artifact=joblib.load(CACHE/'models'/fold/filename);matrix_key=(fold,side,kind)
                    if matrix_key not in matrices:
                        base=CACHE/'diagnostic-test'/fold;matrices[matrix_key]=(np.load(base/(side+'_'+kind+'_x.npy'),mmap_mode='r'),np.load(base/(side+'_'+kind+'_y.npy'),mmap_mode='r'))
                    x,y=matrices[matrix_key];pred=np.empty(len(y))
                    for i in range(0,len(y),4096):pred[i:i+4096]=artifact['model'].predict(x[i:i+4096]*artifact['preprocess'].mask)
                    scores[key]={'rows':len(y),'positives':int(y.sum()),'ap':float(average_precision_score(y,pred)) if np.any(y==1) else None}
                    saved.write_text(json.dumps(scores[key]))
                record['models'][side+'_'+kind]=scores[key]
        report.append(record)
    index={(r['variant'],r['seed'],r['fold']):r for r in report};effects=[];plans=json.loads((HERE/'fold-plan.json').read_text());seeds=json.loads((HERE/'experiment.json').read_text())['seeds']
    for group in GROUPS:
        if any((v,s,p['start']) not in index for v in ['core','full','add_'+group,'drop_'+group] for s in seeds for p in plans):continue
        effect={'group':group,'roles':{}}
        for role in ['long_entry','short_entry','long_exit','short_exit']:
            contexts={}
            for label,a,b in [('add_to_core','add_'+group,'core'),('full_minus_drop','full','drop_'+group)]:
                values=[]
                for seed in seeds:
                    per_fold=[]
                    for p in plans:
                        aa=index[(a,seed,p['start'])]['models'][role];bb=index[(b,seed,p['start'])]['models'][role]
                        assert aa['rows']==bb['rows'] and aa['positives']==bb['positives']
                        if aa['ap'] is not None and aa['positives']>=5:per_fold.append(aa['ap']-bb['ap'])
                    values.append({'seed':seed,'mean_ap_delta':float(np.mean(per_fold)) if per_fold else None,'folds':len(per_fold)})
                contexts[label]={'by_seed':values,'summary':summarize_numbers([v['mean_ap_delta'] for v in values])}
            effect['roles'][role]=contexts
        effects.append(effect)
    prefix='partial-' if partial else ''
    save(prefix+'test-classification.json',report);save(prefix+'classification-effects.json',effects)
    print(json.dumps({'models_scored':len(scores),'run_rows':len(report),'groups':len(effects)}))
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
