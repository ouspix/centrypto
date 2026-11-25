"""Recover daily native minutes from the structured public Hyperliquid fill mirror."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path
import json
import sys

from rebuild import FIELDS, MINUTE_NS, pl, pq, Remote, CACHE, HERE
from sources import listing, write_json

SOURCE=("craftify2221/hyperliquid-fills-raw","de05dc101c819aa68accfefd6647b8bf6de02189")
BEGIN,END=date(2025,7,28),date(2025,11,18)
OUTPUT=CACHE/"structured_1m"


def process(part):
    day=Path(part["path"]).stem[-10:]
    target=OUTPUT/(day+".parquet")
    marker=OUTPUT/(day+".json")
    if marker.exists() and target.exists():
        done=json.loads(marker.read_text())
        if done["sha256"]==part["sha256"]:
            return done["rows"]
    src=pq.ParquetFile(Remote(part),pre_buffer=True)
    cols=["coin","dex","asset_class","timestamp","price","size","trade_id","crossed"]
    parts=[]
    for g in range(src.num_row_groups):
        r=pl.from_arrow(src.read_row_group(g,columns=cols,use_threads=False))
        minute_ms=MINUTE_NS//1_000_000
        r=(r.filter((pl.col("dex")=="hyperliquid") & (pl.col("asset_class")=="perp"))
             .select("coin","trade_id","crossed",pl.col("timestamp").cast(pl.Int64).alias("ts"),
                     pl.col("price").cast(pl.Float64).alias("px"),pl.col("size").cast(pl.Float64).alias("sz")))
        parts.append(r)
    trades=(pl.concat(parts).with_row_index("ordinal")
             .sort("crossed",descending=True,maintain_order=True)
             .unique(subset=["coin","trade_id"],keep="first")
             .sort(["ts","ordinal"])
             .with_columns(minute=(pl.col("ts")//minute_ms)*minute_ms))
    start=int(datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp()*1000)
    frame=(trades.filter(pl.col("minute").is_between(start,start+1440*minute_ms,closed="left"))
                  .group_by(["coin","minute"]).agg(pl.col("px").first().alias("open"),
                   pl.col("px").max().alias("high"),pl.col("px").min().alias("low"),pl.col("px").last().alias("close"),
                   pl.col("sz").sum().alias("volume"),pl.len().alias("trades"))
                  .with_columns(pl.col("minute").cast(pl.Datetime("ms","UTC")),source=pl.lit(2))
                  .sort(["coin","minute"]))
    tmp=target.with_suffix(".partial")
    frame.write_parquet(tmp,compression="zstd")
    tmp.replace(target)
    write_json(marker,dict(sha256=part["sha256"],rows=frame.height))
    return frame.height


def main():
    parts=[p for p in listing(SOURCE,"fills") if BEGIN.isoformat()<=p["path"][-18:-8]<END.isoformat()]
    OUTPUT.mkdir(exist_ok=True)
    write_json(HERE/"structured-sources.json",parts)
    with ThreadPoolExecutor(10) as pool:
        total=0
        for i,n in enumerate(pool.map(process,parts),1):
            total+=n
            if i%10==0 or i==len(parts):
                print(f"Structured native fills: rebuilt {i}/{len(parts)} days, {total} minute bars",flush=True)


if __name__=="__main__":
    main()
