"""Public historical closed 5m spot candles with explicit symbol units."""
import urllib.request,urllib.error,time,concurrent.futures
from common_two import *
MULTIPLIERS={'kPEPE','kSHIB','kBONK','kFLOKI','kLUNC','kDOGS','kNEIRO','kBABYDOGE'}
def get(q):
    url='https://api.binance.com/api/v3/klines?'+urllib.parse.urlencode(q)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url,timeout=25) as r:return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in [429,418,500,502,503] and attempt<3:time.sleep(min(30,5*(attempt+1)));continue
            raise RuntimeError('HTTP '+str(e.code)) from None
        except (TimeoutError,urllib.error.URLError):
            if attempt==3:raise
            time.sleep(2)
def main():
    catalog=json.loads((HERE/'catalog.json').read_text());folder=CACHE/'spot';folder.mkdir(exist_ok=True)
    def one(c):
        file=folder/(c['key']+'.json.gz');symbol=c['symbol'];pair=(symbol[1:] if symbol in MULTIPLIERS else symbol)+'USDT';rows=[];failures=[];excluded=symbol in ['LIT','kNEIRO','NEIROETH'];lo=ms(c['start']);hi=ms(c['end'])-1
        if file.exists():result=gz(file)
        else:
            if not excluded:
                while lo<=hi:
                    try:page=get({'symbol':pair,'interval':'5m','startTime':lo,'endTime':hi,'limit':1000})
                    except Exception as e:failures.append(str(e));break
                    if not isinstance(page,list) or not page:break
                    rows.extend(r for r in page if int(r[6])<=hi);nxt=int(page[-1][0])+BAR
                    if nxt<=lo:break
                    lo=nxt
            result={'pair':pair,'multiplier':1000 if symbol in MULTIPLIERS else 1,'rows':rows,'failures':failures,'excluded_ambiguous':excluded};file.write_bytes(gzip.compress(json.dumps(result).encode()))
        return {'key':c['key'],'rows':len(result['rows']),'failures':result['failures'],'excluded_ambiguous':result['excluded_ambiguous'],'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}
    result=[];requested=[c for c in catalog if c['eligible_states'] or c['symbol'] in ['BTC','ETH']]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for item in pool.map(one,requested):
            result.append(item)
            if len(result)%30==0:print('Spot',len(result),'/',len(requested),flush=True)
    save('spot-manifest.json',{'source':'Binance public closed five-minute klines','series':result,'rows':sum(r['rows'] for r in result)});print('Spot complete',sum(r['rows'] for r in result),flush=True)
if __name__=='__main__':main()
