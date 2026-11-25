"""Count detected event clusters actually active at decisions using extracted article receipts."""
from collections import Counter,defaultdict
import csv
import gzip
import json
import numpy as np

from inputs import HERE,CACHE,DAY,HOUR,iso,save_json,prior
from fit import matrix

def event_coverage():
    by_asset=defaultdict(list)
    with gzip.open(CACHE/"extractions.jsonl.gz","rt") as fp:
        for line in fp:
            row=json.loads(line)
            if row["cluster"]:
                for s in row["headline"]:
                    by_asset[s].append((row["ready"],row["expiry"],row["cluster"]))
    summary={}
    with gzip.open(HERE/"event-coverage.csv.gz","wt",newline="") as fp:
        writer=csv.writer(fp)
        writer.writerow(["stage","cluster_id","asset","utc_month","decisions","distinct_decision_dates"])
        for stage in ("train","history","benchmark"):
            total=Counter()
            grouped=defaultdict(list)
            for side in prior.SIDES:
                p=matrix(stage,side)
                for sym in np.unique(p["assets"]):
                    grouped[sym].extend(p["at"][p["assets"]==sym].tolist())
                total["decisions"]+=len(p["at"])
                total["decisions_with_typed_headline"]+=int((p["x"][:,p["columns"].index("event_clusters")]>0).sum())
            event_days=set()
            assets=set()
            clusters=set()
            any_decisions=0
            for sym,values in grouped.items():
                times,n=np.unique(values,return_counts=True)
                covered=np.zeros(len(n),bool)
                intervals=by_asset[sym]
                by_cluster=defaultdict(list)
                for at,expiry,cluster in intervals:
                    lo,hi=np.searchsorted(times,[at,min(at+4*HOUR+1,expiry)])
                    if lo<hi:
                        by_cluster[cluster].append((lo,hi))
                for cluster,segments in by_cluster.items():
                    ids=np.unique(np.concatenate([np.arange(lo,hi) for lo,hi in segments]))
                    covered[ids]=True
                    days=times[ids]//DAY
                    months=days.astype("datetime64[D]").astype("datetime64[M]").astype(str)
                    for m in np.unique(months):
                        mask=months==m
                        writer.writerow([stage,cluster,sym,m,int(n[ids[mask]].sum()),len(np.unique(days[mask]))])
                    event_days.update(days.tolist())
                    clusters.add(cluster)
                    assets.add(sym)
                any_decisions+=int(n[covered].sum())
            assert any_decisions==total["decisions_with_typed_headline"]
            summary[stage]=dict(**total,represented_clusters=len(clusters),represented_assets=len(assets),
                distinct_decision_dates=len(event_days))
    save_json(HERE/"event-coverage.json",summary)

if __name__=="__main__":
    event_coverage()
