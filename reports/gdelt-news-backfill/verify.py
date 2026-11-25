"""Verify archive timing, receipt hashes and coverage conservation."""
from collections import Counter,defaultdict
from datetime import date
from pathlib import Path
import csv
import gzip
import json

import numpy as np

from ingest import HERE,ROOT,DELAY_MINUTES,MINUTE,day_path,fetch_minutes,file_hash,save_json
from story_archive import canonical_url, parsed_time, merge_intervals,hits,DAY,utc,phase
from coverage import universe,decisions
from assets import AssetIndex


def verify_examples():
    assert canonical_url("http://www.example.net/a/?z=1&utm_source=test#bottom")=="https://example.net/a?z=1"
    index=AssetIndex(universe())
    assert index.match("Bitcoin Cash rose alongside Ethereum Classic.")==["BCH","ETC"]
    assert index.match("Bitcoin, $SOL and $PEPE are listed.")==["BTC","SOL","kPEPE"]
    assert index.match("A near term move sparked gas price fears.")==[]
    assert index.match("Hyperliquid's HYPE token listing announcement.")==["HYPE"]
    series=np.array([49,50,51,58,59,60,62,63,79,80])
    intervals=merge_intervals([(50,59),(60,80)],2)
    assert hits(intervals,series).tolist()==[False,True,True,False,False,True,True,False,False,False]


def verify():
    verify_examples()
    meta=json.loads((HERE/"coverage.json").read_text())
    assert meta["complete"]
    inventory=meta["source_day_inventory"]
    assert {d.isoformat() for d in fetch_minutes()}==set(inventory)
    for key,info in inventory.items():
        assert info["minutes_checked"]==1440 and info["failed_requests"]==0
        assert info["minute_files"]+info["absent_files"]==1440
        assert file_hash(day_path(date.fromisoformat(key)))==info["day_file_sha256"]
    path=ROOT/meta["article_path"]
    assert file_hash(path)==meta["article_sha256"]
    known=set(universe())
    sample_days=[date.fromisoformat(d) for d in ("2025-11-13","2026-01-25","2026-05-22","2026-11-04","2026-11-19")]
    sample_assets={"BTC","ETH","SOL","HYPE","DOGE","ZEC"}
    samples=defaultdict(list)
    date_span=[(d,utc(d)) for d in sample_days]
    titles=set()
    rows=0
    previous=0
    with gzip.open(path,"rt",encoding="utf-8") as f:
        for line in f:
            row=json.loads(line)
            assert row["article_id"] not in titles and row["title"] and row["url"]==canonical_url(row["url"])
            titles.add(row["article_id"])
            at=parsed_time(row["available_utc"])
            archived=parsed_time(row["batch_utc"])
            modified=parsed_time(row["archive_last_modified_utc"]) or archived
            pub=parsed_time(row["publication_utc"]) or archived
            assert at>=previous and at==max(archived,pub,modified)+DELAY_MINUTES*MINUTE
            expiry=parsed_time(row["expiry_utc"])
            assert expiry<=at+DAY and row["expired_on_arrival"]==(expiry<=at)
            assert set(row["asset_symbols"])<=known
            if expiry>at:
                symbols=sample_assets.intersection(row["asset_symbols"])
                if symbols:
                    for d,start in date_span:
                        if start-DAY<=at<start+DAY:
                            for symbol in symbols:
                                samples[d,symbol].append((at,expiry))
            previous=at
            rows+=1
    assert rows==meta["archive_totals"]["stories"]
    fields=("decisions","news_30m_decisions","news_4h_decisions","news_24h_decisions","recent_archive_decisions")
    aggregate={}
    paths=[("coverage-by-day.csv",open),("coverage-by-asset.csv",open),("coverage-by-day-asset.csv.gz",gzip.open)]
    for name,opener in paths:
        counts=defaultdict(Counter)
        with opener(HERE/name,"rt",encoding="utf-8",newline="") as f:
            for rec in csv.DictReader(f):
                c={k:int(rec[k]) for k in fields}
                assert 0<=c["news_30m_decisions"]<=c["news_4h_decisions"]<=c["news_24h_decisions"]<=c["decisions"]
                counts[rec["period"]].update(c)
        aggregate[name]=counts
    for period,count in (("training",326546),("backtest",5211)):
        reference={k:meta["coverage"][period]["decisions"][k] for k in fields}
        assert reference["decisions"]==count
        for name,by_period in aggregate.items():
            assert by_period[period]==reference,(name,period)
    actual={}
    with gzip.open(HERE/"coverage-by-day-asset.csv.gz","rt",encoding="utf-8",newline="") as f:
        for r in csv.DictReader(f):
            day=date.fromisoformat(r["date"])
            if day in sample_days and r["asset"] in sample_assets:
                actual[day,r["asset"]]=r
    opportunity,_=decisions()
    direct_pairs=0
    for d,start in date_span:
        for symbol in sample_assets:
            sides=opportunity.get((phase(d),symbol),{})
            at=np.array([t for rr in sides.values() for t in rr if start<=t<start+DAY],dtype="i8")
            for name,width in (("30m",30*MINUTE),("4h",240*MINUTE),("24h",DAY)):
                count=sum(any(t-width<=published<=t<expires for published,expires in samples[d,symbol]) for t in at)
                assert count==int(actual[d,symbol][f"news_{name}_decisions"]),(d,symbol,name)
            direct_pairs+=1
    save_json(HERE/"verification.json",dict(direct_day_asset_checks=direct_pairs,daily_inputs_verified=len(inventory),story_records_verified=rows,
        source_receipts_and_story_checks=True,coverage_csvs_reconciled=True,
        causal_interval_and_alias_examples=True))
    print("Verified",len(inventory),"daily partitions,",rows,"deduplicated stories and reconciled coverage.")


if __name__=="__main__":
    verify()
