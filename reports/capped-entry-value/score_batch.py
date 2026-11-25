"""Score one five-minute paper decision from point-in-time features, holdings and pending intents."""
import argparse
import json
import math
import sys

import joblib
import numpy as np

from decisions import HERE,SIDES,file_hash,load
from forecast import predict_head
from repair_data import ENTRY_CORE


def decide(batch,bundle):
    at = batch["decision_ms"]
    reserved = set(batch["open_symbols"]) | set(batch["pending_symbols"])
    entered = {tuple(x) for x in batch["entered_episodes"]}
    arm = bundle["primary"]
    hurdle = bundle["selection"][arm]["buffer_bps"]
    decisions,ranked,keys = [],[],set()
    for c in batch["candidates"]:
        symbol,side,episode = c["symbol"],c["side"],c["episode"]
        identity = (symbol,side,episode)
        if side not in SIDES or identity in keys:
            raise ValueError("Invalid or duplicate candidate identity")
        keys.add(identity)
        d = dict(symbol=symbol,side=side,episode=episode,action="wait",expected_net_bps=None)
        decisions.append(d)
        if not c["valid"] or at>c["expires_ms"]:
            d.update(action="skip",reason="episode_invalid_or_expired")
            continue
        if c["feature_time_ms"]!=at or c["available_ms"]>at:
            d["reason"] = "inputs_unavailable_at_decision"
            continue
        values = c["features"]
        if not all(isinstance(values.get(n),(float,int)) and math.isfinite(values[n]) for n in ENTRY_CORE):
            d["reason"] = "missing_required_market_inputs"
            continue
        m = bundle["models"][side][arm]
        raw = np.array([[values.get(k) for k in m["columns"]]],dtype=float)
        if np.isinf(raw).any():
            raise ValueError("Feature inputs must be finite or null")
        d["expected_net_bps"] = float(m["intercept"]+m["slope"]*predict_head(m["model"],raw)[0])
        if symbol in reserved or identity in entered:
            d["reason"] = "position_pending_or_episode_entered"
        elif hurdle is None or d["expected_net_bps"]<=hurdle:
            d["reason"] = "below_hurdle"
        else:
            ranked.append(d)
    for d in sorted(ranked,key=lambda d:(-d["expected_net_bps"],d["symbol"],d["side"],d["episode"])):
        if d["symbol"] in reserved:
            d["reason"] = "symbol_reserved"
        elif len(reserved)>=10:
            d["reason"] = "no_slot"
        else:
            reserved.add(d["symbol"])
            d.update(action="enter",reason="clears_hurdle",entry_notional_usd=100)
    return dict(decision_ms=at,model=arm,buffer_bps=hurdle,decisions=decisions)


if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input",nargs="?",type=argparse.FileType("r"),default=sys.stdin)
    args = parser.parse_args()
    model = HERE/"entry-models.joblib"
    lock = load(HERE/"research-lock.json")
    if file_hash(model)!=lock["bundle_sha256"]:
        raise ValueError("Model bundle differs from the research lock")
    print(json.dumps(decide(json.load(args.input),joblib.load(model)),allow_nan=False))
