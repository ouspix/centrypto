"""Publish normalized native minute partitions and audit observable coverage."""
from collections import Counter
from datetime import date,datetime,timedelta,timezone
from hashlib import file_digest
from pathlib import Path
import argparse
import gzip
import json
from urllib.parse import unquote
import sys

from sources import CACHE, HERE, PREVIOUS, RESERVOIR, FUNDING, HOURLY, local_paths, write_json
sys.path.insert(0,str(CACHE/"libs"))
import numpy as np
import polars as pl

OUT=CACHE/"native_1m"
START=date(2025,3,22)
STOP=date(2026,11,17)
FIT_STOP=date(2026,11,4)
FIELDS=["open","high","low","close","volume"]
CORE=["BTC","ETH","SOL","HYPE","DOGE","XRP"]


def digest(path):
    with path.open("rb") as f:
        return file_digest(f,"sha256").hexdigest()


def local(part):
    for file in local_paths(part):
        if file.is_file() and file.stat().st_size==part["size"]:
            return file
    raise FileNotFoundError(part["path"])


def normalize(base_only=False):
    files=json.loads((HERE/"base-sources.json").read_text())
    OUT.mkdir(exist_ok=True,parents=True)
    prior=HERE/"dataset-manifest.json"
    known={r["filename"]:r["sha256"] for r in json.loads(prior.read_text())["native_minutes"]} if prior.exists() else {}
    normalized=[]
    for p in files:
        if p["repo"]!=RESERVOIR[0]:
            continue
        day=Path(p["path"]).stem[-10:]
        dest=OUT/(day+".parquet")
        if not dest.exists() or known.get(dest.name)!=digest(dest):
            frame=(pl.scan_parquet(local(p))
                .filter((pl.col("asset_class")=="perp") & (pl.col("dex")=="hyperliquid"))
                .select("coin",pl.col("minute").cast(pl.Datetime("ms","UTC")),
                        *[pl.col(k).cast(pl.Float64) for k in FIELDS])
                .with_columns(source=pl.lit("reservoir_1m")).collect())
            save_day(frame, dest)
        normalized.append(dest)
    if not base_only:
        for src in sorted((CACHE/"rebuilt_1m").glob("*.parquet")):
            frame=(pl.read_parquet(src).select("coin",pl.col("minute").cast(pl.Datetime("ms","UTC")),*FIELDS,
                       pl.when(pl.col("source")==0).then(pl.lit("legacy_node_trades"))
                         .when(pl.col("source")==1).then(pl.lit("node_fills_by_block"))
                         .otherwise(pl.lit("structured_node_fills")).alias("source")))
            dest=OUT/src.name
            save_day(frame,dest)
            normalized.append(dest)
    # Preserve the historical settlement cadence and all native markets.
    monthly=[]
    for p in files:
        if p["repo"]==FUNDING[0]:
            monthly.append(pl.scan_parquet(local(p)).filter(pl.col("dex")=="").select(
               "coin","timestamp","funding_rate","premium").with_columns(source=pl.lit("ironflow_settled")))
    patches,inputs=november_funding()
    f=pl.concat([*monthly,patches.lazy()]).sort(["coin","timestamp"])
    target=CACHE/"native_settled_funding.parquet"
    tmp=target.with_suffix(".partial")
    f.sink_parquet(tmp,compression="zstd")
    tmp.replace(target)
    return sorted(normalized),target,inputs


def november_funding():
    parent=CACHE.parent
    start=int(datetime(2026,11,1,tzinfo=timezone.utc).timestamp()*1000)
    stop=int(datetime(2026,11,18,tzinfo=timezone.utc).timestamp()*1000)
    captured={}
    fingerprints={}
    paths=[*sorted((parent/"net-value-entry-2026-11-22/funding").glob("recent-*.json")),
           *sorted((parent/"capped-entry-value/hourly-funding").glob("recent-*.json")),
           *sorted((parent/"sma-rsi-bb-optimization-2026-11-21/snapshots").glob("*.json.gz"))]
    for path in paths:
        compressed=path.suffix==".gz"
        with (gzip.open(path,"rt") if compressed else path.open()) as f:
            data=json.load(f)
        coin=data["symbol"] if compressed else unquote(path.stem.removeprefix("recent-"))
        rates={int(t):float(rate) for t,rate in data["rates"].items() if start<=int(t)<stop}
        if not rates:
            continue
        fingerprints[str(path.relative_to(parent))]=digest(path)
        for t,rate in rates.items():
            if t%3_600_000 or not np.isfinite(rate):
                raise ValueError(f"Invalid settlement in {path}")
            old=captured.setdefault((coin,t),rate)
            if not np.isclose(old,rate,rtol=0.,atol=1e-14):
                raise ValueError(f"Conflicting archived settlement in {path}")
    frame=pl.DataFrame([(sym,t,rate,None,"hyperliquid_settlement_capture") for (sym,t),rate in sorted(captured.items())],
                       schema={"coin":pl.String,"timestamp":pl.Int64,"funding_rate":pl.Float64,
                               "premium":pl.Float64,"source":pl.String},orient="row")
    return frame.with_columns((pl.col("timestamp")*1000).cast(pl.Datetime("us","UTC"))),fingerprints


def save_day(frame,dest):
    t=frame.with_columns(
        pl.col("minute").cast(pl.Int64).alias("at"),
        valid=pl.all_horizontal(*[pl.col(k).is_finite() & (pl.col(k)>0) for k in FIELDS]) &
                 (pl.col("high")==pl.max_horizontal(*FIELDS[:4])) & (pl.col("low")==pl.min_horizontal(*FIELDS[:4])))
    a=t.select(pl.col("valid").all(),(pl.col("at")%60000==0).all().alias("aligned"),
               pl.struct(["coin","minute"]).is_duplicated().any().alias("dupe"),
               (pl.col("minute").dt.date()==date.fromisoformat(dest.stem)).all().alias("in_day")).row(0)
    if a!=(True,True,False,True):
        raise ValueError(f"Invalid timestamps or OHLCV in {dest.name}: {a}")
    tmp=dest.with_suffix(".partial")
    frame.sort(["coin","minute"]).write_parquet(tmp,compression="zstd")
    tmp.replace(dest)


def ranges(dates):
    out=[]
    for day in sorted(dates):
        day=date.fromisoformat(day) if isinstance(day,str) else day
        if out and out[-1][1]+timedelta(days=1)==day:
            out[-1][1]=day
        else:
            out.append([day,day])
    return [[d.isoformat() for d in r] for r in out]


def audit(paths,funding):
    same_scope=set()
    catalog=HERE.parent/"two-stage-rebuild-2026-11-14/catalog.json"
    symbols={x["symbol"] for x in json.loads(catalog.read_text())}
    prev={}
    previous_date=None
    observed={}
    qualified={}
    by_source=Counter()
    for p in paths:
        day=date.fromisoformat(p.stem)
        t=pl.read_parquet(p)
        by_source.update({s:v for s,v in t.group_by("source").len().iter_rows()})
        groups=t.partition_by("coin",as_dict=True)
        readiness=Counter()
        now={}
        for (symbol,),g in groups.items():
            if symbol not in symbols:
                continue
            slots=((g["minute"].cast(pl.Int64).to_numpy()//60_000)%1440).astype(int)
            native=np.zeros(1440,bool)
            native[slots]=True
            now[symbol]=native
            tail=prev.get(symbol,np.zeros(1440,bool)) if previous_date==day-timedelta(days=1) else np.zeros(1440,bool)
            complete=np.r_[tail,native].reshape(-1,5).all(1)
            count=np.cumsum(np.r_[0,complete])
            volume=np.zeros(1440)
            volume[slots]=g["close"].to_numpy()*g["volume"].to_numpy()
            # Five-minute close at each boundary, including the first one at midnight.
            vol=np.r_[prev.get((symbol,"volume"),0.) if previous_date==day-timedelta(days=1) else 0.,volume[4::5][:-1]]
            local=(count[288:-1]-count[:-289]==288)&(vol>=10_000.)
            readiness[symbol]=int(local.sum())
            now[symbol,"volume"]=volume[-1]
        prev,previous_date=now,day
        same_scope.update(k for (k,) in groups if k in symbols)
        observed[p.stem]=dict(rows=t.height,native_perps=len(groups),minute_bars={s:len(groups[s,]) if (s,) in groups else 0 for s in CORE})
        qualified[p.stem]=dict(ready_5m_decisions=sum(readiness.values()),ready_symbols=sum(n>0 for n in readiness.values()),
                                core={s:int(readiness[s]) for s in CORE})
    added=[d for d,v in qualified.items() if d<"2026-04-01" and v["ready_5m_decisions"]]
    fit=[d for d,v in qualified.items() if d<=FIT_STOP.isoformat() and v["ready_5m_decisions"]]
    funded=pl.scan_parquet(funding).select(pl.len(),pl.col("timestamp").min().alias("first"),pl.col("timestamp").max().alias("last")).collect().row(0)
    dates={date.fromisoformat(p.stem) for p in paths}
    absent={START+timedelta(days=x) for x in range((STOP-START).days+1)}-dates
    result=dict(normalized_partitions=len(paths),native_rows=sum(by_source.values()),native_rows_by_source=by_source,
                exported_date_ranges=ranges(dates),days_without_native_minutes=ranges(absent),original_universe_symbols_with_data=len(same_scope),
                input_ready_dates_through_nov4=len(fit),added_input_ready_dates=len(added),input_ready_date_ranges=ranges(fit),
                readiness_definition="Complete 24h native minute window with $10,000 prior-minute quote volume. Counts precede setup, exit, and funding checks.",
                daily_market=observed,daily_input_readiness=qualified,
                settled_funding=dict(rows=funded[0],first=funded[1].isoformat(),last=funded[2].isoformat()))
    return result


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--base-only",action="store_true")
    args=cli.parse_args()
    paths,funding,settlement_sources=normalize(args.base_only)
    result=audit(paths,funding)
    manifest=dict(native_minutes=[dict(date=p.stem,filename=p.name,sha256=digest(p)) for p in paths],
                  funding=dict(filename=funding.name,sha256=digest(funding),november_capture_sha256=settlement_sources),
                  hourly_candles="hourly_ohlcv")
    write_json(HERE/"coverage.json",result)
    write_json(HERE/"dataset-manifest.json",manifest)
    print(result["normalized_partitions"],"days",result["native_rows"],"minutes",
          result["added_input_ready_dates"],"additional dates passing the 24h input gate",flush=True)


if __name__=="__main__":
    main()
