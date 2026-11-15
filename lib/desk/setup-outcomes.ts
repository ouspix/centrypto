import { observeProspectiveTests } from "./prospective";
import type { DeskBook, PrismaClient } from "@prisma/client";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import type { TradeProposal } from "./proposals";
import { candleHistoryCoverage } from "./candle-history";

const lastObservation = new Map<string,number>();
/** Prospective price observations, deliberately separate from modeled fills and account P&L. */
export async function observeSwingSetups(db:PrismaClient,book:DeskBook,now=Date.now()){
    await observeProspectiveTests(db,book,now);
    if(now-(lastObservation.get(book.id)??0)<60000)return;
    lastObservation.set(book.id,now);
    const market=book.isTestnet?marketDbTest:marketDbMain;
    const proposals=await db.deskRecord.findMany({where:{bookId:book.id,kind:"proposal_revision",key:{startsWith:`proposal:${book.version}:`}},orderBy:{createdAt:"desc"},take:40});
    for(const record of proposals){
        const p=JSON.parse(record.dataJson) as TradeProposal;
        if(!p.setup||Date.parse(p.updatedAt)<now-600000||p.legs.length!==1)continue;
        const leg=p.legs[0],coin=leg.instrumentId.split(":perp:")[1];if(!coin)continue;
        const key=`setup-observation:${book.version}:${p.key}:${p.revision}`;
        if(await db.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key}}}))continue;
        const tick=await market.marketTick.findFirst({where:{symbol:coin,ts:{gte:new Date(now-120000),lte:new Date(now)}},orderBy:{ts:"desc"}});
        if(!tick||!(tick.markPrice>0))continue;
        const value={proposalKey:p.key,revision:p.revision,strategyVersion:p.setup.strategyVersion,decision:p.status,setup:p.setup,instrumentId:leg.instrumentId,side:leg.side,observedAt:new Date(now).toISOString(),priceAt:tick.ts.toISOString(),referencePrice:tick.markPrice,deadline:new Date(now+p.setup.holdHours*3600000).toISOString(),status:"pending",scope:"prospective_price_response_not_trade_pnl"};
        await db.deskRecord.upsert({where:{bookId_key:{bookId:book.id,key}},create:{bookId:book.id,key,kind:"setup_observation",role:"host",dataJson:JSON.stringify(value)},update:{}});
    }
    const observations=await db.deskRecord.findMany({where:{bookId:book.id,kind:"setup_observation"},orderBy:{createdAt:"desc"},take:200});
    for(const row of observations){
        const o=JSON.parse(row.dataJson),deadline=Date.parse(o.deadline);
        if(o.status!=="pending"||deadline>now)continue;
        const start=Math.ceil(Date.parse(o.observedAt)/60000)*60000,end=Math.floor(deadline/60000)*60000;
        const rows=await market.marketCandle.findMany({where:{symbol:o.instrumentId.split(":perp:")[1],timeframe:"1m",openTime:{gte:new Date(start),lt:new Date(end)}},orderBy:{openTime:"asc"},take:2880});
        const bars=rows.map(r=>({at:+r.openTime,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume}));
        const coverage=candleHistoryCoverage(bars,start,end,60000),direction=o.side==="buy"?1:-1,last=bars.at(-1);
        const outcome={...o,status:"measured",measuredAt:new Date(now).toISOString(),coverage,priceReturnBps:coverage.complete&&last?(last.close/o.referencePrice-1)*direction*10000:null,
            maeBps:bars.length?Math.min(0,...bars.map(b=>((direction>0?b.low:b.high)/o.referencePrice-1)*direction*10000)):null,
            mfeBps:bars.length?Math.max(0,...bars.map(b=>((direction>0?b.high:b.low)/o.referencePrice-1)*direction*10000)):null,
            note:"Price-only outcome from actual first observation. No assumed entry, order fill or strategy P&L. Incomplete history leaves horizon return null; excursions then cover observed bars only."};
        await db.deskRecord.update({where:{id:row.id},data:{dataJson:JSON.stringify(outcome)}});
    }
}
