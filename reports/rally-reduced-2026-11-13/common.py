import csv,datetime as dt,gzip,importlib.util,json,pathlib,urllib.parse
import numpy as np
HERE=pathlib.Path(__file__).resolve().parent;ROOT=HERE.parent.parent
SPEC=json.loads((HERE/'spec.json').read_text());PATHS=json.loads((HERE/'paths.json').read_text());CACHE=pathlib.Path(PATHS['external_linux'])
OLD=HERE.parent/'rally-replay-2026-11-13';WIDE=HERE.parent/'rally-model-2026-11-13';CTX=HERE.parent/'rally-replay-context-2026-11-13'
MIN=60000
def ms(s):return int(dt.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000)
def iso(t):return dt.datetime.fromtimestamp(t/1000,dt.timezone.utc).isoformat().replace('+00:00','Z')
def gz(p):
    with gzip.open(p,'rt',encoding='utf-8') as f:return json.load(f)
def save(name,obj):
    p=HERE/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(obj,indent=2,allow_nan=False),encoding='utf-8')
def csvrows(p):
    with p.open(newline='',encoding='utf-8') as f:return list(csv.DictReader(f))
def writecsv(name,rows):
    if not rows:return
    with (HERE/name).open('w',newline='',encoding='utf-8') as f:w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
def module(name,file):
    s=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def period_arrays(period):
    start,end=ms(period['start']),ms(period['end']);n=(end-start)//MIN
    if period['id']=='recent':
        symbols=sorted(set(r['symbol'] for r in json.loads((OLD/'manifest.json').read_text())['symbols'])|set(r['symbol'] for r in json.loads((HERE/'recent-manifest.json').read_text())['recent']['symbols']))
    else:symbols=[r['symbol'] for r in json.loads((HERE/'older-manifest.json').read_text())['periods'][period['id']]]
    arrays={};quality=[]
    for symbol in symbols:
        if ':' in symbol or '@' in symbol:continue
        file=urllib.parse.quote(symbol,safe='')+'.json.gz';sources=[OLD/'data'/file,CACHE/'candles/nov13'/file] if period['id']=='recent' else [CACHE/'candles'/period['id']/file]
        rows=[]
        for p in sources:
            if p.exists():rows.extend(gz(p)['rows'])
        if not rows:continue
        a=np.array(rows,dtype=float);idx=((a[:,0]-start)/MIN).astype(int);valid=(a[:,0]%MIN==0)&(idx>=0)&(idx<n)&np.isfinite(a).all(axis=1)&(a[:,1:5]>0).all(axis=1)&(a[:,5]>=0)&(a[:,2]>=a[:,1:5].max(axis=1))&(a[:,3]<=a[:,1:5].min(axis=1))
        assert len(np.unique(a[:,0]))==len(a),symbol
        dense=np.full((n,5),np.nan);dense[idx[valid]]=a[valid,1:6];arrays[symbol]=dense
        quality.append({'period':period['id'],'symbol':symbol,'source_rows':len(a),'invalid_rows':int((~valid).sum()),'observed_minutes':int(valid.sum()),'period_minutes':n})
    return arrays,quality
