"""Index the first available archived copy of each URL and exact repeated story."""
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from hashlib import sha256
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import gzip
import json
import re
import sqlite3

import numpy as np

from ingest import (ROOT,CACHE,TRAIN,BENCH,DELAY_MINUTES,MINUTE,fetch_minutes,day_path,at_ms,iso,loads)
from assets import normalize

HOUR=60*MINUTE
DAY=24*HOUR
TRAIN_LABEL="training"
BENCH_LABEL="backtest"
WORD_PUNCT=re.compile(r"[^\w]+")
TRACKING={"fbclid","gclid","mc_cid","mc_eid","mkt_tok","ref_src","ref_url","igshid"}


def utc(day):
    return at_ms(datetime.combine(day,datetime.min.time(),timezone.utc))


def phase(day):
    for name,(start,end) in ((TRAIN_LABEL,TRAIN),(BENCH_LABEL,BENCH)):
        if start<=day<=end:
            return name
    return "warmup"


def parsed_time(value):
    if not value:
        return None
    try:
        t=datetime.fromisoformat(value)
        return at_ms(t if t.tzinfo else t.replace(tzinfo=timezone.utc))
    except (ValueError,TypeError,OverflowError):
        return None


def canonical_url(url):
    try:
        r=urlsplit(url)
        host=r.hostname
    except ValueError:
        return None
    if r.scheme.lower() not in ("http","https") or not host or r.username or r.password:
        return None
    h=host.lower().removeprefix("www.")
    path=r.path.rstrip("/") or "/"
    params=sorted((k,v) for k,v in parse_qsl(r.query,keep_blank_values=True)
                  if k.lower() not in TRACKING and not k.lower().startswith("utm_"))
    if path=="/" and not params:
        return None
    return urlunsplit(("https",h,path,urlencode(params),""))


def fingerprint(title,description):
    text=WORD_PUNCT.sub(" ",title.casefold()).strip()
    desc=WORD_PUNCT.sub(" ",description.casefold()).strip()
    return sha256((text+"\0"+desc).encode()).hexdigest()


def build_index(assets,partial):
    db=sqlite3.connect(":memory:")
    db.execute("""CREATE TABLE first_capture (url TEXT PRIMARY KEY, available INTEGER NOT NULL,
        archived INTEGER NOT NULL, modified INTEGER, published INTEGER, expires INTEGER NOT NULL,
        title TEXT NOT NULL, description TEXT NOT NULL, domain TEXT NOT NULL, source_url TEXT NOT NULL,
        story_key TEXT NOT NULL, targets TEXT NOT NULL)""")
    inventory={}
    batch_times=[]
    broken=[]
    for d in fetch_minutes():
        path=day_path(d)
        if not path.is_file():
            broken.append(str(d))
            continue
        raw=path.read_bytes()
        doc=loads(gzip.decompress(raw))
        if doc.get("version")!=2 and partial:
            broken.append(str(d))
            continue
        minutes={r[0]:r for r in doc["minutes"]}
        if doc.get("version")!=2 or len(minutes)!=len(doc["minutes"]) or any(not 0<=x<1440 for x in minutes):
            raise ValueError(f"Invalid archive scan for {d}")
        counts=Counter(r[1] for r in minutes.values())
        successes={o for o,r in minutes.items() if r[1]==200}
        start=utc(d)
        for offset in successes:
            profile=minutes[offset]
            if len(profile[3])!=64 or profile[2]<0:
                raise ValueError(f"Missing source digest for {d}/{offset}")
            batch=start+offset*MINUTE
            batch_times.append(max(batch,profile[4] or batch)+DELAY_MINUTES*MINUTE)
        if len(minutes)!=1440 or counts[0]:
            broken.append(str(d))
        inventory[d.isoformat()]=dict(period=phase(d),minutes_checked=len(minutes),minute_files=counts[200],
            absent_files=counts[404],failed_requests=counts[0],quarters_with_data=len({o//15 for o in successes}),
            source_rows=sum(r[2] for r in minutes.values()),accepted_observations=sum(map(len,doc["articles"].values())),
            day_file_sha256=sha256(raw).hexdigest())
        rows=[]
        for off,records in doc["articles"].items():
            off=int(off)
            if off not in successes:
                raise ValueError(f"Retained articles lack an archive file for {d}/{off}")
            batch=start+off*MINUTE
            modified=minutes[off][4]
            for item in records:
                url=canonical_url(item["url"])
                if url is None:
                    continue
                published=parsed_time(item.get("publication"))
                available=max(batch,modified or batch,published or batch)+DELAY_MINUTES*MINUTE
                expires=min(available+DAY,published+DAY if published is not None else available+DAY)
                title,desc=normalize(item["title"]),normalize(item["description"])
                rows.append((url,available,batch,modified,published,expires,title,desc,item["domain"],item["url"],
                             fingerprint(title,desc),json.dumps(assets.match(title+" "+desc),separators=(",",":"))))
        db.executemany("""INSERT INTO first_capture VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(url) DO UPDATE SET available=excluded.available, archived=excluded.archived,
            modified=excluded.modified, published=excluded.published, expires=excluded.expires,
            title=excluded.title, description=excluded.description, domain=excluded.domain,
            source_url=excluded.source_url, story_key=excluded.story_key, targets=excluded.targets
            WHERE (excluded.available,excluded.archived)<(first_capture.available,first_capture.archived)""",rows)
    if broken and not partial:
        raise ValueError("Incomplete scans for "+", ".join(broken))
    return db,inventory,np.unique(batch_times),broken


def recover(db,suffix):
    active=defaultdict(list)
    asset_by_day=Counter()
    by_day=defaultdict(Counter)
    outlets=defaultdict(Counter)
    totals=Counter()
    story_seen={}
    path=CACHE/f"stories{suffix}.jsonl.gz"
    tmp=path.with_suffix(".partial")
    with tmp.open("wb") as raw, gzip.GzipFile(fileobj=raw,mode="wb",mtime=0,compresslevel=5) as zipped:
        for row in db.execute("SELECT * FROM first_capture ORDER BY available, archived, url"):
            url,available,batch,modified,published,expires,title,desc,domain,source_url,key,targets=row
            totals["unique_canonical_urls"]+=1
            if key in story_seen and available-story_seen[key]<DAY:
                totals["exact_syndicated_repeats"]+=1
                continue
            story_seen[key]=available
            assets=json.loads(targets)
            day=iso(available)[:10]
            assert available>=batch+DELAY_MINUTES*MINUTE
            assert modified is None or available>=modified+DELAY_MINUTES*MINUTE
            assert published is None or available>=published+DELAY_MINUTES*MINUTE
            ended=expires<=available
            record=dict(url=url,source_url=source_url,domain=domain,title=title,description=desc,
                   batch_utc=iso(batch),archive_last_modified_utc=iso(modified) if modified else None,
                   publication_utc=iso(published) if published else None,available_utc=iso(available),
                   expiry_utc=iso(expires),asset_symbols=assets,expired_on_arrival=ended,
                   article_id=sha256(url.encode()).hexdigest())
            zipped.write((json.dumps(record,ensure_ascii=False,separators=(",",":"))+"\n").encode())
            by_day[day].update(stories=1,stories_with_summary=bool(desc),
                stories_without_publication_timestamp=published is None,expired_on_arrival=ended,
                mapped_stories=bool(assets),mapped_timely_stories=bool(assets) and not ended)
            outlets[phase(date.fromisoformat(day))][domain]+=1
            for asset in assets:
                if not ended:
                    active[asset].append((available,expires))
                    asset_by_day[day,asset]+=1
            totals["stories"]+=1
    tmp.replace(path)
    return path,totals,active,asset_by_day,by_day,outlets


def merge_intervals(rows,width):
    interval=[]
    for available,expires in rows:
        end=min(available+width+1,expires)
        if interval and available<=interval[-1][1]:
            interval[-1][1]=max(interval[-1][1],end)
        else:
            interval.append([available,end])
    return np.array(interval,dtype="i8").reshape((-1,2))


def hits(interval,at):
    if not len(interval):
        return np.zeros(len(at),bool)
    left=np.searchsorted(interval[:,0],at,side="right")-1
    return (left>=0)&(at<interval[np.maximum(0,left),1])
