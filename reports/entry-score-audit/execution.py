"""Join observed desk fills to allocation records, intent creation, venue orders and receipt-timed BBOs."""
from collections import Counter
from datetime import datetime,timezone
import argparse
import json
import requests
import numpy as np
from cohorts import HERE,FROZEN
from decisions import CACHE as BASE, load, save_json, ms, iso, HOUR
from evidence import query, millis, observations
from portfolio import quote
import joblib



def venue(acct,oid):
    if not oid:
        return None
    response=requests.post("https://api.hyperliquid.xyz/info",json=dict(type="orderStatus",user=acct,oid=oid),timeout=20)
    response.raise_for_status()
    doc=response.json()
    return doc["order"] if doc["status"]=="order" else None


def main(stage):
    full=joblib.load(BASE/(stage+".joblib"))
    ev=joblib.load(BASE/(stage+"-evidence.joblib"))
    start,end=[ms(full["window"][k]) for k in ("test_start","test_market_end")]
    sql=f"""select f.id fill_id,f."venueKey" venue_key,b."accountAddress" acct,i.id intent,
      i.oid parent_oid,i."stopCloid" stop_cloid,i."targetCloid" target_cloid,
      {millis('f."occurredAt"')} at,f.kind,f.quantity,f.price,f."feeUsd" fee,f."instrumentId" inst,
      {millis('i."createdAt"')} intent_at,i."arrivalPrice" arrival_reference,
      i."requestJson"::jsonb->>'proposalKey' proposal,
      a."dataJson"::jsonb->>'reviewedAt' reviewed_at,{millis('a."createdAt"')} allocation_record_at
      from "DeskCashFlow" f join "DeskBook" b on b.id=f."bookId" left join "DeskIntent" i on i.id=f."intentId"
      left join lateral (select * from "DeskRecord" a where a."bookId"=f."bookId" and a.kind='entry_allocation'
        and a."dataJson"::jsonb->>'intentId'=i.id and a."createdAt"<=f."occurredAt" order by a."createdAt" desc limit 1) a on true
      where not b."isTestnet" and f."occurredAt" between to_timestamp({start}/1000.) and to_timestamp({end}/1000.)
      and f."instrumentId" like 'mainnet:perp:%' and f.kind in ('fill','protection') order by f."occurredAt",f.id"""
    db=query("DATABASE_URL",sql)
    if stage=="benchmark":
        rows=load(FROZEN/"execution-reconciliation.json")
    else:
        from benchmark import reconcile
        rows=reconcile(full,ev,start,end)
    fills=rows["fills"]
    keys={(r["inst"].split(":",2)[2],int(r["intent_at"])) for r in db if r["intent_at"]}
    tick=observations(keys)
    joined=[]
    orders={}
    def order(acct,oid):
        if (acct,oid) not in orders:
            orders[acct,oid]=venue(acct,oid)
        return orders[acct,oid]
    for r,ref in zip(db,fills,strict=True):
        sym=r["inst"].split(":",2)[2]
        at=int(r["at"])
        qty=float(r["quantity"])
        assert (ref["symbol"],ref["at"],ref["kind"],ref["quantity"],ref["actual"])==(sym,at,r["kind"],qty,float(r["price"]))
        identifier=r["venue_key"].split(":")[-1]
        oid=int(identifier) if identifier.isdigit() else None
        obs=order(r["acct"],oid) if oid is not None else None
        detail=obs["order"] if obs else {}
        if obs:
            assert int(detail["oid"])==oid and detail["coin"]==sym
        intent_at=int(r["intent_at"]) if r["intent_at"] else None
        snapshot=tick.get((sym,intent_at))
        book=quote(snapshot,intent_at) if intent_at else None
        trigger=None
        if r["kind"]=="protection":
            for coid in (r["stop_cloid"],r["target_cloid"]):
                part=order(r["acct"],coid) if coid else None
                if part and part["status"]=="triggered" and int(part["order"]["oid"])==oid:
                    trigger=part["statusTimestamp"]
        ent=r["reviewed_at"]
        markets=full["markets"].get("recent-"+sym)
        minute_open=None
        if markets:
            i=(at-markets[0])//60000
            if 0<=i<len(markets[1]) and np.isfinite(markets[1][i]):
                minute_open=float(markets[1][i])
        joined.append(dict(symbol=sym,kind=r["kind"],fill_id=r["fill_id"],intent_id=r["intent"],proposal=r["proposal"] or None,
            signed_quantity=qty,order_id=oid,parent_order_id=r["parent_oid"] or None,allocation_decision=ent or None,
            allocation_record_ms=int(r["allocation_record_at"]) if r["allocation_record_at"] else None,
            intent_created_ms=intent_at,client_submission_ms=None,client_acknowledgement_ms=None,
            venue_order_timestamp=detail.get("timestamp"),venue_status=obs["status"] if obs else None,
            venue_status_ms=obs["statusTimestamp"] if obs else None,venue_order_type=detail.get("orderType"),
            trigger_condition=detail.get("triggerCondition"),explicit_trigger_ms=trigger,fill_ms=at,price=ref["actual"],
            fee=ref["actual_fee"],intent_arrival_reference=float(r["arrival_reference"]) if r["arrival_reference"] else None,
            intent_time_bbo=dict(bid=book[0],ask=book[1],bid_size=book[2],ask_size=book[3],event_ms=snapshot["book_at"],
                                 received_ms=snapshot["book_received"]) if book else None,
            modeled=ref["modeled"],fill_price_source=ref["source"],minute_open=minute_open,
            adverse_residual_bps=ref["adverse_residual_bps"],fee_residual=ref["fee_residual"]))
    assert len(joined)==len(fills)
    if stage=="benchmark":
        assert len(fills)==11
    res=np.array([r["adverse_residual_bps"] for r in joined if r["adverse_residual_bps"] is not None])
    funding=[]
    for rec in rows["funding"]:
        symbol,at=rec["symbol"],rec["at"]//HOUR*HOUR
        market=full["markets"].get("recent-"+symbol)
        item=market[2].get(at) if market else None
        if not item:
            funding.append(dict(**rec,settlement=at,rate=None,valuation_price=None))
            continue
        price,rate=item
        oracle=ev.get("oracles",{}).get((symbol,at))
        rebuilt=-rec["quantity"]*(oracle or price)*rate
        np.testing.assert_allclose(rebuilt,rec["modeled"],atol=1e-12)
        funding.append(dict(**rec,settlement=at,rate=rate,valuation_price=oracle or price))
    summary=dict(fills=len(joined),distinct_orders=len({r["order_id"] for r in joined if r["order_id"] is not None}),
        distinct_timestamps=len({r["fill_ms"] for r in joined}),symbols=len({r["symbol"] for r in joined}),
        source=dict(Counter(r["fill_price_source"] for r in joined)),median_bps=float(np.median(res)) if len(res) else None,
        empirical_adverse_p90_bps=float(np.quantile(res,.9)) if len(res) else None,worst_adverse_bps=float(res.max()) if len(res) else None,
        mean_abs_bps=float(abs(res).mean()) if len(res) else None,equal_to_minute_open=sum(r["price"]==r["minute_open"] for r in joined),
        effective_fee_bps=10000*sum(r["fee"] for r in joined)/sum(abs(r["signed_quantity"])*r["price"] for r in joined) if joined else None,
        fee_residual_usd=sum(r["fee_residual"] for r in joined),
        joined_counts={k:sum(r[k] is not None for r in joined) for k in ("allocation_decision","intent_created_ms",
             "client_submission_ms","client_acknowledgement_ms","venue_order_timestamp","intent_time_bbo","explicit_trigger_ms")})
    output="execution-joins.json" if stage=="benchmark" else "shadow-execution-joins.json"
    save_json(HERE/output,dict(source_stage=stage,venue_status_checked=datetime.now(timezone.utc).isoformat(),
                               summary=summary,records=joined,settlements=funding))
    print(summary)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage",nargs="?",default="benchmark",choices=("benchmark","shadow"))
    main(parser.parse_args().stage)
