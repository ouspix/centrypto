import joblib
from four_common import *
from data_four import FourData
from schema import group_for,GROUPS
def write_dataset(folder,raw,y,vraw,vy,names,kind):
    folder.mkdir(exist_ok=True,parents=True);pre=Preprocess().fit(raw,names)
    np.save(folder/'train-x.npy',pre.transform(raw));np.save(folder/'train-y.npy',y)
    np.save(folder/'val-x.npy',pre.transform(vraw));np.save(folder/'val-y.npy',vy)
    joblib.dump(pre,folder/'preprocess.joblib',compress=3)
    coverage={}
    for group in ['mandatory']+GROUPS:
        columns=[i for i,n in enumerate(names) if group_for(n,kind)==group]
        if not columns:coverage[group]={'raw_features':0,'retained':0,'observed_fraction':None};continue
        coverage[group]={'raw_features':len(columns),'retained':sum(group_for(n,kind)==group for n in pre.names),
            'observed_fraction':float(np.isfinite(raw[:,columns]).mean())}
    return {'training_rows':len(y),'training_positives':int(y.sum()),'validation_rows':len(vy),'validation_positives':int(vy.sum()),'coverage':coverage}
def main():
    data=FourData();plans=json.loads((HERE/'fold-plan.json').read_text());finalbase=json.loads((HERE.parent/'sma-four-models-no-news-2026-11-14/2026-11-15-audit.json').read_text())['plan']
    allplans=plans+[finalbase];metadata=[]
    for p in allplans:
        train,val=data.split(ms(p['start']),ms(p['validation_start']));base=CACHE/'prepared'/p['start'][:10]
        assert not set(data.c['setup'][train])&set(data.c['setup'][val])
        assert data.completion[train].max()<ms(p['validation_start'])-1440*MIN
        assert data.completion[val].max()<ms(p['start'])-1440*MIN
        audit={'plan':p,'sides':{}}
        for side,name,offset in [(1,'long',0),(-1,'short',10)]:
            ids=train[data.c['side'][train]==side];vid=val[data.c['side'][val]==side]
            y=np.array(data.c['label'][ids]);vy=np.array(data.c['label'][vid]);assert min(y.sum(),vy.sum(),(y==0).sum(),(vy==0).sum())>=5
            audit['sides'][name]={'entry':write_dataset(base/name/'entry',data.entry_rows(ids),y,data.entry_rows(vid),vy,data.entry_names,'entry')}
            ex,ey,em=data.exit_dataset(ids,side,CFG['exit_training_max_entries_per_side'],130+offset)
            vx,evy,vm=data.exit_dataset(vid,side,CFG['exit_validation_max_entries_per_side'],140+offset)
            audit['sides'][name]['exit']=write_dataset(base/name/'exit',ex,ey,vx,evy,data.exit_names,'exit')
            audit['sides'][name]['exit_samples']={'train':em,'validation':vm}
            del ex,ey,vx,evy
        save('prepared/'+p['start'][:10]+'/metadata.json',audit,True);metadata.append(audit)
        print(json.dumps({'prepared':p['start'],'training_candidates':len(train),'validation_candidates':len(val)}),flush=True)
    save('data-coverage.json',metadata)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
