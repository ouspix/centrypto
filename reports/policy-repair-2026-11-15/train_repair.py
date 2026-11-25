from repair_data import *
from repair_network import fit
import time, concurrent.futures, multiprocessing

def prepare():
    data=RepairData();meta=[]
    for p in PLANS:
        train,val=data.split(ms(p['start']),ms(p['validation_start']))
        for side,name,offset in [(1,'long',0),(-1,'short',10)]:
            ids=train[data.c['side'][train]==side];vid=val[data.c['side'][val]==side]
            assert not set(data.c['setup'][ids])&set(data.c['setup'][vid])
            for kind in ['entry','exit']:
                folder=CACHE/'prepared'/p['start'][:10]/name/kind;folder.mkdir(parents=True,exist_ok=True)
                if kind=='entry':
                    raw=data.entry_rows(ids);y=np.array(data.labels[ids]);vraw=data.entry_rows(vid);vy=np.array(data.labels[vid]);rows=data.c['row'][ids];names=data.entry_names;core=ENTRY_CORE
                    _,reference=np.unique(rows,return_index=True)
                else:
                    raw,y,entries,rows=data.exit_dataset(ids,side,6000,130+offset)
                    vraw,vy,_,_=data.exit_dataset(vid,side,1500,140+offset)
                    names=data.exit_names;core=EXIT_CORE;reference=np.arange(len(y))
                groups=np.array([str(int(data.d.state['series'][r]))+'/'+str(int(data.d.state['time'][r]//86400000)) for r in rows])
                assert min(int(y.sum()),int((y==0).sum()))>=5,(p,name,kind,'insufficient train labels')
                for key,value in [('raw',raw),('y',y),('vraw',vraw),('vy',vy),('groups',groups),('reference',reference)]: np.save(folder/(key+'.npy'),value)
                write(str(folder.relative_to(CACHE)/'schema.json'),{'names':names,'core':core},True)
                meta.append({'fold':p['start'],'side':name,'kind':kind,'training_rows':len(y),'training_positive':int(y.sum()),'validation_rows':len(vy),'validation_positive':int(vy.sum())})
        print(json.dumps({'prepared':p['start']}),flush=True)
    write('prepared.json',meta)

def task(args):
    fold,side,kind,seed=args; path=CACHE/'models'/fold/f'{side}_{kind}_{seed}.joblib'
    if path.exists(): return {'fold':fold,'side':side,'kind':kind,'seed':seed,'cached':True}
    folder=CACHE/'prepared'/fold/side/kind;schema=json.loads((folder/'schema.json').read_text());started=time.time()
    with threadpool_limits(limits=1):
        arrays=[np.load(folder/(n+'.npy'),mmap_mode='r') for n in ['raw','y','vraw','vy']]
        model,audit=fit(*arrays,schema['names'],schema['core'],np.load(folder/'groups.npy'),np.load(folder/'reference.npy'),seed,kind,side)
    path.parent.mkdir(parents=True,exist_ok=True);tmp=path.with_suffix('.tmp');joblib.dump(model,tmp,compress=3);os.replace(tmp,path)
    audit['fold']=fold;audit['seconds']=time.time()-started;write('training/'+path.stem+'__'+fold+'.json',audit)
    return {'fold':fold,'side':side,'kind':kind,'seed':seed,'seconds':audit['seconds']}

def main():
    sources={n:file_hash(HERE/n) for n in ['repair_common.py','repair_data.py','repair_network.py','train_repair.py']}
    sources['config.json']=file_hash(HERE/'config.json')
    if (HERE/'training-lock.json').exists(): assert json.loads((HERE/'training-lock.json').read_text())['files']==sources,'Training source changed; use a new run namespace'
    else: write('training-lock.json',{'files':sources,'prior_candidate_hash':file_hash(OLD_CACHE/'candidates.npy'),'prior_setup_hash':file_hash(OLD_CACHE/'setups.npy')})
    prepare()
    tasks=[(p['start'][:10],side,kind,seed) for p in PLANS for side in ['long','short'] for kind in ['entry','exit'] for seed in SEEDS]
    done=[]
    with concurrent.futures.ProcessPoolExecutor(max_workers=2,mp_context=multiprocessing.get_context('spawn')) as pool:
        for result in pool.map(task,tasks):
            done.append(result);write('progress.json',{'completed':len(done),'total':len(tasks),'latest':result});print(json.dumps({'completed':len(done),**result}),flush=True)
    write('training-complete.json',{'models':len(done),'status':'passed'})

if __name__=='__main__':
    with threadpool_limits(limits=1): main()
