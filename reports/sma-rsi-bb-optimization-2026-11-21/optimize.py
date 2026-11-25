"""Run validation search, lock policy settings, and replay the chronological holdout."""
import argparse
import itertools
import json

from pathlib import Path

import joblib
import numpy as np
from train import HERE, CACHE, CONFIGS, FOLD, PLAN, CausalData, file_hash, load_bank, member_path, save_json, threadpool_limits
from capture import ms
from economics import Costs, gate, summarize
from indicators import augment, build_bank
from price_common import OLD_CFG
from repair_replay import cash, exit_predictions_all, models_for
from repair_network import predict
from engine import replay

SIDES = ("long","short")
SEEDS = PLAN["seeds"]
REPAIR = HERE.parent/"policy-repair-2026-11-15"
PAIRS = OLD_CFG["pairs"]

def action(index,threshold,pair):
    return dict(config=index,threshold=threshold,pair=pair)

def describe(choice):
    if choice is None:
        return None
    index = choice["config"]
    return dict(**choice,rsi=CONFIGS[index][0],bb=CONFIGS[index][1],
                sma="all" if choice["pair"] is None else PAIRS[choice["pair"]])

def rank(stats):
    if stats["unknown"]:
        return (-np.inf,-np.inf)
    return (stats["lower_bound_usd"],-stats["closed_drawdown_usd"])

class Evaluation:
    def __init__(self,data,start,end,bank,indices):
        self.data = data
        self.costs = Costs(data)
        self.scores = {}
        self.ids = {}
        self.exits = {}
        self.days = set()
        self.pair_masks = {}
        original = models_for(FOLD)
        for sign,side in ((1,"long"),(-1,"short")):
            ids = data.replay_ids(ms(start),ms(end),sign)
            self.ids[side] = ids
            self.days.update(str(d) for d in np.unique(data.d.state["time"][data.c["row"][ids]].astype("datetime64[ms]").astype("datetime64[D]")))
            self.pair_masks[side] = data.c["pair"][ids]
            raw = data.entry_rows(ids)
            keep = np.zeros(len(ids),bool)
            for idx in indices:
                x,extras = augment(raw,bank,ids,CONFIGS[idx])
                members = [joblib.load(member_path(idx,side,seed)) for seed in SEEDS]
                if any(m["input_names"] != data.entry_names+extras for m in members):
                    raise ValueError("Entry feature order mismatch")
                seeds = np.array([predict(m,x) for m in members])
                self.scores[(side,idx)] = np.vstack([seeds,seeds.mean(axis=0)])
                keep |= seeds.max(axis=0) >= min(PLAN["thresholds"])
            # Include the previous repaired-model benchmark using the same exits.
            old = np.array([predict(m[side]["entry"],raw) for m in original])
            self.scores[(side,-1)] = np.vstack([old,old.mean(axis=0)])
            keep |= old.max(axis=0)>=min(PLAN["thresholds"])
            entries = np.unique(data.c["row"][ids[keep]])
            exits = exit_predictions_all(data,[m[side]["exit"] for m in original],entries,sign,[.5],True)[-1]
            self.exits[side] = exits
            print("Prepared",side,len(ids),"candidates,",len(entries),"possible exit paths",flush=True)
        self.days = sorted(self.days)

    def ledger(self,choices,member=-1,*,exit_rules=None):
        prepared,policies = {},{}
        for side,choice in zip(SIDES,choices):
            if choice is None:
                policies[side] = cash()
                continue
            threshold = choice["threshold"]
            scores = self.scores[(side,choice["config"])][member]
            keep = scores >= threshold
            if choice["pair"] is not None:
                keep &= self.pair_masks[side] == choice["pair"]
            exits, cutoffs, cutoff = (self.exits[side],[.5],.5) if exit_rules is None else exit_rules[side]
            prepared[side] = dict(ids=self.ids[side][keep],score=scores[keep],exits=exits,thresholds=cutoffs)
            policies[side] = dict(cash=False,entry_threshold=threshold,exit_threshold=cutoff)
        trades,_ = replay(self.data,prepared,policies,FOLD,"sma_rsi_bb")
        for t in trades:
            t.update(self.costs.charge(t))
            if t["gross"] is not None and abs(t["gross"]-t["return_pct"])>1e-8:
                raise ValueError("Ledger gross P&L does not match the replay")
        return trades

    def stats(self,choices,member=-1):
        return summarize(self.ledger(choices,member),self.days)

    def supported(self,choices,stats):
        if not gate(stats):
            return False
        return all((self.stats(choices,i)["net"] or 0)>0 for i in range(len(SEEDS)))

def shortlist(ev,side):
    pos=SIDES.index(side)
    rows=[]
    for idx,threshold,pair in itertools.product(range(len(CONFIGS)),PLAN["thresholds"],[None,*range(len(PAIRS))]):
        choice=action(idx,threshold,pair)
        choices=[None,None]
        choices[pos]=choice
        stats=ev.stats(choices)
        rows.append(dict(choice=choice,summary=stats))
    rows.sort(key=lambda r:rank(r["summary"]),reverse=True)
    save_json(HERE/f"validation-{side}.json",rows)
    return rows

def finalists(rows,control=False):
    # Include distinct feature configurations and an abstention option.
    allowed=[r for r in rows if (not control or r["choice"]["config"]==0) and
             r["summary"]["trades"]>=20 and not r["summary"]["unknown"]]
    picked=[]
    for row in allowed:
        choice=row["choice"]
        if control or choice["config"] not in {c["config"] for c in picked}:
            picked.append(choice)
        if len(picked)==6:
            break
    return [None,*picked]

def joint(ev,shortlists):
    candidates=[]
    for choices in itertools.product(*shortlists):
        stats=ev.stats(choices)
        supported=any(choices) and ev.supported(choices,stats)
        candidates.append(dict(choices=choices,summary=stats,eligible=supported))
    candidates.sort(key=lambda r:rank(r["summary"]),reverse=True)
    selected=next((r for r in candidates if r["eligible"]),None)
    cash_row=next(r for r in candidates if not any(r["choices"]))
    active=next((r for r in candidates if r["summary"]["trades"]>=20 and not r["summary"]["unknown"]),None)
    return selected or cash_row,active,candidates

def fingerprint(choices):
    files = {}
    for side,choice in zip(SIDES,choices):
        if choice is not None:
            for seed in SEEDS:
                path=member_path(choice["config"],side,seed)
                files[str(path)] = file_hash(path)
    for side in SIDES:
        for seed in SEEDS:
            path=CACHE.parent/"policy-repair-2026-11-15"/"models"/FOLD/f"{side}_exit_{seed}.joblib"
            files[str(path)]=file_hash(path)
    return files

def search():
    data=CausalData()
    ev=Evaluation(data,PLAN["validation_start"],PLAN["validation_market_end"],load_bank(CONFIGS),range(len(CONFIGS)))
    rows=[shortlist(ev,side) for side in SIDES]
    selected,_,joints=joint(ev,[finalists(r) for r in rows])
    control,_,_=joint(ev,[finalists(r,True) for r in rows])
    # Always score the highest-ranked indicator challenger to measure it when cash wins.
    pools=[finalists([r for r in side_rows if r["choice"]["config"]!=0]) for side_rows in rows]
    _,challenger,_=joint(ev,pools)
    choices=dict(selected=selected["choices"],validation_tuned_no_indicators=control["choices"],
                 archived_price_error_cash=[None,None],
                 original_price_error_frozen_thresholds=[action(0,.95,None),action(0,.9,None)],
                 repaired_classifier_frozen_thresholds=[action(-1,.95,None),action(-1,.9,None)])
    if challenger is not None:
        choices["best_active_indicator_challenger"]=challenger["choices"]
    lock=dict(policies=choices,selected=[describe(c) for c in selected["choices"]],
              challenger=[describe(c) for c in challenger["choices"]] if challenger else None,
              validation={k:ev.stats(v) for k,v in choices.items()},days=ev.days,
              joint_configurations=len(joints),single_side_trials=2*len(CONFIGS)*len(PLAN["thresholds"])*(len(PAIRS)+1),
              network_hashes={path:sha for v in choices.values() if all(not c or c["config"]>=0 for c in v)
                              for path,sha in fingerprint(v).items()},
              plan_sha256=file_hash(HERE/"plan.json"))
    save_json(HERE/"joint-validation.json",joints)
    save_json(HERE/"selection.json",lock)
    print("Locked",lock["selected"],"challenger",lock["challenger"],flush=True)

def backtest():
    lock=json.loads((HERE/"selection.json").read_text())
    assert file_hash(HERE/"plan.json")==lock["plan_sha256"]
    for path,sha in lock["network_hashes"].items():
        assert file_hash(Path(path))==sha
    from forward import ForwardData
    data=ForwardData()
    indices=sorted({c["config"] for policy in lock["policies"].values() for c in policy if c and c["config"]>=0})
    bank=build_bank(data,[CONFIGS[i] for i in indices])
    ev=Evaluation(data,PLAN["test_start"],PLAN["test_market_end"],bank,indices)
    # A matched control isolates the entry feature change from SMA-pair and threshold selection.
    controls = dict(lock["policies"])
    controls["same_sma_thresholds_no_indicators"] = [
        action(0,c["threshold"],c["pair"]) if c else None for c in controls["selected"]]
    ledger={}
    results={}
    for name,choices in controls.items():
        rows=ev.ledger(choices)
        for t in rows:
            assert ms(PLAN["test_start"])<=ms(t["entry_time"])<=ms(PLAN["test_entry_end"])
            assert ms(t["exit_time"])<=ms(PLAN["test_market_end"])
        ledger[name]=rows
        results[name]=dict(overall=summarize(rows,ev.days),
                           by_side={s:summarize([r for r in rows if r["side"]==s],ev.days) for s in SIDES})
    stability = [{"seed":seed, "summary":ev.stats(controls["selected"],i)} for i,seed in enumerate(SEEDS)]
    source_summary=dict(symbols=len(data.d.catalog),eligible_rows={s:len(i) for s,i in ev.ids.items()},
                        days=ev.days,archived_feature_parity=dict(data.parity),actual_start=PLAN["test_start"],
                        last_signal_cutoff=PLAN["test_entry_end"],outcome_cutoff=PLAN["test_market_end"])
    save_json(HERE/"trades.json",ledger)
    save_json(HERE/"result.json",dict(results=results,coverage=source_summary,selected_seed_sensitivity=stability,
                                     selection_sha256=file_hash(HERE/"selection.json")))
    print(json.dumps({k:v["overall"] for k,v in results.items()}),flush=True)

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("stage",choices=["search","backtest"])
    args=parser.parse_args()
    with threadpool_limits(limits=1):
        (search if args.stage=="search" else backtest)()
