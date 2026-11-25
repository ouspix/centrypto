"""Supplement episode detection with observed price moves from the alert itself."""
import json
import statistics
from collections import defaultdict
import numpy as np
from evaluate import CACHE, PLAN, BAR, DAY, series, iso, incremental
from data import fresh


def forward(alert):
    state=series(alert["symbol"])
    at=state["time"]
    index=int(np.searchsorted(at,alert["at"],side="right"))-1
    price=float(state["close"][index])
    if not np.isfinite(price):
        return {"status":"unknown","reason":"reference_close_missing"}
    ids=np.flatnonzero((at>at[index])&(at<=at[index]+DAY))
    sign=1 if alert["side"]=="long" else -1
    returns=sign*100*(state["close"][ids]/price-1)
    hit=np.flatnonzero(returns>=10)
    observed=np.isfinite(returns)
    complete=len(ids)==288 and bool(observed[-1]) and observed.mean()>=.9
    status="true" if len(hit) else "false" if complete else "unknown"
    first=int(at[ids[hit[0]]]-5000) if len(hit) else None
    return {"status":status,"reference_price":price,
            "maximum_observed_directional_move_pct":float(np.nanmax(returns)) if observed.any() else None,
            "first_hit":iso(first) if first else None,
            "minutes_to_10pct":(first-alert["at"])/60000 if first else None}


def main():
    results=json.loads((CACHE/"results.json").read_text())
    for model in results["models"]:
        hits=[]
        counts=defaultdict(int)
        corroborated=set()
        for alert in model["records"]:
            response=forward(alert)
            alert["forward_10pct"]=response
            counts[response["status"]]+=1
            if response["status"]=="true":
                hits.append(response["minutes_to_10pct"])
                corroborated.update(alert["events"])
        model["forward_10pct"]={
            "true":counts["true"],"false":counts["false"],"unknown":counts["unknown"],
            "median_minutes_to_10pct":statistics.median(hits) if hits else None,
            "detected_episodes_also_with_forward_10pct":len(corroborated),
        }
        refs=results["baselines"][model["side"]]
        union={}
        for name in ("default_screen","discovery_attention"):
            for key,at in refs[name]["caught_at"].items():
                union[key]=min(union.get(key,at),at)
        model["incremental"]["screen_and_discovery"]=incremental(model,{"caught_at":union})
    results["forward_check_definition"]=(
        "Supplemental check added after episode results were inspected. Native closed price at alert to "
        "any later observed closed price within24h, requiring >=10% in the alert direction. "
        "No best-entry timing label, fees, position or order. Missing-path rules match episode evaluation. "
        "The frozen primary episode test and all thresholds remain separately recorded."
    )
    fresh.sweep.write_json(CACHE/"results.json",results)
    for r in results["models"]:
        if r["quantile"]==.95:
            print(r["side"],r["variant"],r["seed"],r["forward_10pct"],
                  r["incremental"]["screen_and_discovery"],flush=True)


if __name__=="__main__":
    main()
