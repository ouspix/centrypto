"""Recover archived headline and description records from the GDELT Article List."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from hashlib import file_digest, sha256
from pathlib import Path
import argparse
import gzip
import json
import re
import sys
import threading
import time

import requests

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = ROOT/"data/research/centrypto"/HERE.name
MINUTE = 60_000
TRAIN = (date(2025,11,13), date(2026,11,4))
BENCH = (date(2026,11,17), date(2026,11,21))
BASE = "https://data.gdeltproject.org/gdeltv3/gal"
THREAD = threading.local()
DELAY_MINUTES = 15
sys.path.insert(0, str(CACHE.parent/"free-hyperliquid-history/libs"))
try:
    from orjson import loads
except ImportError:
    loads = json.loads

CRYPTO = re.compile(
    r"\b(?:cryptocurrenc\w*|crypto(?:s|asset\w*|currency)?|bitcoin|ethereum|blockchain|stablecoin\w*|"
    r"hyperliquid|solana|defi|altcoin\w*|memecoin\w*|tokeni[sz]\w*|on[- ]chain|airdrop\w*|"
    r"web3|ripple labs|binance|coinbase|tether|dogecoin|uniswap|zk(?:sync|proof)|layer[- ]?[12]|"
    r"block\s*rewards|proof[- ]of[- ](?:stake|work)|btc|eth|xrp|usdt|usdc)\b",
    re.I
)
SPECIALIST = frozenset("""coindesk.com cointelegraph.com decrypt.co theblock.co blockworks.co crypto.news cryptoslate.com
 bitcoinmagazine.com news.bitcoin.com beincrypto.com dlnews.com ambcrypto.com bitcoinist.com u.today dailyhodl.com
 coinjournal.net fxstreet.com cryptopotato.com newsbtc.com coinpedia.org coinspeaker.com cryptobriefing.com
 blockonomi.com bankless.com protos.com cryptonews.com thedefiant.io unchainedcrypto.com blockchain.news""".split())
# FXStreet covers markets well beyond crypto.
SPECIALIST = SPECIALIST-{"fxstreet.com"}


def file_hash(path):
    with path.open("rb") as f:
        return file_digest(f,"sha256").hexdigest()


def save_json(path,value):
    stage=path.with_suffix(".partial")
    stage.write_text(json.dumps(value,indent=2,allow_nan=False)+"\n",encoding="utf-8")
    stage.replace(path)


def iso(at):
    return datetime.fromtimestamp(at/1000,timezone.utc).isoformat().replace("+00:00","Z")


def at_ms(at):
    return int(at.timestamp()*1000)


def span(start,stop):
    for n in range((stop-start).days+1):
        yield start+timedelta(days=n)


def fetch_minutes():
    return sorted({d for left,right in (TRAIN,BENCH) for d in span(left-timedelta(days=1),right)})


def day_path(day):
    return CACHE/"days"/(day.isoformat()+".json.gz")


def session():
    if not hasattr(THREAD,"session"):
        obj=requests.Session()
        obj.headers.update({"User-Agent":"CentryptoResearch/1.0 (historical GDELT Article List coverage)"})
        THREAD.session=obj
    return THREAD.session


def clean_domain(raw):
    return raw.strip().lower().removeprefix("www.")


def eligible(r):
    if r.get("lang")!="en":
        return None
    url,head,desc=r.get("url"),r.get("title"),r.get("desc") or ""
    if not url or not isinstance(head,str) or not head.strip() or not isinstance(desc,str):
        return None
    domain=clean_domain(r.get("domain",""))
    specialist=domain in SPECIALIST or any(domain.endswith("."+d) for d in SPECIALIST)
    if not specialist and not CRYPTO.search(head+" "+desc):
        return None
    return dict(url=url,domain=domain,title=head,description=desc,publication=r.get("date"),
                specialist=specialist)


def minute(day,offset):
    batch=datetime.combine(day,datetime.min.time(),timezone.utc)+timedelta(minutes=offset)
    label=batch.strftime("%Y%m%d%H%M")+"00"
    for attempt in range(5):
        try:
            response=session().get(f"{BASE}/{label}.gal.json.gz",timeout=(10,35))
            if response.status_code==404:
                return offset,404,0,None,None,[]
            if response.status_code==429:
                time.sleep(min(60,max(2**attempt,int(response.headers.get("Retry-After","2")))))
                continue
            response.raise_for_status()
            raw=response.content
            modified=response.headers.get("Last-Modified")
            modified=at_ms(parsedate_to_datetime(modified)) if modified else None
            rows=[]
            count=0
            for content in gzip.decompress(raw).splitlines():
                count+=1
                item=eligible(loads(content))
                if item is not None:
                    rows.append(item)
            return offset,200,count,sha256(raw).hexdigest(),modified,rows
        except (requests.RequestException,OSError,ValueError):
            if attempt==4:
                break
            time.sleep(2**attempt)
    return offset,0,0,None,None,[]


def collect(days,workers,burst,fast=False):
    root=CACHE/"days"
    root.mkdir(parents=True,exist_ok=True)
    # Quarter-hour track is processed first for a fast first pass across all dates.
    # Other minutes are still checked in the complete backfill.
    lead=tuple(i for i in range(1440) if i%15<6)
    rest=tuple(i for i in range(1440) if i%15>=6)
    pending=list(days)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for pos in range(0,len(pending),burst):
            dates=pending[pos:pos+burst]
            work={}
            for d in dates:
                path=day_path(d)
                profiles={}
                rows={}
                if path.exists():
                    data=loads(gzip.decompress(path.read_bytes()))
                    if data.get("version")==2:
                        profiles={p[0]:p for p in data["minutes"]}
                        rows=data["articles"]
                work[d]=(profiles,rows)
            tasks={}
            for d in dates:
                state=work[d][0]
                for offset in lead if fast else (*lead,*rest):
                    if offset not in state or state[offset][1]==0:
                        tasks[pool.submit(minute,d,offset)]=d
            for f in as_completed(tasks):
                d=tasks[f]
                offset,status,count,digest,modified,records=f.result()
                profiles,rows=work[d]
                profiles[offset]=(offset,status,count,digest,modified)
                if records:
                    rows[str(offset)]=records
            for d in dates:
                profile,rows=work[d]
                doc=dict(version=2,date=d.isoformat(),minutes=[profile[k] for k in sorted(profile)],articles=rows)
                target=day_path(d)
                temp=target.with_suffix(".partial")
                temp.write_bytes(gzip.compress(json.dumps(doc,separators=(",",":"),ensure_ascii=False).encode(),compresslevel=3,mtime=0))
                temp.replace(target)
                counts=Counter(p[1] for p in profile.values())
                print(d,"checked",len(profile),"files",counts[200],"errors",counts[0],
                      "article observations",sum(map(len,rows.values())),flush=True)


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--workers",type=int,default=32)
    cli.add_argument("--days-per-batch",type=int,default=3)
    cli.add_argument("--first",type=date.fromisoformat)
    cli.add_argument("--last",type=date.fromisoformat)
    cli.add_argument("--fast",action="store_true")
    args=cli.parse_args()
    days=[d for d in fetch_minutes() if (args.first is None or args.first<=d) and (args.last is None or d<=args.last)]
    collect(days,args.workers,args.days_per_batch,args.fast)


if __name__=="__main__":
    main()
