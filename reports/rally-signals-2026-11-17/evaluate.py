"""Event-level signal evaluation, with causal alert suppression and explicit missing outcomes."""
import gzip
import json
import re
import statistics
from collections import defaultdict
from pathlib import Path
import numpy as np
from data import CACHE, PLAN, fresh

ms, iso = fresh.sweep.ms, fresh.iso
BAR, DAY = fresh.BAR, 86400000
START, END = ms(PLAN["windows"][0]["start"]), ms(PLAN["windows"][-1]["end"])
CATALOG = json.loads((CACHE/"catalog.json").read_text())
STATE = np.load(CACHE/"state.npy",mmap_mode="r")
BY_SYMBOL = {c["symbol"]:c for c in CATALOG}


def series(symbol):
    c = BY_SYMBOL[symbol]
    return STATE[c["offset"]:c["offset"]+c["bars"]]


def events():
    result=[]
    for c in CATALOG:
        state=series(c["symbol"])
        returns=100*(fresh.safe(state["close"],fresh.lag(state["close"],288))-1)
        for side,sign in [("long",1),("short",-1)]:
            next_time=0
            qualifies=sign*returns>=PLAN["rally_gain_pct"]
            below_before=fresh.lag(sign*returns,1)<PLAN["rally_gain_pct"]
            for i in np.flatnonzero(qualifies & below_before):
                at=int(state["time"][i])-5000
                if at<next_time:
                    continue
                next_time=at+DAY
                if START<at<=END+DAY:
                    result.append({"id":f"{side}:{c['symbol']}:{at}","symbol":c["symbol"],"side":side,
                                   "at":at,"confirmed_at":iso(at),"return24h_pct":float(returns[i])})
    return sorted(result,key=lambda e:(e["at"],e["symbol"],e["side"]))


def deduplicate(alerts):
    latest={}
    result=[]
    for alert in sorted(alerts,key=lambda a:(a["at"],a["symbol"],a["side"])):
        key=alert["symbol"],alert["side"]
        if alert["at"]<latest.get(key,0)+DAY:
            continue
        latest[key]=alert["at"]
        result.append(alert)
    return result


def outcome_observed(alert):
    s=series(alert["symbol"])
    at=s["time"]-5000
    returns=np.isfinite(s["close"])&np.isfinite(fresh.lag(s["close"],288))
    ids=np.flatnonzero((at>alert["at"])&(at<=alert["at"]+DAY))
    return len(ids)==288 and bool(returns[ids[-1]]) and float(returns[ids].mean())>=.9


def evaluate_alerts(alerts,rallies):
    by_pair=defaultdict(list)
    for e in rallies:
        by_pair[e["symbol"],e["side"]].append(e)
    caught={}
    records=[]
    for a in alerts:
        matches=[e for e in by_pair[a["symbol"],a["side"]] if a["at"]<e["at"]<=a["at"]+DAY]
        for e in matches:
            caught[e["id"]]=min(caught.get(e["id"],a["at"]),a["at"])
        status="true" if matches else "false" if outcome_observed(a) else "unknown"
        records.append({**a,"time":iso(a["at"]),"status":status,"events":[e["id"] for e in matches]})
    counts={status:sum(a["status"]==status for a in records) for status in ("true","false","unknown")}
    event_map={e["id"]:e for e in rallies}
    leads=[(event_map[key]["at"]-at)/60000 for key,at in caught.items()]
    return {
        "alerts":len(records),**counts,"distinct_rallies_caught":len(caught),
        "rally_denominator":len(rallies),"recall":len(caught)/len(rallies) if rallies else None,
        "precision_on_known":counts["true"]/(counts["true"]+counts["false"]) if counts["true"]+counts["false"] else None,
        "precision_lower_bound":counts["true"]/len(records) if records else None,
        "median_lead_minutes":statistics.median(leads) if leads else None,
        "lead_minutes":leads,"caught_at":caught,"records":records,
    }


def log_attention():
    records=fresh.gz(CACHE/"agent-records.json.gz")
    attention=[]
    times=[]
    for row in records:
        at=ms(row["createdAt"])
        payload=json.loads(row["dataJson"])
        if row["kind"]=="candidate_comparison" and payload.get("at") and ms(payload["at"])>at+1000:
            continue
        if row["kind"]=="proposal_revision" and payload.get("updatedAt") and ms(payload["updatedAt"])>at+1000:
            continue
        symbols=set(re.findall(r'mainnet:perp:([A-Za-z0-9_.-]+)',json.dumps(payload)))
        symbols &= set(BY_SYMBOL)
        times.append(at)
        attention.extend({"symbol":symbol,"at":at,"record_id":row["id"],"kind":row["kind"]} for symbol in symbols)
    return attention,{"records":len(records),"instrument_mentions":len(attention),
                      "first":iso(min(times)) if times else None,"last":iso(max(times)) if times else None}


def incremental(result,baseline):
    caught=result["caught_at"]
    ref=baseline["caught_at"]
    shared=set(caught)&set(ref)
    earlier=[(ref[k]-caught[k])/60000 for k in shared if caught[k]<ref[k]]
    new=sorted(set(caught)-set(ref))
    return {"additional_rallies":len(new),"additional_event_ids":new,
            "union_rallies":len(set(caught)|set(ref)),"shared_rallies":len(shared),
            "shared_caught_earlier":len(earlier),"median_earlier_minutes":statistics.median(earlier) if earlier else None}


def main():
    all_events=events()
    fresh.sweep.write_json(CACHE/"rallies.json",all_events)
    screen=json.loads((CACHE/"screen.json").read_text())
    attention,log_coverage=log_attention()
    manifest=json.loads((CACHE/"prediction-manifest.json").read_text())
    references={}
    for side in ("long","short"):
        rallies=[e for e in all_events if e["side"]==side]
        references[side]={}
        for name,raw in [
            ("default_screen",[a for a in screen["alerts"] if a["side"]==side]),
            ("discovery_attention",[{**a,"side":side} for a in screen["attention"]]),
            ("recorded_agent_attention",[{**a,"side":side} for a in attention if START<=a["at"]<END]),
        ]:
            references[side][name]=evaluate_alerts(deduplicate(raw),rallies)
    results=[]
    for model in manifest["predictions"]:
        with np.load(CACHE/model["file"]) as prediction:
            for quantile in ("0.95","0.9","0.99"):
                cutoff=model["cutoffs"][quantile]
                select=np.flatnonzero(prediction["scores"]>=cutoff)
                alerts=[{"at":int(prediction["time"][i]),"symbol":CATALOG[int(prediction["series"][i])]["symbol"],
                         "side":model["side"],"score":float(prediction["scores"][i])} for i in select]
                alerts=deduplicate(alerts)
                rallies=[e for e in all_events if e["side"]==model["side"]]
                result=evaluate_alerts(alerts,rallies)
                result.update({k:model[k] for k in ("seed","side","variant")})
                result["quantile"]=float(quantile)
                result["cutoff"]=cutoff
                result["incremental"]={name:incremental(result,base) for name,base in references[model["side"]].items()}
                result["by_alert_window"]=[]
                for window in PLAN["windows"]:
                    subset=[a for a in alerts if ms(window["start"])<=a["at"]<ms(window["end"])]
                    metrics=evaluate_alerts(subset,rallies)
                    result["by_alert_window"].append({**window,**{k:v for k,v in metrics.items() if k not in ("records","caught_at","lead_minutes")}})
                # Prior attention includes the previous24h even when it precedes the evaluation start.
                prior_new=[a for a in result["records"] if not any(
                    p["symbol"]==a["symbol"] and a["at"]-DAY<=p["at"]<=a["at"] for p in attention)]
                result["alerts_without_recorded_prior24h_attention"]={
                    "alerts":len(prior_new),"true":sum(a["status"]=="true" for a in prior_new),
                    "false":sum(a["status"]=="false" for a in prior_new),"unknown":sum(a["status"]=="unknown" for a in prior_new)}
                results.append(result)
    fresh.sweep.write_json(CACHE/"results.json",{
        "plan":PLAN,"event_counts":{side:sum(e["side"]==side for e in all_events) for side in ("long","short")},
        "log_coverage":log_coverage,"baselines":references,"models":results,
        "screen_coverage":screen["coverage"],
    })
    for result in results:
        if result["quantile"]==.95:
            print(json.dumps({k:v for k,v in result.items() if k not in ("records","caught_at","lead_minutes","by_alert_window")}),flush=True)


if __name__=="__main__":
    main()
