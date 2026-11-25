"""Reconcile reported alerts and events against raw source candles and frozen scores."""
import gzip
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path
import numpy as np
from data import CACHE, PLAN, fresh


def main():
    results=json.loads((CACHE/"results.json").read_text())
    manifest=json.loads((CACHE/"prediction-manifest.json").read_text())
    catalog=json.loads((CACHE/"catalog.json").read_text())
    events=json.loads((CACHE/"rallies.json").read_text())
    lock=json.loads((CACHE/"protocol-lock.json").read_text())
    for name,digest in lock.items():
        assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==digest,name
    for name,digest in manifest["source_sha256"].items():
        assert fresh.sweep.sha256(CACHE/name)==digest,name
    native={}
    series_by_symbol={}
    for c in catalog:
        filename=__import__("urllib.parse",fromlist=["quote"]).quote(c["symbol"],safe="")+".json.gz"
        with gzip.open(fresh.sweep.BASE_CACHE/"candles/recent"/filename) as f:
            old=json.load(f)["rows"]
        with gzip.open(CACHE/"market"/filename) as f:
            tail=json.load(f)["rows"]
        rows=old+tail
        assert len({row[0] for row in rows})==len(rows)
        # A five-minute close is the close of the final observed minute in that bucket.
        close={int(row[0])+60000:float(row[4]) for row in rows
               if (int(row[0])+60000)%300000==0 and all(math.isfinite(v) for v in row)}
        native[c["symbol"]]=close
        series_by_symbol[c["symbol"]]=c["id"]
    independently_found=[]
    for symbol,closes in native.items():
        for side,sign in [("long",1),("short",-1)]:
            next_allowed=0
            for at in sorted(closes):
                values=[closes.get(t) for t in (at,at-86400000,at-300000,at-86700000)]
                if any(v is None for v in values):
                    continue
                current=sign*100*(values[0]/values[1]-1)
                before=sign*100*(values[2]/values[3]-1)
                if current>=10 and before<10 and at>=next_allowed:
                    next_allowed=at+86400000
                    if fresh.START<at<=fresh.ENTRY_END+86400000:
                        independently_found.append(f"{side}:{symbol}:{at}")
    assert set(independently_found)=={e["id"] for e in events}
    details={(r["side"],r["variant"],r["seed"]):r for r in manifest["predictions"]}
    checks=0
    for result in results["models"]:
        descriptor=details[result["side"],result["variant"],result["seed"]]
        with np.load(CACHE/descriptor["file"]) as predictions:
            threshold=descriptor["cutoffs"][str(result["quantile"])]
            expected=[]
            for sid,c in enumerate(catalog):
                eligible=np.flatnonzero((predictions["series"]==sid)&(predictions["scores"]>=threshold))
                next_allowed=0
                for i in eligible[np.argsort(predictions["time"][eligible])]:
                    at=int(predictions["time"][i])
                    if at>=next_allowed:
                        expected.append((c["symbol"],at))
                        next_allowed=at+86400000
            assert set(expected)=={(a["symbol"],a["at"]) for a in result["records"]}
        counts=defaultdict(int)
        caught={}
        leads=[]
        for a in result["records"]:
            matches=[e for e in events if e["symbol"]==a["symbol"] and e["side"]==a["side"]
                     and 0<e["at"]-a["at"]<=86400000]
            assert set(a["events"])=={e["id"] for e in matches}
            for e in matches:
                caught[e["id"]]=min(caught.get(e["id"],a["at"]),a["at"])
            counts[a["status"]]+=1
            closes=native[a["symbol"]]
            base=a["at"]-5000
            assert closes[base]==a["forward_10pct"]["reference_price"]
            sign=1 if a["side"]=="long" else -1
            returns=[(t,sign*100*(closes[t]/closes[base]-1)) for t in range(base+300000,base+86400001,300000) if t in closes]
            hits=[t for t,gain in returns if gain>=10]
            assert bool(hits)==(a["forward_10pct"]["status"]=="true")
            if hits:
                assert fresh.iso(hits[0])==a["forward_10pct"]["first_hit"]
            checks+=1
        assert caught==result["caught_at"]
        assert all(counts[k]==result[k] for k in ("true","false","unknown"))
        assert result["alerts"]==sum(counts.values())
        for name,delta in result["incremental"].items():
            if name=="screen_and_discovery":
                refs=set(results["baselines"][result["side"]]["default_screen"]["caught_at"]) | set(results["baselines"][result["side"]]["discovery_attention"]["caught_at"])
            else:
                refs=set(results["baselines"][result["side"]][name]["caught_at"])
            assert delta["additional_rallies"]==len(set(caught)-refs)
            assert delta["union_rallies"]==len(set(caught)|refs)
    output={"source_files_verified":len(manifest["source_sha256"]),
            "distinct_events_independently_reconstructed":len(events),"alert_records_verified":checks,
            "original_protocol_sha256_verified":True,"status":"passed"}
    fresh.sweep.write_json(CACHE/"verification.json",output)
    print(json.dumps(output))


if __name__=="__main__":
    main()
