"""Select one verified mirror copy of each original exchange hour."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta,timezone
from collections import defaultdict
from hashlib import sha256
from pathlib import Path
import json
import re
import sys

from inventory import CACHE, HERE, Remote, pq, write_json

HOURS = re.compile(r"(20\d{6})[\/_](\d{1,2})(?:\.lz4|\.parquet|$)")
CUTOFF = "2025-11-18"


def source_hour(raw):
    m=HOURS.search(raw)
    if m is None:
        raise ValueError("Unrecognized raw archive key: "+raw)
    day,h=m.groups()
    return f"{day[:4]}-{day[4:6]}-{day[6:]}T{int(h):02d}"


def raw_inventory(doc):
    part=doc["part"]
    path=part["path"]
    if "_hourly_" in path:
        return {source_hour(path):sum(g["rows"] for g in doc["groups"])}
    # This legacy bundle stores basenames without dates. The dated originals
    # and newer bundles provide unambiguous replacements for those hours.
    if Path(path).name.startswith("fills_batch_"):
        return {}
    start_key="time" if "time" in doc["columns"] else "local_time"
    if not any(g["limits"].get(start_key,[""])[0][:10]<CUTOFF for g in doc["groups"]):
        return {}
    source=defaultdict(int)
    f=pq.ParquetFile(Remote(part))
    for i,g in enumerate(doc["groups"]):
        limits=g["limits"].get("_src")
        if limits and len(set(limits))==1 and HOURS.search(limits[0]):
            source[source_hour(limits[0])]+=g["rows"]
            continue
        for r in f.read_row_group(i,columns=["_src"],use_threads=False)[0].value_counts().to_pylist():
            source[source_hour(r["values"])]+=r["counts"]
    return dict(source)


def build(kind):
    records=json.loads((CACHE/(kind+"-inventory.json")).read_text())
    interim=CACHE/"hours"/kind
    interim.mkdir(exist_ok=True,parents=True)
    def one(doc):
        p=interim/(sha256(doc["part"]["path"].encode()).hexdigest()+".json")
        if p.exists():
            hours=json.loads(p.read_text())
        else:
            hours=raw_inventory(doc)
            write_json(p,hours)
        return doc["part"],hours
    byhour=defaultdict(list)
    with ThreadPoolExecutor(max_workers=16) as pool:
        for i,(part,hours) in enumerate(pool.map(one,records),1):
            for hour,count in hours.items():
                if hour[:10]<CUTOFF:
                    byhour[hour].append((part,count,len(hours)))
            if i%150==0:
                print(kind,"indexed source keys",i,"/",len(records),flush=True)
    assigned={}
    contested={}
    uncovered=set(byhour)
    candidates={}
    for hour,copies in byhour.items():
        count=max(c[1] for c in copies)
        ranks={c[1] for c in copies}
        if len(ranks)>1:
            contested[hour]=sorted(ranks)
        for part,n,total in copies:
            if n==count:
                p=candidates.setdefault(part["sha256"],(part,set()))
                p[1].add(hour)
    # Prefer the widest reuse per transferred byte among the most complete copies.
    while uncovered:
        part,can=max(candidates.values(),key=lambda a:(len(a[1]&uncovered)/a[0]["size"],a[0]["path"]))
        actual=sorted(can&uncovered)
        uncovered.difference_update(actual)
        assigned[part["sha256"]]=dict(part=part,hours={h:max(c[1] for c in byhour[h]) for h in actual})
    coverage=sorted(byhour)
    before=datetime.fromisoformat(coverage[0])
    stop=datetime.fromisoformat(CUTOFF)
    missing=[]
    while before<stop:
        s=before.isoformat(timespec="hours")
        if s not in byhour:missing.append(s)
        before+=timedelta(hours=1)
    write_json(HERE/(kind+"-sources.json"),dict(selected=list(assigned.values()),first=coverage[0],last=coverage[-1],
          hours=len(coverage),missing_hours=missing,contested_rows=contested))
    print(kind,len(coverage),"hours",coverage[0],coverage[-1],len(assigned),"parts",
          round(sum(r["part"]["size"] for r in assigned.values())/1e9,2),"GB listed",len(contested),"differing copies",flush=True)


if __name__=="__main__":
    build(sys.argv[1])
