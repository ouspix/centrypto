import pathlib,sys,json,numpy as np
here=pathlib.Path(__file__).resolve().parent;sys.path.insert(0,str(here.parent/'two-stage-rebuild-2026-11-14'))
from dataset import Data
d=Data();out={};pairs=[(3,12),(5,20),(8,30),(10,30),(10,50),(20,50),(20,80),(30,80)]
for period in ['apr','mayjun','recent']:
    counts={'eligible':0,'crossovers':0,'eligible_crossovers':0,'window_candidates':0}
    for c in d.catalog:
        if c['period']!=period:continue
        o,n=c['offset'],c['bars'];eligible=d.state['eligible'][o:o+n];counts['eligible']+=int(eligible.sum())
        for a,b in pairs:
            for direction in ['up','down']:
                cross=np.nan_to_num(d.sma[o:o+n,d.sma_names.index(f'sma_pair_{a}_{b}_cross_{direction}')])>0
                counts['crossovers']+=int(cross.sum());counts['eligible_crossovers']+=int((cross&eligible).sum())
                for offset in range(13):counts['window_candidates']+=int((cross[:n-offset]&eligible[offset:]).sum())
    out[period]=counts
print(json.dumps(out))
