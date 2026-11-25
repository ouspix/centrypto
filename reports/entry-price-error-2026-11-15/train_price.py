from price_common import *
from price_network import fit
import joblib,time,concurrent.futures,multiprocessing

def prepare():
    data=PriceData();profile=[];targets=[]
    for e in data.episodes:
        cat=data.d.catalog[e['series']]
        targets.append({k:e[k] for k in ['setup','side','target_row','target_id','target_price','best_gain','skip_cost','qualifies','start','completion']}|{
            'symbol':cat['symbol'],'period':cat['period'],'candidate_count':len(e['ids']),
            'entry_time':iso(data.d.state['time'][e['target_row']]+55000)})
    write('targets.json',targets,True)
    write('label-profile.json',{'complete_episodes':len(targets),'qualifying_episodes':sum(e['qualifies'] for e in data.episodes),
        'failed_episodes':sum(not e['qualifies'] for e in data.episodes),'incomplete_episodes':len(data.dropped),
        'multi_candidate_episodes':sum(len(e['ids'])>1 for e in data.episodes),'restored_candidates':data.restored})
    for p in PLANS:
        for side,name in [(1,'long'),(-1,'short')]:
            folder=CACHE/'prepared'/p['start'][:10]/name;folder.mkdir(parents=True,exist_ok=True)
            train=data.episode_ids(p,'train',side);val=data.episode_ids(p,'validation',side)
            assert not set(train)&set(val)
            for tag,ids in [('train',train),('validation',val)]:
                pack=data.pack(ids);joblib.dump(pack,folder/f'{tag}.joblib',compress=0)
                profile.append(dict(fold=p['start'],side=name,part=tag,episodes=len(ids),qualifying=int(pack['success'].sum()),candidates=len(pack['ids'])))
            write(str(folder.relative_to(CACHE)/'schema.json'),{'names':data.entry_names},True)
    write('prepared.json',profile)
    print(json.dumps({'prepared':profile}),flush=True)

def task(args):
    fold,side,seed=args;folder=CACHE/'prepared'/fold/side;dest=CACHE/'models'/fold/f'{side}_entry_{seed}.joblib'
    if dest.exists():return {'fold':fold,'side':side,'seed':seed,'cached':True}
    started=time.time()
    with threadpool_limits(limits=1):
        train=joblib.load(folder/'train.joblib',mmap_mode='r');val=joblib.load(folder/'validation.joblib',mmap_mode='r')
        names=json.loads((folder/'schema.json').read_text())['names'];model,audit=fit(train,val,names,seed,side)
    dest.parent.mkdir(parents=True,exist_ok=True);joblib.dump(model,dest,compress=3)
    audit['seconds']=time.time()-started;audit['fold']=fold
    write(f'training/{fold}_{side}_{seed}.json',audit)
    return {'fold':fold,'side':side,'seed':seed,'seconds':audit['seconds']}

def main():
    locked={n:file_hash(HERE/n) for n in ['config.json','price_common.py','price_network.py','train_price.py']}
    baseline={str(p.relative_to(REPAIR_CACHE)):file_hash(p) for p in (REPAIR_CACHE/'models').rglob('*.joblib')}
    lock={'files':locked,'frozen_baseline_models':baseline}
    if (HERE/'training-lock.json').exists():assert json.loads((HERE/'training-lock.json').read_text())==lock,'Source or baseline changed'
    else:write('training-lock.json',lock)
    if not (HERE/'prepared.json').exists():prepare()
    tasks=[(p['start'][:10],side,seed) for p in PLANS for side in ['long','short'] for seed in SEEDS]
    with concurrent.futures.ProcessPoolExecutor(max_workers=2,mp_context=multiprocessing.get_context('spawn')) as pool:
        for count,result in enumerate(pool.map(task,tasks),1):
            write('progress.json',{'completed':count,'total':len(tasks),'latest':result});print(json.dumps({'completed':count,**result}),flush=True)
    write('training-complete.json',{'networks':len(tasks),'logical_entry_models':2,'folds':len(PLANS),'seeds':SEEDS})

if __name__=='__main__':
    with threadpool_limits(limits=1):main()
