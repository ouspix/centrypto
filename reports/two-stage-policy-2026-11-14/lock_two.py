"""Freeze the specified supervised experiment before any model fitting."""
from common_two import *
code=['spec.json','common_two.py','prepare_two.py','news_two.py','features_two.py','dataset_two.py','model_two.py','replay_two.py','train_two.py'];data=['market.npy','news.npy','state.npy','teachers.json'];lock={'at':dt.datetime.now(dt.timezone.utc).isoformat(),'note':'Current protocol frozen before its next fit. Initial models were already fitted; subsequent repairs are disclosed in amendments. These historical periods were previously researched. The user replaced SMA-gated targets with all-token >=10% rolling24h rallies.','code':{},'data':{},'metadata':{},'amendments':{}}
for name in ['archive-boundary-correction.json','news-split-amendment.json']:
    if (HERE/name).exists():lock['amendments'][name]=json.loads((HERE/name).read_text(encoding='utf-8-sig'))
for name in code:lock['code'][name]=hashlib.sha256((HERE/name).read_bytes()).hexdigest()
for name in data:lock['data'][name]=hashlib.sha256((CACHE/name).read_bytes()).hexdigest();print('Locked',name,flush=True)
for name in ['catalog.json','market-feature-names.json','news-feature-names.json']:lock['metadata'][name]=hashlib.sha256((HERE/name).read_bytes()).hexdigest()
save('experiment-lock.json',lock)
