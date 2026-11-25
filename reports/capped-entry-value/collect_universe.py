"""Run the public recorder across active native contracts and exact Binance overlaps."""
import asyncio
from public_archive import Archive, BAR, BINANCE, DEFAULT_DB, fetch, now, snapshot, stream


async def universe():
    native,contracts = await asyncio.gather(
        asyncio.to_thread(fetch,"https://api.hyperliquid.xyz/info",body={"type":"meta"}),
        asyncio.to_thread(fetch,BINANCE+"/fapi/v1/exchangeInfo"))
    symbols = sorted(a["name"] for a in native["universe"] if not a.get("isDelisted"))
    listed = {a["baseAsset"] for a in contracts["symbols"] if a["contractType"]=="PERPETUAL" and
              a["status"]=="TRADING" and a["symbol"]==a["baseAsset"]+"USDT"}
    return symbols,sorted(set(symbols)&listed)


async def periodic(store,overlap):
    while True:
        await snapshot(store,overlap)
        # fundingInfo contains exceptions to the default interval. Preserve its full response.
        for source,path in (("binance_funding_info","fundingInfo"),("binance_settlements","fundingRate")):
            try:
                rows = await asyncio.to_thread(fetch,BINANCE+"/fapi/v1/"+path,
                    {"limit":1000} if path=="fundingRate" else None)
                recv = now()
                for row in rows:
                    store.put(source,row["symbol"],int(row.get("fundingTime",recv)),recv,row)
            except (OSError,ValueError) as exc:
                store.health(source,str(exc)[:160])
        store.flush()
        await asyncio.sleep(max(5,(BAR-now()%BAR)/1000+5))


async def hourly_funding(store,symbols):
    while True:
        cutoff = now()
        for coin in symbols:
            try:
                rows = await asyncio.to_thread(fetch,"https://api.hyperliquid.xyz/info",body={
                    "type":"fundingHistory","coin":coin,"startTime":cutoff-2*3_600_000,"endTime":cutoff})
                recv = now()
                for row in rows:
                    store.put("hl_settled_rate",row["coin"],int(row["time"]),recv,row)
            except (OSError,ValueError) as exc:
                store.health("hl_settled_rate",str(exc)[:160])
            await asyncio.sleep(1.5)
        store.flush()
        await asyncio.sleep(max(10,(3_600_000-now()%3_600_000)/1000+10))


async def collect():
    store = Archive(DEFAULT_DB)
    try:
        while True:
            symbols,overlap = await universe()
            stamp = now()
            store.put("universe","mainnet",stamp,stamp,dict(native=symbols,binance=overlap))
            tasks = [asyncio.create_task(stream(store,"hyperliquid",symbols[i:i+45]))
                     for i in range(0,len(symbols),45)]
            tasks.extend([asyncio.create_task(stream(store,"bybit",["BTC","ETH","SOL"])),
                          asyncio.create_task(periodic(store,overlap)),asyncio.create_task(hourly_funding(store,symbols))])
            store.health("universe",f"{len(symbols)} native, {len(overlap)} Binance perpetuals")
            try:
                refreshed = stamp
                while True:
                    await asyncio.sleep(2)
                    store.flush()
                    for task in tasks:
                        if task.done():
                            task.result()
                            raise RuntimeError("Public feed task stopped")
                    if now()-refreshed>=3_600_000:
                        if await universe()!=(symbols,overlap):
                            break
                        refreshed = now()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
    finally:
        store.flush()
        store.db.close()


if __name__=="__main__":
    asyncio.run(collect())
