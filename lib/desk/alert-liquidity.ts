import type { DeskBook } from "@prisma/client";
import { prisma } from "@/lib/db";
import { newsExposure } from "./news-exposure";
import { instrument, publicQuote } from "./market";
import { parseDeskMandate } from "./mandate";
import { depthWithinBand, LIVE_ORDER_STATES } from "./execution-risk";

type Move = { instrumentId:string; mid:number; previous:number | undefined; move:number };
export function liquidAlert(quote: {bid:number;ask:number;bids:{px:string;sz:string}[];asks:{px:string;sz:string}[]}, maxSlippageBps:number, minDepthUsd:number) {
  const mid=(quote.bid+quote.ask)/2,band=maxSlippageBps/10000;
  const spreadBps=(quote.ask-quote.bid)/mid*10000;
  const bidDepth=depthWithinBand(quote.bids,false,mid*(1-band),1), askDepth=depthWithinBand(quote.asks,true,mid*(1+band),1);
  return {eligible:mid>0 && spreadBps>=0 && spreadBps<=2*maxSlippageBps && Math.min(bidDepth,askDepth)>=minDepthUsd,spreadBps,bidDepth,askDepth};
}
export async function filterMarketAlerts(book: DeskBook, moves:Move[], now:Date) {
  if(!moves.some(m=>m.instrumentId.includes(":spot:")))return {moves,suppressed:[]};
  const [exposure,intents,cache]=await Promise.all([
    newsExposure(book),prisma.deskIntent.findMany({where:{bookId:book.id,state:{in:[...LIVE_ORDER_STATES]}},select:{instrumentId:true}}),
    prisma.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key:"alert-liquidity-cache"}}})
  ]);
  // Never suppress exposure alerts when venue ownership is uncertain.
  if(exposure.coverage.needsReconciliation)return {moves,suppressed:[]};
  const held=new Set([...exposure.heldIds,...intents.map(i=>i.instrumentId)]);
  const cached:Record<string,{until:number;reason:string}>=cache?JSON.parse(cache.dataJson):{};
  const current=Object.fromEntries(Object.entries(cached).filter(([,v])=>v.until>+now));
  const mandate=parseDeskMandate(book.mandateJson), accepted:Move[]=[],suppressed:{instrumentId:string;reason:string}[]=[];
  let checked=0;
  for(const move of moves) {
    const id=move.instrumentId;
    if(!id.includes(":spot:") || held.has(id)){accepted.push(move);continue;}
    let reason=current[id]?.reason;
    if(!reason && checked>=6)reason="spot_quote_budget_deferred";
    if(!reason) {
      checked++;
      try {
        const asset=await instrument(book.isTestnet,id);
        // USD depth is only meaningful for USDC-quoted spot instruments.
        if(asset.quoteTokenIndex!==0) reason="non_usdc_spot_requires_separate_research";
        else {
          const quote=await publicQuote(asset,book.isTestnet,true);
          const observed=liquidAlert(quote,mandate.maxSlippageBps,mandate.minDepthUsd);
          if(!observed.eligible)reason="insufficient_two_sided_executable_depth";
        }
      } catch {reason="fresh_book_unavailable";}
      if(reason) current[id]={until:+now+30*60000,reason};
    }
    if(reason)suppressed.push({instrumentId:id,reason});else accepted.push(move);
  }
  await prisma.deskRecord.upsert({where:{bookId_key:{bookId:book.id,key:"alert-liquidity-cache"}},create:{bookId:book.id,key:"alert-liquidity-cache",kind:"alert_liquidity_cache",role:"market",dataJson:JSON.stringify(current)},update:{dataJson:JSON.stringify(current),createdAt:now}});
  return {moves:accepted.sort((a,b)=>Number(held.has(b.instrumentId))-Number(held.has(a.instrumentId)) || Number(b.instrumentId.includes(":perp:"))-Number(a.instrumentId.includes(":perp:")) || Math.abs(b.move)-Math.abs(a.move)),suppressed};
}
