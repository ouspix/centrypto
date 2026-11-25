"""Collect timestamped public research feeds. No wallet or trading credentials."""
import argparse
import asyncio
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import zlib

from websockets.asyncio.client import connect

DEFAULT_DB = Path(__file__).resolve().parents[2]/"data/research/centrypto/capped-entry-value/public.sqlite3"
BINANCE = "https://fapi.binance.com"
BAR = 300_000
now = lambda: time.time_ns()//1_000_000


def fetch(url, params=None, body=None):
    if params:
        url += "?" + urlencode(params)
    req = Request(url, data=json.dumps(body).encode() if body else None, headers={"Content-Type":"application/json"})
    with urlopen(req,timeout=12) as response:
        return json.load(response)


class Archive:
    def __init__(self,path):
        path.parent.mkdir(parents=True,exist_ok=True)
        self.db = sqlite3.connect(path,timeout=10)
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS observation(source TEXT, symbol TEXT, event_ms INTEGER,
                received_ms INTEGER, fingerprint BLOB, payload BLOB,
                PRIMARY KEY(source,symbol,event_ms,fingerprint)) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS available ON observation(source,symbol,received_ms);
            CREATE TABLE IF NOT EXISTS health(at INTEGER, source TEXT, state TEXT);
        """)
        self.pending = []

    def put(self,source,symbol,event,received,payload):
        if not isinstance(event,int) or event<=0 or event>received+60000:
            raise ValueError("Invalid event timestamp")
        raw = json.dumps(payload,ensure_ascii=False,separators=(",",":"),sort_keys=True).encode()
        self.pending.append((source,symbol,event,received,hashlib.sha256(raw).digest(),zlib.compress(raw,1)))
        if len(self.pending)>=500:
            self.flush()

    def flush(self):
        with self.db:
            self.db.executemany("INSERT OR IGNORE INTO observation VALUES(?,?,?,?,?,?)", self.pending)
        self.pending.clear()

    def health(self,source,state):
        self.db.execute("INSERT INTO health VALUES(?,?,?)",(now(),source,state))
        self.flush()


async def stream(store,venue,symbols):
    native = venue=="hyperliquid"
    url = "wss://api.hyperliquid.xyz/ws" if native else "wss://stream.bybit.com/v5/public/linear"
    backoff = 1
    while True:
        try:
            async with connect(url,open_timeout=15,ping_interval=20,max_size=4*1024**2) as ws:
                if native:
                    for s in symbols:
                        for kind in ("l2Book","trades"):
                            await ws.send(json.dumps(dict(method="subscribe",subscription=dict(type=kind,coin=s))))
                            await asyncio.sleep(.06)
                else:
                    await ws.send(json.dumps(dict(op="subscribe",args=["allLiquidation."+s+"USDT" for s in symbols])))
                store.health(venue,"connected")
                backoff = 1
                while True:
                    try:
                        raw = await asyncio.wait_for(ws.recv(),timeout=25)
                    except asyncio.TimeoutError:
                        await ws.send(json.dumps({"method":"ping"} if native else {"op":"ping"}))
                        continue
                    msg = json.loads(raw)
                    recv = now()
                    data = msg.get("data")
                    if msg.get("channel")=="error" or msg.get("success") is False:
                        raise ValueError(str(msg)[:200])
                    if native and msg.get("channel")=="l2Book":
                        store.put("hl_l2",data["coin"],data["time"],recv,data["levels"])
                    elif native and msg.get("channel")=="trades":
                        for trade in data:
                            store.put("hl_trade",trade["coin"],trade["time"],recv,trade)
                    elif not native and msg.get("topic","").startswith("allLiquidation."):
                        # Keep the whole frame to preserve distinct identical liquidations within a push.
                        store.put("bybit_liquidations",msg["topic"].split(".",1)[1],msg["ts"],recv,data)
        except (OSError,TimeoutError,ValueError,RuntimeError) as exc:
            store.health(venue,type(exc).__name__+": "+str(exc)[:140])
        except Exception as exc:
            from websockets.exceptions import WebSocketException
            if not isinstance(exc,WebSocketException):
                raise
            store.health(venue,type(exc).__name__)
        await asyncio.sleep(backoff)
        backoff = min(backoff*2,60)


async def snapshot(store,symbols):
    async def request(source,url,params=None,body=None):
        try:
            return await asyncio.to_thread(fetch,url,params,body)
        except (OSError,ValueError) as exc:
            store.health(source,type(exc).__name__+": "+str(exc)[:140])
            return None

    info = await request("hl_context","https://api.hyperliquid.xyz/info",body={"type":"metaAndAssetCtxs"})
    recv = now()
    if info:
        for asset,ctx in zip(info[0]["universe"],info[1],strict=True):
            if not asset.get("isDelisted"):
                # No venue event timestamp is supplied. Index this observation by receipt.
                store.put("hl_context",asset["name"],recv,recv,ctx)
    premium = await request("binance_premium",BINANCE+"/fapi/v1/premiumIndex")
    recv = now()
    for obj in premium or []:
        store.put("binance_premium",obj["symbol"],obj["time"],recv,obj)
    for source,path,offset in (("binance_oi","openInterestHist",0),("binance_taker","takerlongshortRatio",BAR)):
        for symbol in symbols:
            pair = symbol+"USDT"
            page = await request(source,BINANCE+"/futures/data/"+path,dict(symbol=pair,period="5m",limit=3))
            recv = now()
            for row in page or []:
                end = int(row["timestamp"])+offset
                if end<=recv:
                    store.put(source,pair,end,recv,row)
            await asyncio.sleep(.15)
    for symbol in ("BTC","ETH"):
        end = now()
        page = await request("deribit_dvol","https://www.deribit.com/api/v2/public/get_volatility_index_data",
            dict(currency=symbol,start_timestamp=end-180000,end_timestamp=end,resolution="60"))
        recv = now()
        for bar in (page or {}).get("result",{}).get("data",[]):
            if bar[0]+60_000<=recv:
                store.put("deribit_dvol",symbol,bar[0]+60_000,recv,bar)
    store.flush()


async def run(args):
    store = Archive(args.db)
    native = args.symbols.split(",")
    pairs = args.cross_venue.split(",")
    async def polling():
        while True:
            await snapshot(store,pairs)
            await asyncio.sleep(max(5,(BAR-now()%BAR)/1000+5))
    async def flush():
        while True:
            await asyncio.sleep(2)
            store.flush()
    tasks = [asyncio.create_task(c) for c in (stream(store,"hyperliquid",native),
             stream(store,"bybit",pairs),polling(),flush())]
    try:
        done,_ = await asyncio.wait(tasks,timeout=args.seconds,return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        store.flush()
        store.db.close()


if __name__=="__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db",type=Path,default=DEFAULT_DB)
    p.add_argument("--symbols",default="BTC,ETH",help="Hyperliquid coins for trades and L2")
    p.add_argument("--cross-venue",default="BTC,ETH",help="Verified overlapping base symbols, USDT linear contracts")
    p.add_argument("--seconds",type=int,help="Stop after this many seconds. Default is continuous.")
    asyncio.run(run(p.parse_args()))
