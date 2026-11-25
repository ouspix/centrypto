"""Revalue the frozen ten-slot ledgers against receipt-timed Hyperliquid marks each minute."""
from collections import defaultdict

import joblib
import numpy as np
from decisions import CACHE,HERE,MINUTE,file_hash,iso,load,ms,save_json
from evidence import millis,query
from portfolio import portfolio


def capture(symbols,begin,end):
    names = ",".join("'"+s.replace("'","''")+"'" for s in sorted(symbols))
    # A tick first becomes usable on the first minute boundary after event AND receipt.
    sql = f"""WITH ticks AS (SELECT symbol,{millis('ts')} t,{millis('"receivedAt"')} received,
        "markPrice" price,id FROM "MarketTick" WHERE symbol IN ({names}) AND
        ts BETWEEN to_timestamp({begin-120000}/1000.0) AND to_timestamp({end}/1000.0)
        AND "receivedAt" IS NOT NULL AND "markPrice">0), g AS
        (SELECT *, ((greatest(t,received)+59999)/60000)*60000 AS grid FROM ticks)
        SELECT DISTINCT ON(symbol,grid) symbol,grid,t,price FROM g WHERE grid<={end}
        AND grid-t<=120000 ORDER BY symbol,grid,t DESC,received DESC,id DESC"""
    result = defaultdict(list)
    for r in query("MARKET_DATABASE_URL",sql):
        result[r["symbol"]].append((int(r["grid"]),int(r["t"]),float(r["price"])))
    return result


def report():
    core = load(HERE/"capped-objectives.json")
    forecasts = load(HERE/"benchmark-forecasts.json")
    history = joblib.load(CACHE/"benchmark.joblib")
    begin,end = map(ms,core["period"])
    ledgers = {arm:res["10"]["ledger"] for arm,res in core["modes"]["observed"]["arms"].items()}
    ledgers.update({arm:res["ledger"] for arm,res in forecasts["arms"]["observed"].items()})
    symbols = {r["symbol"] for rows in ledgers.values() for r in rows}|{"BTC","ETH"}
    dest = CACHE/"benchmark-venue-marks.joblib"
    if dest.exists():
        saved = joblib.load(dest)
        if saved["symbols"]!=symbols or saved["period"]!=core["period"]:
            raise ValueError("Frozen mark query changed")
    else:
        from decisions import dump
        saved = dict(ticks=capture(symbols,begin,end),symbols=symbols,period=core["period"])
        dump(dest,saved)
    markets = history["markets"].copy()
    masks = {}
    for symbol in symbols:
        key = "recent-"+symbol
        start, opens, rates = markets[key]
        marks = opens.copy()
        used = np.zeros(len(marks),bool)
        for grid,source,price in saved["ticks"].get(symbol,[]):
            j = (grid-start)//MINUTE
            # Hold backwards-looking ticks only through the two-minute age limit.
            last = min((source+120000-start)//MINUTE,len(marks)-1)
            if last>=j>=0:
                marks[j:last+1] = price
                used[j:last+1] = True
        markets[key] = start,marks,rates
        masks[key] = used
    result = {}
    for arm,rows in ledgers.items():
        venue,all_minutes = 0,0
        trades = []
        for r in rows:
            key = "recent-"+r["symbol"]
            trades.append(dict(r,key=key))
            start = markets[key][0]
            i,j = (r["entry"]-start)//MINUTE,(r["end"]-start)//MINUTE
            venue += int(masks[key][i:j].sum())
            all_minutes += j-i
        metrics,_,_ = portfolio(trades,markets,begin,end,10)
        metrics.update(venue_marked_position_minutes=venue,total_position_minutes=all_minutes)
        entry_stop = ms(history["window"]["test_entry_end"])
        interim,_,_ = portfolio(trades,markets,begin,entry_stop,10)
        for position in interim["end_inventory"]:
            r = next(r for r in trades if r["symbol"]==position["symbol"] and r["entry"]<=entry_stop<r["end"])
            st,marks,_ = markets[r["key"]]
            px = marks[(entry_stop-st)//MINUTE]
            sign = 1 if r["side"]=="long" else -1
            position.update(mark=float(px),marked_notional=float(r["qty"]*px),
                            unrealized_price_pnl=float(sign*r["qty"]*(px-r["paid"])))
        metrics["at_entry_cutoff"] = dict(at=iso(entry_stop),net_equity=interim["net"],inventory=interim["end_inventory"])
        result[arm] = metrics
    save_json(HERE/"venue-marked-equity.json",dict(period=core["period"],asof_ttl_ms=120000,
        source_sha256=file_hash(dest),fallback="minute-open proxy",arms=result))
    print({k:(v["net"],v["full_drawdown"],v["venue_marked_position_minutes"]) for k,v in result.items()})


if __name__=="__main__":
    report()
