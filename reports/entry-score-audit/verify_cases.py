"""Check the observed SOPH stress defect and the ranked-versus-tied allocation replay."""
import json
import numpy as np
from study import source, HERE, FROZEN, load, save_json, iso, ms
from accounting import reprice, marked


def main():
    tape,ev=source("benchmark")
    enter=ms("2026-11-19T18:26:00Z")
    records=[r for p in tape["sides"].values() for r in p["records"] if r["symbol"]=="SOPH" and r["entry"]==enter]
    checks=[]
    for row in records:
        m=tape["markets"][row["key"]]
        base,stress=[reprice(row,m,ev["ticks"],mode,ev.get("oracles")) for mode in ("observed","stress")]
        if stress["status"]!="unknown_exit" or not base["funding_flows"]:
            continue
        old_cash=base["funding_flows"][0][1]
        receipt=stress["funding_flows"][0][1]
        assert stress["end"]==ms("2026-11-19T19:42:00Z") and stress["net"] is None
        np.testing.assert_allclose(receipt,old_cash*stress["qty"]/base["qty"],rtol=1e-12)
        at=stress["funding_flows"][0][0]
        _,grid,curve=marked([stress],tape["markets"],enter,stress["end"]+60000,10)
        no_receipt=dict(stress,funding_flows=[])
        _,_,prior=marked([no_receipt],tape["markets"],enter,stress["end"]+60000,10)
        np.testing.assert_allclose((curve-prior)[grid==at],receipt,rtol=1e-9,atol=1e-12)
        checks.append(dict(symbol=row["symbol"],side=row["side"],candidate=row["id"],stressed_entry=iso(stress["entry"]),
            planned_exit=iso(stress["end"]),status=stress["status"],net=stress["net"],known_receipt=receipt,
            receipt_time=iso(at),original_base_receipt=old_cash))
    assert checks and all(r["known_receipt"]<0 for r in checks)
    j=load(HERE/"benchmark-audit.json")
    c=j["frozen"]["score_contribution"]
    np.testing.assert_allclose(c["ridge"]["net"]-c["constant"]["net"],sum(c["ridge_minus_constant"]["paired"]["daily"].values()))
    np.testing.assert_allclose(c["ridge"]["net"]-c["constant"]["net"],
        c["ridge_minus_constant"]["only_left_net"]-c["ridge_minus_constant"]["only_right_net"])
    for variant in j.values():
        for arm in variant["arms"].values():
            for d in arm["diagnostics"].values():
                assert sum(b["priced"] for b in d["score_buckets"])==d["groups"]["all"]["priced"]
                if d["calibrated"]["distinct"]==1:
                    assert len(d["score_buckets"])==1
    save_json(HERE/"case-verification.json",dict(soph=checks,original_ledgers_verified=len(load(FROZEN/"research-lock.json")["selection"]),
                                                 allocation_cash_and_score_bins_verified=True))
    print(checks)


if __name__=="__main__":
    main()
