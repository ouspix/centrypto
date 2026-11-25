import pathlib,json,gzip,hashlib,datetime as dt,collections,urllib.parse,csv
import numpy as np
HERE=pathlib.Path(__file__).resolve().parent;ROOT=HERE.parent.parent
SPEC=json.loads((HERE/'spec.json').read_text());PATHS=json.loads((HERE/'paths.json').read_text());CACHE=pathlib.Path(PATHS['external_linux']);CACHE.mkdir(parents=True,exist_ok=True)
BASE=HERE.parent/'two-stage-policy-2026-11-14';BASE_CACHE=pathlib.Path(PATHS['base_linux']);TARGETS=pathlib.Path(PATHS['targets_linux'])
MIN=60000;BAR=5*MIN;H=288;PAIRS=SPEC['sma_pairs']
def ms(s):return int(dt.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000)
def iso(t):return dt.datetime.fromtimestamp(int(t)/1000,dt.timezone.utc).isoformat().replace('+00:00','Z')
def gz(p):
    with gzip.open(p,'rt',encoding='utf-8') as f:return json.load(f)
def save(name,value,external=False):
    p=(CACHE if external else HERE)/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value,indent=2,allow_nan=False),encoding='utf-8')
def rolling(v,w):
    c=np.cumsum(np.r_[0.,np.where(np.isfinite(v),v,0)]);out=np.full(len(v),np.nan)
    if w<=len(v):out[w-1:]=c[w:]-c[:-w]
    return out
def lag(v,w):return np.r_[np.full(w,np.nan),v[:-w]] if w else v
def safe(a,b):return np.divide(a,b,out=np.full(np.broadcast_shapes(np.shape(a),np.shape(b)),np.nan),where=np.isfinite(a)&np.isfinite(b)&(b!=0))
def sma(v,n):return np.where(rolling(np.isfinite(v),n)==n,rolling(v,n)/n,np.nan)
def minute_array(period,symbol):
    start,end=ms(period['start']),ms(period['end']);n=(end-start)//MIN;rows=np.array(gz(BASE_CACHE/'candles'/period['id']/(urllib.parse.quote(symbol,safe='')+'.json.gz'))['rows'],float);a=np.full((n,5),np.nan)
    if not len(rows):return a,{'rows':0,'invalid':0}
    assert len(np.unique(rows[:,0]))==len(rows);idx=((rows[:,0]-start)//MIN).astype(int);ok=(rows[:,0]%MIN==0)&(idx>=0)&(idx<n)&np.isfinite(rows).all(axis=1)&(rows[:,1:5]>0).all(axis=1)&(rows[:,5]>=0)&(rows[:,2]>=rows[:,1:5].max(axis=1))&(rows[:,3]<=rows[:,1:5].min(axis=1));a[idx[ok]]=rows[ok,1:6]
    return a,{'rows':len(rows),'invalid':int((~ok).sum())}
def future_best(p,h=H):
    q=collections.deque();value=np.full(len(p),np.nan);which=np.full(len(p),-1,int)
    for i in range(len(p)-2,-1,-1):
        while q and q[0]>i+h:q.popleft()
        j=i+1
        if np.isfinite(p[j]):
            while q and p[q[-1]]<=p[j]:q.pop()
            q.append(j)
        if q:value[i]=p[q[0]];which[i]=q[0]
    return value,which
def csvwrite(name,rows):
    if rows:
        with (HERE/name).open('w',newline='',encoding='utf-8') as f:w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
