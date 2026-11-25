"""Read-only export of the SQLite origin of imported mainnet history."""
import datetime as dt,gzip,hashlib,json,pathlib,sqlite3,urllib.parse
HERE=pathlib.Path(__file__).resolve().parent;ROOT=HERE.parent.parent
def ms(s):return int(dt.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000)
def main():
    paths=json.loads((HERE/'paths.json').read_text());cache=pathlib.Path(paths['external_linux']);spec=json.loads((HERE/'spec.json').read_text())
    db=sqlite3.connect('file:'+str((ROOT/'prisma/md_main.db').resolve())+'?mode=ro',uri=True)
    manifest={'source':'Read-only prisma/md_main.db MarketCandle; origin of imported PostgreSQL older mainnet history','exportedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'periods':{}}
    for period in spec['periods'][:2]:
        folder=cache/'candles'/period['id'];folder.mkdir(parents=True,exist_ok=True);start,end=ms(period['start']),ms(period['end'])
        symbols=[r[0] for r in db.execute('SELECT DISTINCT symbol FROM MarketCandle WHERE timeframe=? AND openTime>=? AND openTime<? ORDER BY symbol',('1m',start,end)) if ':' not in r[0] and '@' not in r[0]]
        items=[]
        for symbol in symbols:
            file=folder/(urllib.parse.quote(symbol,safe='')+'.json.gz')
            if file.exists():
                with gzip.open(file,'rt',encoding='utf-8') as f:data=json.load(f)
            else:
                rows=db.execute('SELECT openTime,open,high,low,close,volume FROM MarketCandle WHERE symbol=? AND timeframe=? AND openTime>=? AND openTime<? ORDER BY openTime',(symbol,'1m',start,end)).fetchall()
                data={'symbol':symbol,'columns':['time_ms','open','high','low','close','base_volume'],'rows':rows}
                file.write_bytes(gzip.compress(json.dumps(data,separators=(',',':')).encode()))
            items.append({'symbol':symbol,'rows':len(data['rows']),'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
        manifest['periods'][period['id']]=items;print(period['id'],len(items),sum(r['rows'] for r in items),flush=True)
    db.close();(HERE/'older-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
if __name__=='__main__':main()
