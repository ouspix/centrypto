"""Verify the dataset manifest, independent hourly overlap and exact cutoff parity."""
from pathlib import Path
from collections import Counter
import json
import sys

from dataset import CACHE, HERE, PREVIOUS, CORE, FIELDS, digest, pl
from sources import write_json
import numpy as np


def aggregate_minutes(paths):
    return (pl.scan_parquet(paths)
            .with_columns(timestamp=pl.col("minute").dt.truncate("1h"))
            .group_by(["coin","timestamp"])
            .agg(pl.col("open").sort_by("minute").first(),pl.col("high").max(),pl.col("low").min(),
                 pl.col("close").sort_by("minute").last(),pl.col("volume").sum(),pl.len().alias("minutes"))
            .collect())


def verify():
    manifest=json.loads((HERE/"dataset-manifest.json").read_text())
    normal=CACHE/"native_1m"
    for row in manifest["native_minutes"]:
        path=normal/row["filename"]
        assert digest(path)==row["sha256"],path
    funding=CACHE/manifest["funding"]["filename"]
    assert digest(funding)==manifest["funding"]["sha256"]
    for name,expected in manifest["funding"]["november_capture_sha256"].items():
        assert digest(CACHE.parent/name)==expected,name
    a=pl.read_parquet(funding,columns=["coin","timestamp","funding_rate"])
    assert not a.select(pl.struct(["coin","timestamp"]).is_duplicated().any()).item()
    assert a["funding_rate"].is_finite().all()
    sites=dict()
    hourly_paths=list((CACHE/"hourly_ohlcv").glob("*.parquet"))
    for start,end,label in [("2025-05-25","2025-11-17","raw_mirror"),("2025-11-18","2026-11-17","reservoir")]:
        daily=[normal/row["filename"] for row in manifest["native_minutes"] if start<=row["date"]<=end]
        if not daily:
            continue
        minute=aggregate_minutes(daily)
        official=(pl.scan_parquet(hourly_paths).filter((pl.col("dex")=="")&(pl.col("market_class")=="perp"))
                  .select("coin",pl.col("timestamp").cast(pl.Datetime("ms","UTC")),*FIELDS).collect())
        matched=minute.join(official,on=["coin","timestamp"],suffix="_hourly")
        matched=matched.filter(pl.col("minutes")==60)
        rec=dict(matched_complete_native_hours=matched.height,by_symbol={})
        for coin in CORE:
            one=matched.filter(pl.col("coin")==coin)
            if len(one)==0:
                continue
            same={k:float(np.isclose(one[k],one[k+"_hourly"],rtol=1e-7,atol=1e-9).mean()) for k in FIELDS}
            rec["by_symbol"][coin]=dict(hours=len(one),fraction_matching=same,
                median_volume_ratio=float(np.median(one["volume"]/one["volume_hourly"])))
        sites[label]=rec
    # Compare directly with the source rows used by the existing frozen model.
    old=np.load(PREVIOUS/"minutes.npy",mmap_mode="r")
    start=np.datetime64("2026-03-30","D")
    audit=json.loads((HERE.parent/"continuous-entry-value/source-audit.json").read_text())
    rng=np.random.default_rng(20261122)
    sample=0
    max_relative_error=0.
    for di in rng.choice(range(old.shape[1]//1440),size=24,replace=False):
        day=str(start+np.timedelta64(int(di),"D"))
        target=pl.read_parquet(normal/(day+".parquet"))
        for coin in CORE:
            site=target.filter(pl.col("coin")==coin)
            at=((site["minute"].cast(pl.Int64).to_numpy()//60_000)%1440).astype(int)
            data=old[audit["symbols"].index(coin),di*1440+at]
            recorded=site.select(FIELDS).to_numpy()
            assert np.allclose(data,recorded,rtol=4e-16,atol=0.),(day,coin)
            if len(recorded):
                max_relative_error=max(max_relative_error,float(np.max(abs(data-recorded)/recorded)))
            sample+=len(site)
    write_json(HERE/"verification.json",dict(day_partitions_verified=len(manifest["native_minutes"]),
                frozen_minute_comparisons=sample,max_relative_numeric_error=max_relative_error,hourly_cross_check=sites,
                funding_rows=len(a),unique_timestamp_per_symbol=True))
    print("Verified",len(manifest["native_minutes"]),"daily partitions and",sample,"existing minute rows",flush=True)


if __name__=="__main__":
    verify()
