"""Join the archive as of each decision and publish daily and asset coverage."""
from collections import Counter, defaultdict
from datetime import date
from urllib.parse import unquote
import argparse
import csv
import gzip
import io

import joblib
import numpy as np

from ingest import HERE, ROOT, CACHE, DELAY_MINUTES, MINUTE, iso, loads, file_hash, save_json
from assets import AssetIndex
from story_archive import HOUR, DAY, TRAIN_LABEL, BENCH_LABEL, phase, build_index, recover, merge_intervals, hits

RIDGE=HERE.with_name("ridge-357-day")
MARKET=CACHE.parent/"capped-entry-value"
LOCK=RIDGE/"research-lock.json"
TRAIN_CACHES=(CACHE.parent/"ridge-357-day",CACHE.parent/"continuous-entry-value")

WINDOWS={"30m":30*MINUTE,"4h":4*HOUR,"24h":DAY}
DECISION_FIELDS=("decisions","long_decisions","short_decisions","recent_archive_decisions",
                 "news_30m_decisions","news_4h_decisions","news_24h_decisions")
RATE_FIELDS=tuple(f"share_{k}_decisions" for k in WINDOWS)
DAY_FIELDS=("stories","mapped_stories","mapped_timely_stories","stories_with_summary",
            "stories_without_publication_timestamp","expired_on_arrival","assets_with_stories")
SCAN_FIELDS=("minutes_checked","minute_files","absent_files","failed_requests","quarters_with_data",
             "source_rows","accepted_observations")
ASSET_FIELDS=("days_with_decisions","days_with_stories","days_with_decisions_and_stories",
              "days_with_covered_4h_decisions")


def universe():
    return tuple(loads((RIDGE/"archive-inputs.json").read_bytes())["symbols"])


def decisions():
    rows=defaultdict(lambda:defaultdict(list))
    lock=loads(LOCK.read_bytes())
    for name,digest in lock["input_hashes"].items():
        path=ROOT/name
        if path.parent.name!="examples" or path.parent.parent not in TRAIN_CACHES or path.suffix!=".joblib":
            continue
        if file_hash(path)!=digest:
            raise ValueError(f"Ridge fitting decisions changed in {path}")
        symbol=unquote(path.stem)
        for side,r in joblib.load(path).items():
            rows[TRAIN_LABEL,symbol][side].extend(r["decision"][np.isfinite(r["y"])].tolist())
    for side,expected in lock["training"].items():
        assert sum(len(r[side]) for r in rows.values())==expected["rows"]
    tape=joblib.load(MARKET/"benchmark.joblib")
    saved=loads((RIDGE/"benchmark.json").read_bytes())
    assert file_hash(MARKET/"benchmark.joblib")==saved["source_hashes"][str((MARKET/"benchmark.joblib").relative_to(ROOT))]
    for side,pack in tape["sides"].items():
        for r in pack["records"]:
            rows[BENCH_LABEL,r["symbol"]][side].append(r["decision"])
    assert sum(len(v) for (p,_),s in rows.items() if p==BENCH_LABEL for v in s.values())==5211
    return rows,tape["window"]


def count_hits(decision_sets,batches,active,asset_by_day,stories,inventory):
    assets=defaultdict(Counter)
    days=defaultdict(Counter)
    blocks=defaultdict(Counter)
    day_asset=defaultdict(Counter)
    for (period,symbol),sides in decision_sets.items():
        intervals={k:merge_intervals(active[symbol],w) for k,w in WINDOWS.items()}
        for side,values in sides.items():
            at=np.array(values,dtype="i8")
            if not len(at):
                continue
            day=at//DAY*DAY
            seen={k:hits(interval,at) for k,interval in intervals.items()}
            assert np.all(seen["30m"]<=seen["4h"]) and np.all(seen["4h"]<=seen["24h"])
            idx=np.searchsorted(batches,at,side="right")-1
            archived=(idx>=0)&(batches[np.maximum(idx,0)]>=at-HOUR) if len(batches) else np.zeros(len(at),bool)
            for d in np.unique(day):
                date_key=iso(d)[:10]
                assert phase(date.fromisoformat(date_key))==period
                keep=day==d
                count=dict(decisions=int(keep.sum()),recent_archive_decisions=int(archived[keep].sum()),
                    **{side+"_decisions":int(keep.sum())},
                    **{f"news_{k}_decisions":int(ok[keep].sum()) for k,ok in seen.items()})
                day_asset[period,date_key,symbol].update(count)
                days[date_key].update(count)
                assets[period,symbol].update(count)
                blocks[period].update(count)
    counts_by_day=Counter()
    for (day,symbol),n in asset_by_day.items():
        counts_by_day[day]+=1
        p=phase(date.fromisoformat(day))
        if p!="warmup":
            day_asset[p,day,symbol]["stories"]+=n
            assets[p,symbol]["stories"]+=n
    # Include original-universe assets with no matching articles or decisions in the machine-readable output.
    for p in (TRAIN_LABEL,BENCH_LABEL):
        for sym in universe():
            _=assets[p,sym]
    for (p,_,symbol),counts in day_asset.items():
        rec=assets[p,symbol]
        rec["days_with_decisions"]+=bool(counts["decisions"])
        rec["days_with_stories"]+=bool(counts["stories"])
        rec["days_with_decisions_and_stories"]+=bool(counts["decisions"] and counts["stories"])
        rec["days_with_covered_4h_decisions"]+=bool(counts["news_4h_decisions"])
    for day in inventory:
        days[day].update(stories[day])
        days[day]["assets_with_stories"]=counts_by_day[day]
    return blocks,days,assets,day_asset


def csv_file(path,fields,rows):
    tmp=path.with_suffix(".partial")
    def write(text):
        w=csv.DictWriter(text,fieldnames=fields,extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    if path.suffix==".gz":
        with tmp.open("wb") as raw, gzip.GzipFile(fileobj=raw,mode="wb",mtime=0) as compressed, \
             io.TextIOWrapper(compressed,encoding="utf-8",newline="") as text:
            write(text)
    else:
        with tmp.open("w",newline="",encoding="utf-8") as text:
            write(text)
    tmp.replace(path)


def rates(row):
    count=row["decisions"]
    return {f"share_{k}_decisions":row[f"news_{k}_decisions"]/count if count else None for k in WINDOWS}


def write_reports(partial=False):
    suffix="-partial" if partial else ""
    db,inventory,batches,broken=build_index(AssetIndex(universe()),partial)
    try:
        path,totals,active,asset_by_day,stories,outlets=recover(db,suffix)
    finally:
        db.close()
    ds,window=decisions()
    blocks,day_counts,asset_counts,details=count_hits(ds,batches,active,asset_by_day,stories,inventory)
    daily=[dict(date=k,**meta,**{s:day_counts[k][s] for s in (*DAY_FIELDS,*DECISION_FIELDS)})
           for k,meta in sorted(inventory.items())]
    csv_file(HERE/f"coverage-by-day{suffix}.csv",("period","date",*SCAN_FIELDS,*DAY_FIELDS,*DECISION_FIELDS,*RATE_FIELDS),
             (dict(**row,**rates(row)) for row in daily))
    assets=[dict(period=p,asset=symbol,stories=c["stories"],**{k:c[k] for k in (*ASSET_FIELDS,*DECISION_FIELDS)},**rates(c))
            for (p,symbol),c in sorted(asset_counts.items())]
    csv_file(HERE/f"coverage-by-asset{suffix}.csv",("period","asset","stories",*ASSET_FIELDS,*DECISION_FIELDS,*RATE_FIELDS),assets)
    def rows_by_day_asset():
        original=universe()
        for day in daily:
            period,key=day["period"],day["date"]
            if period=="warmup":
                continue
            for symbol in original:
                count=details.get((period,key,symbol), Counter())
                yield dict(period=period,date=key,asset=symbol,stories=count["stories"],
                           **{k:count[k] for k in DECISION_FIELDS},**rates(count))
    csv_file(HERE/f"coverage-by-day-asset{suffix}.csv.gz",("period","date","asset","stories",*DECISION_FIELDS,*RATE_FIELDS),
             rows_by_day_asset())
    summary={}
    for p in (TRAIN_LABEL,BENCH_LABEL):
        d=[r for r in daily if r["period"]==p]
        a=[r for r in assets if r["period"]==p]
        s=blocks[p]
        summary[p]=dict(date_count=len(d),checked_minutes=sum(r["minutes_checked"] for r in d),
            archive_files=sum(r["minute_files"] for r in d),request_failures=sum(r["failed_requests"] for r in d),
            quarters_with_files=sum(r["quarters_with_data"] for r in d),quarters=len(d)*96,
            days_with_any_stories=sum(r["stories"]>0 for r in d),
            days_with_timely_mapped_stories=sum(r["mapped_timely_stories"]>0 for r in d),
            assets_with_stories=sum(r["stories"]>0 for r in a),assets_with_decisions=sum(r["decisions"]>0 for r in a),
            decision_assets_with_4h_story=sum(r["news_4h_decisions"]>0 for r in a),
            asset_days_with_decisions=sum(r["days_with_decisions"] for r in a),
            asset_days_with_4h_story=sum(r["days_with_covered_4h_decisions"] for r in a),
            stories=sum(r["stories"] for r in d),mapped_timely_stories=sum(r["mapped_timely_stories"] for r in d),
            stories_with_summary=sum(r["stories_with_summary"] for r in d),
            expired_on_arrival=sum(r["expired_on_arrival"] for r in d),decisions={k:s[k] for k in DECISION_FIELDS},
            **rates(s),top_outlets=outlets[p].most_common(12))
    save_json(HERE/f"coverage{suffix}.json",dict(complete=not partial and not broken,partial_scan_dates=broken,
        source="GDELT Article List",delay_minutes=DELAY_MINUTES,language="en",article_path=str(path.relative_to(ROOT)),
        article_sha256=file_hash(path),benchmark_window=window,archive_totals=totals,
        source_day_inventory=inventory,coverage=summary))
    for p,v in summary.items():
        print(p,v["date_count"],"dates",v["stories"],"stories",v["decision_assets_with_4h_story"],"assets with 4h joins",
              v["share_4h_decisions"],"fraction of decisions",flush=True)


if __name__=="__main__":
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--partial",action="store_true",help="Write provisional tables during ingestion")
    write_reports(cli.parse_args().partial)
