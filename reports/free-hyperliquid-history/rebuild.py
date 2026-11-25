"""Reduce node-trade and fill archives to reproducible native perpetual minute candles."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import argparse
import json
import sys

from hours import source_hour, CUTOFF
from inventory import CACHE, HERE, Remote, pq, write_json
sys.path.insert(0, str(CACHE/"libs"))
import numpy as np
import orjson
import polars as pl

MINUTE_NS=60_000_000_000
COLUMNS=["coin","ts","px","sz","ordinal"]
FIELDS=["open","high","low","close","volume"]
SCHEMA={"coin":pl.String,"ts":pl.Int64,"px":pl.Float64,"sz":pl.Float64,"ordinal":pl.Int64}


def events_from_fills(events):
    rows=[]
    for raw in events:
        seen=set()
        # Venue emits the same trade ID for maker and taker. Count it once.
        for _,fill in orjson.loads(raw):
            coin=fill["coin"]
            key=(coin,fill["tid"])
            if key in seen or not native(coin):
                continue
            seen.add(key)
            rows.append((coin,fill["time"]*1_000_000,float(fill["px"]),float(fill["sz"]),len(rows)))
    return pl.DataFrame(rows,schema=SCHEMA,orient="row")


def native(coin):
    return not (coin.startswith(("@","#")) or ":" in coin or "/" in coin)


def partial(frame,hour,path):
    if frame.is_empty():
        return
    before=frame.height
    frame=frame.filter(pl.col("px").is_finite() & pl.col("sz").is_finite() &
                       (pl.col("px")>0) & (pl.col("sz")>0))
    if frame.height!=before:
        raise ValueError(f"Invalid price or quantity in {hour}")
    frame=(frame.with_columns(minute=(pl.col("ts")//MINUTE_NS)*MINUTE_NS)
           .sort(["ts","ordinal"])
           .group_by(["coin","minute"])
           .agg(pl.col("px").first().alias("open"),pl.col("px").max().alias("high"),
                pl.col("px").min().alias("low"),pl.col("px").last().alias("close"),
                pl.col("sz").sum().alias("volume"),pl.len().alias("trades"),
                pl.col("ts").first().alias("first"),pl.col("ts").last().alias("last"))
           .with_columns(hour=pl.lit(hour)))
    frame.write_parquet(path,compression="zstd")


def extract(kind, selected):
    part=selected["part"]
    output=CACHE/"segments"/kind
    output.mkdir(exist_ok=True,parents=True)
    done=output/(part["sha256"]+".json")
    hours=selected["hours"]
    files={h:output/(h+".parquet") for h in hours}
    if done.exists() and json.loads(done.read_text())==hours and all(p.is_file() for p in files.values()):
        return len(hours)
    source=pq.ParquetFile(Remote(part),pre_buffer=True)
    explicit=source_hour(part["path"]) if "_hourly_" in part["path"] else None
    cuts=[]
    actual=Counter()
    relevant=("_src", "coin","time","px","sz") if kind=="trades" else ("_src","events")
    for number in range(source.num_row_groups):
        # Read the small source column first. Some containers span dates we already have.
        keys=np.full(source.metadata.row_group(number).num_rows, explicit) if explicit else source.read_row_group(
            number,columns=["_src"],use_threads=False)[0].to_numpy(zero_copy_only=False)
        use={k:source_hour(k) if not explicit else explicit for k in np.unique(keys)}
        if not any(h in hours for h in use.values()):
            continue
        ar=source.read_row_group(number,columns=relevant[1:],use_threads=False)
        for raw,hour in use.items():
            if hour not in hours:
                continue
            take=keys==raw
            actual[hour]+=int(take.sum())
            tab=ar.filter(take)
            if kind=="trades":
                frame=(pl.from_arrow(tab)
                    .filter(~pl.col("coin").str.contains(r"^[@#]|[:/]"))
                    .select("coin",pl.col("time").str.to_datetime(time_unit="ns").cast(pl.Int64).alias("ts"),pl.col("px").cast(pl.Float64),pl.col("sz").cast(pl.Float64))
                    .with_row_index("ordinal").with_columns(pl.col("ordinal").cast(pl.Int64)))
            else:
                frame=events_from_fills(tab["events"].to_pylist())
            if len(frame):
                cuts.append((hour,frame))
    if dict(actual)!=hours:
        raise ValueError(f"Row counts changed for {part['path']}: {actual} vs {hours}")
    grouped={}
    for hour,frame in cuts:
        grouped.setdefault(hour,[]).append(frame)
    for h,p in files.items():
        staged=p.with_suffix(".partial")
        if h in grouped:
            frame=pl.concat(grouped[h]).drop("ordinal").with_row_index("ordinal")
            partial(frame,h,staged)
        else:
            pl.DataFrame(schema={"coin":pl.String,"minute":pl.Int64, **{k:pl.Float64 for k in FIELDS},
                          "trades":pl.UInt32,"first":pl.Int64,"last":pl.Int64,"hour":pl.String}).write_parquet(staged)
        staged.replace(p)
    write_json(done,hours)
    return len(hours)


def remaining_sources(kind):
    source=json.loads((HERE/(kind+"-sources.json")).read_text())
    structured=HERE/"structured-sources.json"
    if kind=="fills" and structured.exists():
        days={p["path"][-18:-8] for p in json.loads(structured.read_text())}
        # Include nearby source hours so the timestamp's UTC date, rather
        # than the recorder's file name, determines the candle partition.
        boundary={date.fromisoformat(s) for s in days}
        def needed(h):
            d=date.fromisoformat(h[:10])
            return d not in boundary or (
                h[-2:]=="00" and d-timedelta(days=1) not in boundary) or (
                h[-2:]=="23" and d+timedelta(days=1) not in boundary)
        revised=[]
        for rec in source["selected"]:
            hours={h:n for h,n in rec["hours"].items() if needed(h)}
            if hours:
                revised.append(dict(part=rec["part"],hours=hours))
        source["selected"]=revised
        source["hours"]=sum(len(p["hours"]) for p in revised)
    return source


def rebuild(kind, workers):
    source=remaining_sources(kind)
    rows=source["selected"]
    count=0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i,n in enumerate(pool.map(lambda rec:extract(kind,rec),rows),1):
            count+=n
            if i%20==0 or i==len(rows):
                print(f"{kind}: rebuilt {count}/{source['hours']} source hours ({i}/{len(rows)} parts)",flush=True)


def daily():
    out=CACHE/"rebuilt_1m"
    out.mkdir(exist_ok=True)
    runs=[]
    for kind in ("trades","fills"):
        source=remaining_sources(kind)
        hours={h for p in source["selected"] for h in p["hours"]}
        folder=CACHE/"segments"/kind
        if not all((folder/(h+".parquet")).exists() for h in hours):
            raise ValueError(f"Incomplete reconstruction for {kind}")
        runs.append((folder,hours))
    structured=HERE/"structured-sources.json"
    staged={p["path"][-18:-8]:CACHE/"structured_1m"/(p["path"][-18:-8]+".parquet")
            for p in json.loads(structured.read_text())} if structured.exists() else {}
    if not all(f.is_file() for f in staged.values()):
        raise ValueError("Structured native fills are still processing")
    dates=sorted({h[:10] for _,hours in runs for h in hours}|set(staged))
    for day in dates:
        dest=out/(day+".parquet")
        tmp=dest.with_suffix(".partial")
        if day in staged:
            frame=pl.read_parquet(staged[day]).with_columns(pl.col("minute").cast(pl.Datetime("ns","UTC")),pl.col("source").cast(pl.Int32))
            frame.write_parquet(tmp,compression="zstd")
            tmp.replace(dest)
            continue
        yesterday=(date.fromisoformat(day)-timedelta(days=1)).isoformat()
        tomorrow=(date.fromisoformat(day)+timedelta(days=1)).isoformat()
        # Original file hours are based on capture time. The trade timestamp can
        # cross midnight in either direction, so include neighboring source dates.
        candidates=[]
        for pri,(folder,hours) in enumerate(runs):
            paths=[folder/(h+".parquet") for h in sorted(hours) if yesterday<=h[:10]<=tomorrow]
            if paths:
                candidates.append(pl.scan_parquet(paths).with_columns(source=pl.lit(pri)))
        start=int(np.datetime64(day,"ns").astype("int64"))
        end=start+1440*MINUTE_NS
        raw=pl.concat(candidates).filter(pl.col("minute").is_between(start,end,closed="left"))
        frame=(raw.with_columns(pl.col("source").max().over(["coin","minute"]).alias("priority"))
                  .filter(pl.col("source")==pl.col("priority"))
                  .sort(["first","hour"])
                  .group_by(["coin","minute"])
                  .agg(pl.col("open").first(),pl.col("high").max(),pl.col("low").min(),
                       pl.col("close").sort_by(["last","hour"]).last(),pl.col("volume").sum(),
                       pl.col("trades").sum(),pl.col("source").first())
                  .with_columns(pl.col("minute").cast(pl.Datetime("ns","UTC")))
                  .sort(["coin","minute"]).collect())
        dest=out/(day+".parquet")
        tmp=dest.with_suffix(".partial")
        frame.write_parquet(tmp,compression="zstd")
        tmp.replace(dest)
    print("Wrote",len(dates),"reconstructed daily files",flush=True)


if __name__=="__main__":
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("kind",choices=("trades","fills","daily"))
    cli.add_argument("--workers",type=int,default=8)
    args=cli.parse_args()
    daily() if args.kind=="daily" else rebuild(args.kind,args.workers)
