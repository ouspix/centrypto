"""Verify the frozen source hashes, ledger parity, decisions, and ten-slot exposure."""
import json
from pathlib import Path

import joblib
import numpy as np
from benchmark import check_original, evaluation, priced
from decisions import CACHE, HERE, ROOT, SIDES, file_hash, load, ms
from forecast import features,score_pack
from score_batch import decide


def verify():
    lock = load(HERE/"research-lock.json")
    assert file_hash(HERE/"entry-models.joblib")==lock["bundle_sha256"]
    for base,hashes in ((ROOT,lock["sources"]),(HERE,lock["code"])):
        for name,sha in hashes.items():
            assert file_hash(base/name)==sha,name
    for name,sha in load(HERE/"forward-runtime-lock.json")["files"].items():
        assert file_hash(ROOT/name)==sha,name
    tape = joblib.load(CACHE/"benchmark.joblib")
    evidence = joblib.load(CACHE/"benchmark-evidence.joblib")
    model = joblib.load(HERE/"entry-models.joblib")
    manifest = load(HERE/"coverage-manifest.json")
    for stage,entry in manifest["stages"].items():
        assert file_hash(HERE/entry["asset_file"])==entry["sha256"]
        for name,sha in entry["source_fingerprints"].items():
            assert file_hash(CACHE/name)==sha
    for entry in load(HERE/"decision-ledgers.json").values():
        assert file_hash(ROOT/entry["relative_path"])==entry["sha256"]
    summary = load(HERE/"capped-objectives.json")
    start,end = map(ms,summary["period"])
    rows = priced(tape,evidence,"candle")
    for arm in ("saved_price_error","matched_price_error","net_value"):
        scores = {s:tape["sides"][s]["scores"][arm] for s in SIDES}
        for cap in (10,999):
            trades,stats,_,_ = evaluation(rows,tape["sides"],scores,.9,tape["markets"],start,end,cap,True,True)
            if cap==999:
                check_original(arm,trades)
            else:
                published = summary["modes"]["candle"]["arms"][arm]["10"]
                assert stats["net"]==published["net"] and stats["trades"]==published["trades"]
                assert stats["peak_entry_notional"]<=1000
    arm = model["primary"]
    for side,pack in tape["sides"].items():
        names,x = features(pack,evidence["ticks"])
        reference = score_pack(pack,evidence["ticks"],{arm:model["models"][side][arm]})[arm]
        for i in (0,100,500):
            r = pack["records"][i]
            at = r["decision"]
            candidate = dict(symbol=r["symbol"],side=side,episode=r["setup"],valid=True,
                expires_ms=at,feature_time_ms=at,available_ms=at,features=dict(zip(names,x[i].tolist())))
            result = decide(dict(decision_ms=at,open_symbols=[],pending_symbols=[],entered_episodes=[],
                                 candidates=[candidate]),model)
            np.testing.assert_allclose(result["decisions"][0]["expected_net_bps"],reference[i],rtol=1e-9)
    print("Verified locked sources, coverage, opportunity ledgers, original trades, capped results and paper scores.")


if __name__=="__main__":
    verify()
