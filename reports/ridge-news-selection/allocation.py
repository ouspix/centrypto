"""Trace absolute admission and independent ranking on live or fixed reference portfolio states."""
from collections import Counter,defaultdict
from hashlib import sha256
from itertools import groupby
import numpy as np

from inputs import prior

def key(r):
    return r["side"],r["id"]

def seed_priority(seed,r):
    text=f"{seed}|{r['decision']}|{r['symbol']}|{r['side']}|{r['id']}"
    return int.from_bytes(sha256(text.encode()).digest()[:6],"big")

def replay(rows,signals,stop,*,reference=None,journal=None):
    held,used={},set()
    ledger,states,rejected=[],{},[]
    contests,competing=set(),set()
    results=Counter()
    encoded=[]
    for at,batch_iter in groupby(sorted(rows,key=lambda r:r["decision"]),key=lambda r:r["decision"]):
        batch=list(batch_iter)
        if reference is None:
            held={s:t for s,t in held.items() if t>=at}
        else:
            held,used=reference[at]
            held,used=held.copy(),used.copy()
        # Snapshot only the relevant episodes at each time.
        states[at]=(held.copy(),{(r["side"],r["setup"]) for r in batch if (r["side"],r["setup"]) in used})
        before=tuple(sorted(held))
        free=10-len(held)
        reason={}
        groups=defaultdict(list)
        for r in batch:
            k=key(r)
            gate,priority=signals[k]
            if gate<=15 or not np.isfinite(gate):
                reason[k]="below_hurdle"
            elif r["symbol"] in held:
                reason[k]="symbol_busy"
            elif (r["side"],r["setup"]) in used:
                reason[k]="episode_entered"
            else:
                groups[r["symbol"]].append(r)
        def order(r):
            return (-signals[key(r)][1],r["symbol"],r["side"],r["id"])
        representatives=[]
        for group in groups.values():
            first,*rest=sorted(group,key=order)
            representatives.append(first)
            for r in rest:
                reason[key(r)]="same_symbol_alternatives"
        contested=0<free<len(representatives)
        if contested:
            contests.add(at)
            competing.update(map(key,representatives))
        for r in sorted(representatives,key=order):
            k=key(r)
            if len(held)>=10:
                reason[k]="capacity_rejections"
                rejected.append(r)
            elif r["status"]=="entry_rejected":
                reason[k]="arrival_rejections"
                held[r["symbol"]]=r["entry"]
            else:
                reason[k]="executed"
                held[r["symbol"]]=stop if r["status"] in ("unknown_entry","unknown_exit") else r["end"]
                used.add((r["side"],r["setup"]))
                ledger.append(dict(r,score=float(signals[k][0])))
        for r in batch:
            k=key(r)
            gate,priority=signals[k]
            results[reason[k]]+=1
            if reference is None:
                encoded.append((r,priority if gate>15 else -np.inf,-np.inf))
            if journal:
                journal(r,gate,priority,free,before,reason[k],k in competing)
    if reference is None:
        verified,counts=prior.allocate(encoded,10,stop)
        assert list(map(key,ledger))==list(map(key,verified))
        assert all(results[k]==n for k,n in counts.items())
    return ledger,states,dict(counts=dict(results),positive_slot_contests=len(contests),
        oversubscribed_batches_including_full=sum(1 for _ in set(r["decision"] for r in rejected)),
        contested_candidates=competing,rejected=rejected)

def payoff(rows):
    values=[r["net"] for r in rows if r["net"] is not None]
    return dict(rows=len(rows),priced=len(values),mean_usd=float(np.mean(values)) if values else None,
                total_priced_usd=float(sum(values)),unpriced=len(rows)-len(values))

def changed(left,right):
    x={key(r):r for r in left}
    y={key(r):r for r in right}
    return dict(shared=len(x.keys() & y.keys()),only_left=payoff([x[k] for k in x.keys()-y.keys()]),
                only_right=payoff([y[k] for k in y.keys()-x.keys()]))
