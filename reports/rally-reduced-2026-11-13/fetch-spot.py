"""Merged pre-entry intervals avoid downloading the same historical candles repeatedly."""
import concurrent.futures,hashlib,time,urllib.request,urllib.error,urllib.parse
from common import *
from news import MULTIPLIERS
def get(q):
    url='https://api.binance.com/api/v3/klines?'+urllib.parse.urlencode(q)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url,timeout=25) as r:data=json.load(r)
            return json.loads(data) if isinstance(data,str) else data
        except urllib.error.HTTPError as e:
            body=e.read().decode()[:180]
            if e.code in [429,500,502,503] and attempt<2:time.sleep(2*(attempt+1));continue
            raise RuntimeError(f'HTTP {e.code}: {body}') from None
        except (TimeoutError,urllib.error.URLError):
            if attempt==2:raise
            time.sleep(1)

def main():
    trades=[r for r in csvrows(HERE/'trades.csv') if r['slippage_bps_per_side']=='0'];requested=collections.defaultdict(list)
    for r in trades:
        cut=ms(r['entry_time'])-5000;last=(cut//MIN-1)*MIN;requested[r['symbol']].append((last-1439*MIN,last+59999))
    old=gz(WIDE/'spot.json.gz');oldrows=collections.defaultdict(dict);invalid=set()
    for r in old:
        for row in r['rows']:oldrows[r['symbol']][int(row[0])]=row
        if 'Invalid symbol' in r.get('reason',''):invalid.add(r['pair'])
    folder=CACHE/'spot';folder.mkdir(exist_ok=True)
    def one(symbol):
        file=folder/(urllib.parse.quote(symbol,safe='')+'.json.gz');base=symbol[1:] if symbol in MULTIPLIERS else symbol;pair=base+'USDT';multiplier=1000 if symbol in MULTIPLIERS else 1
        rows=oldrows[symbol].copy();failures=[]
        if file.exists():
            cached=gz(file);rows.update({int(r[0]):r for r in cached['rows']});failures=cached.get('failures',[])
        intervals=[]
        for lo,hi in sorted(requested[symbol]):
            if intervals and lo<=intervals[-1][1]+1:intervals[-1][1]=max(hi,intervals[-1][1])
            else:intervals.append([lo,hi])
        excluded=symbol in ['LIT','kNEIRO','NEIROETH']
        if not excluded and pair not in invalid:
            for lo,hi in intervals:
                cursor=lo
                while cursor<=hi:
                    if cursor in rows:cursor+=MIN;continue
                    try:page=get({'symbol':pair,'interval':'1m','startTime':cursor,'endTime':hi,'limit':1000})
                    except Exception as e:
                        failures.append(str(e))
                        if 'Invalid symbol' in str(e):invalid.add(pair)
                        break
                    if not isinstance(page,list) or not page:break
                    for r in page:
                        if int(r[6])<=hi:rows[int(r[0])]=r
                    nxt=int(page[-1][0])+MIN
                    if nxt<=cursor:break
                    cursor=nxt
                if pair in invalid:break
        out={'symbol':symbol,'pair':pair,'multiplier':multiplier,'status':'excluded_ambiguous' if excluded else 'observed' if rows else 'unavailable','rows':[rows[k] for k in sorted(rows)] if not excluded else [],'requested_intervals':intervals,'failures':list(dict.fromkeys(failures)),'retrievedAt':dt.datetime.now(dt.timezone.utc).isoformat()}
        payload=gzip.compress(json.dumps(out,separators=(',',':')).encode());file.write_bytes(payload)
        return {'symbol':symbol,'pair':pair,'multiplier':multiplier,'rows':len(out['rows']),'status':out['status'],'sha256':hashlib.sha256(payload).hexdigest(),'failures':out['failures']}
    items=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(one,s):s for s in sorted(requested)}
        for future in concurrent.futures.as_completed(futures):
            items.append(future.result())
            if len(items)%15==0:print('Spot symbols',len(items),'/',len(requested),'candles',sum(r['rows'] for r in items),flush=True)
    save('spot-manifest.json',{'symbols':sorted(items,key=lambda x:x['symbol']),'source':'Binance public historical 1m spot klines; merged pre-entry intervals; scaled k-contract units explicitly recorded','rows':sum(r['rows'] for r in items),'requested_entries':len(trades)})
    print('Spot complete',len(items),sum(r['rows'] for r in items),flush=True)
if __name__=='__main__':
    import collections
    main()
