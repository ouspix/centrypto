"""Coverage-only chronological split diagnostics; no predicted profits."""
from dataset_two import *
d=Data();out=[];news_column=d.news_names.index('news_feed_available')
for day in ['2026-11-11','2026-11-12','2026-11-13','2026-11-14']:
    end=ms(day+'T00:00:00Z');train=d.labeled[d.completion[d.labeled]<end-1440*MIN];dates=np.unique(d.times[train]//86400000)
    for nd in [2,3,4]:
        start=int(dates[-nd]*86400000);inner=train[d.completion[train]<start-1440*MIN];val=train[d.times[train]>=start];known=d.news[inner,news_column]>0;out.append({'test_start':day,'validation_days':nd,'validation_start':iso(start),'validation_positives':int((d.state['target'][val]==1).sum()),'training_news_states':int(known.sum()),'training_news_positives':int(((d.state['target'][inner]==1)&known).sum())})
save('split-coverage.json',out);print(json.dumps(out,indent=2))
