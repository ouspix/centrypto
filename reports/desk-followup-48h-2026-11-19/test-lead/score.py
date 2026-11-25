"""Score sealed test-lead decisions using the preceding 48-hour replay's cost model."""
import csv
import gzip
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
MINUTE = 60000
HOUR = 60 * MINUTE
FEE = 0.00045
SLIP = 0.0005

def load_json(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)

def ms(stamp):
    return round(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()*1000)

def stamp(t, tz=timezone.utc):
    return datetime.fromtimestamp(t/1000, tz).isoformat(timespec="minutes")

def brackets(bars, start, deadline, sign, stop, target):
    for at in range(start, deadline, MINUTE):
        op, hi, lo = bars[at]
        if sign*(op-stop) <= 0:
            return at, op, "stop_gap"
        if target and sign*(op-target) >= 0:
            return at, target, "target"
        if (lo <= stop if sign == 1 else hi >= stop):
            return at, stop, "stop"
        if target and (hi >= target if sign == 1 else lo <= target):
            return at, target, "target"
    return deadline, bars[deadline][0], "horizon"

def pnl(bars, rates, start, end, size, sign, filled, exit_mid):
    exit_px = exit_mid*(1-sign*SLIP)
    carry = sum(-sign*size*bars[h][0]*rates[h] for h in range((start//HOUR+1)*HOUR, end+1,HOUR))
    fees = (filled+exit_px)*size*FEE
    gross = size*sign*(exit_px-filled)
    return gross-fees+carry, fees, carry, exit_px

def main():
    packets = load_json(ROOT/"decision-packets.json.gz")
    scoring = load_json(ROOT/"scoring-inputs.json.gz")
    calls = [json.loads(x) for x in (ROOT/"sealed-decisions.jsonl").read_text().splitlines()]
    decisions = {r['decision']['id']:r['decision'] for r in calls}
    assert len(packets)==len(calls)==len(decisions)==27
    ledger = []
    for p in sorted(packets,key=lambda p:(p["alertUTC"],p["id"])):
        key=p['id']; case=scoring[key]; dec=decisions[key]
        start=ms(p['alertUTC'])+2*MINUTE
        deadline=math.ceil(ms(p['decisionDeadlineUTC'])/MINUTE)*MINUTE
        sign=1 if p['side']=='buy' else -1
        row=dict(case=key,alert_utc=p["alertUTC"],alert_paris=stamp(ms(p["alertUTC"]), ZoneInfo("Europe/Paris")),symbol=p['symbol'],side=p['side'],
                 missed_review=case['missed'],action=dec['action'],decision_reason=dec['reason'],what_changed=dec['whatChanged'],
                 planned_notional_usd=dec['notionalUsd'],stop=dec['stopPrice'],target=dec['targetPrice'],status="cash",
                 quantity=0,notional_usd=0,entry_utc=None,entry=None,deadline_utc=p['decisionDeadlineUTC'],horizon_exit=None,
                 horizon_fees_usd=0,horizon_funding_usd=0,horizon_pnl_usd=0,bracket_exit_utc=None,bracket_exit=None,
                 bracket_exit_reason=None,bracket_fees_usd=0,bracket_funding_usd=0,bracket_pnl_usd=0,execution_evidence=None)
        ledger.append(row)
        if dec['action'] == 'pass':
            continue
        bars={r[0]:r[1:] for r in case['bars']}
        rates={t//HOUR*HOUR:rate for t,rate in case['funding']}
        entry=bars[start][0]*(1+sign*SLIP)
        stop,target=dec['stopPrice'],dec['targetPrice']
        if sign*(entry-stop)<=0 or (target is not None and sign*(target-entry)<=0):
            row['status']='levels_invalid_at_entry'
            continue
        m=p['bookMandate']
        risk=abs(entry-stop)/entry+m['costAllowanceBps']/10000
        capped=min(dec['notionalUsd'],100,m['maxOrderUsd']*.98,m['maxInstrumentUsd']*.98,m['maxRiskPerTradeUsd']*.98/risk)
        precision=10**case['sizeDecimals']
        size=math.floor(capped/entry*precision)/precision
        if size*entry<10:
            row['status']='below_minimum'
            continue
        row.update(status='modeled_fill',quantity=size,notional_usd=size*entry,entry_utc=stamp(start),entry=entry)
        q=case['entryQuote']
        evidence='no_fresh_archived_quote'
        if q:
            price,qty=(q['ask'],q['askSz']) if sign==1 else (q['bid'],q['bidSz'])
            mid=(q['bid']+q['ask'])/2
            in_band=abs(price/mid-1)*10000<=m['maxSlippageBps']
            evidence=('top_level_supports_depth' if in_band and qty and qty*price>=m['minDepthUsd']
                      else 'top_level_insufficient_to_verify_full_band')
        row['execution_evidence']=evidence
        net,fee,fund,px=pnl(bars,rates,start,deadline,size,sign,entry,bars[deadline][0])
        assert abs(net/row['notional_usd']*10000-case['originalReturnBps'])<1e-6
        row.update(horizon_pnl_usd=net,horizon_fees_usd=fee,horizon_funding_usd=fund,horizon_exit=px)
        at,mid,reason=brackets(bars,start,deadline,sign,stop,target)
        net,fee,fund,px=pnl(bars,rates,start,at,size,sign,entry,mid)
        row.update(bracket_exit_utc=stamp(at),bracket_exit=px,bracket_exit_reason=reason,bracket_pnl_usd=net,bracket_fees_usd=fee,bracket_funding_usd=fund)
    with (ROOT/"test-lead-ledger.csv").open("w",encoding="utf-8",newline="") as f:
        writer=csv.DictWriter(f,fieldnames=ledger[0]); writer.writeheader(); writer.writerows(ledger)
    for label,rows in [('all',ledger),('missed',[r for r in ledger if r['missed_review']]),('reviewed',[r for r in ledger if not r['missed_review']])]:
        print(label,len(rows),'enter',sum(r['action']=='enter' for r in rows),'filled',sum(r['status']=='modeled_fill' for r in rows),'notional',round(sum(r['notional_usd'] for r in rows),4),'horizon',round(sum(r['horizon_pnl_usd'] for r in rows),6),'bracket',round(sum(r['bracket_pnl_usd'] for r in rows),6))
    for r in ledger:
        if r['action']=='enter':print(r['alert_paris'],r['symbol'],r['side'],r['status'],r['missed_review'],round(r['notional_usd'],4),round(r['horizon_pnl_usd'],5),round(r['bracket_pnl_usd'],5),r['bracket_exit_reason'],r['execution_evidence'])
if __name__=='__main__':main()

