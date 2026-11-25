"""Check the chosen actions, actual stop/target order, and marked portfolio cash flows."""
from collections import defaultdict
import gzip
import json
import importlib.util

import joblib
import numpy as np

from adaptive import FIXED, HERE, Market, choices, fixed_choices, model, DISTANCES
from brackets import minute
from news_replay import CUTS, MARK
from settings import MARK_STOP, TEST_START, file_hash, load, ms, save_json
from source_data import FUNDING
bracket_check=importlib.util.spec_from_file_location("bracket_verification",FIXED/"verify.py")
verification=importlib.util.module_from_spec(bracket_check)
bracket_check.loader.exec_module(verification)
first_path=verification.first_path
reconcile=verification.reconcile


def evaluated(result, filename, actions, begin, stop, market, rates, field):
    groups=defaultdict(list)
    with gzip.open(HERE/filename,"rt") as fp:
        for line in fp:
            t=json.loads(line)
            policy=t[field]
            key=policy,t["mode"]
            candidate=t["candidate_id"]
            assert t["decision"]==market.at[candidate] and t["asset"]==market.symbols[candidate]
            assert t["sign"]==market.signs[candidate]
            target,loss=DISTANCES[actions[policy][candidate]]
            if "target_bps" in t:
                assert t["target_bps"]==target and t["stop_bps"]==loss
            first_path(t,t["mode"],None,market.raw,(target,loss),minute(stop),False)
            groups[key].append(t)
    count,held=0,0
    for policy,modes in result.items():
        for mode,s in modes.items():
            rows=groups[policy,mode]
            net,dd,missing=reconcile(rows,begin,stop,market.raw,rates)
            assert len(rows)==s["trades"]
            assert missing==s["missing_funding_hours"]
            assert sum(t["end"] is None for t in rows)==s["ending_open"]
            np.testing.assert_allclose([net,dd],[s["net"],s["max_drawdown"]],atol=1e-7)
            count+=len(rows)
            held+=s["ending_open"]
    return count,held


def verify():
    market=Market()
    models,kind=model()
    selection=load(HERE/"fit.json")
    assert ms(selection["fit_outcome_cutoff"])<TEST_START
    fitted={k:choices(models,market.x,market.signs,f) for k,f in
            (("adaptive",kind),("unconditional","unconditional"))}
    fitted["fixed"]=fixed_choices(market.signs)
    rates=joblib.load(FUNDING)
    main=load(HERE/"results.json")["modes"]
    count,held=evaluated(main,"trade-ledgers.jsonl.gz",fitted,TEST_START,MARK_STOP,market,rates,"policy")
    learned=load(HERE/"entry-results.json")["results"]
    more,still=evaluated(learned,"entry-trades.jsonl.gz",dict.fromkeys(learned,fitted["adaptive"]),
                         TEST_START,MARK_STOP,market,rates,"model")
    news=load(HERE/"news-results.json")["models"]
    additional,open_news=evaluated(news,"news-trades.jsonl.gz",dict.fromkeys(news,fitted["adaptive"]),
                                  CUTS[-1],MARK,market,rates,"model")
    for family in learned:
        record=load(HERE/f"{family}-entry-fit.json")["details"]
        assert ms(record["final"]["matured_at"])<TEST_START
        for fold in record["folds"]:
            assert ms(fold["train"]["matured_at"])<ms(fold["begin"])
    for item in load(HERE/"news-fit.json")["details"].values():
        assert ms(item["outcome_end"])<CUTS[-1]
    dataset=market.at>=TEST_START
    changes={str(s):int((dataset&(market.signs==s)&(fitted["adaptive"]!=fitted["fixed"])).sum())
             for s in (-1,1)}
    forward=load(HERE.parents[1]/"capped-entry-value/forward-runtime-lock.json")["files"]
    for p,h in forward.items():assert file_hash(HERE.parents[2]/p)==h
    save_json(HERE/"verification.json",dict(ledger_positions=count+more+additional,marked_open=held+still+open_news,
              changed_candidate_brackets=changes,forward_hashes=len(forward),
              results={p:file_hash(HERE/p) for p in ("results.json","entry-results.json","news-results.json")}))
    print("Verified ledger positions",count+more+additional,"terminal inventory",held+still+open_news,flush=True)

if __name__=="__main__":verify()
