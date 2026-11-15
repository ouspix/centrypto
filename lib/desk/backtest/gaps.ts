import type { Dataset, PriceCandle, ResearchRequest } from "./types";

export const GAP_POLICY = {
  version:"causal-gap-1", maxCarryMs:60_000, candleExitParticipation:0.01,
  description:"Closed trade candles bridge missing prices, never entry depth. A single short missing price can carry the last observed midpoint for at most 60 seconds. Entries require real books; pending orders do not cross missing observations. Candle exits use adverse prices, last observed spread, explicit costs and at most 1% of observed minute volume. Synthetic candles are excluded."
} as const;
export type GapEvent = {at:number;instrumentId:string;missingSlot:boolean;price:number|null;observedAt:number|null;source:"closed_candle"|"carry_forward"|"unavailable";candle?:PriceCandle};
export function validPriceCandle(c:PriceCandle) {
  return ["archive_real_1m","collector_real_1m"].includes(c.source) && c.availableAt===c.openTime+60000 && c.openTime%60000===0 &&
    [c.openTime,c.availableAt,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.low>0 && c.volume>0 && c.low<=Math.min(c.open,c.close) && c.high>=Math.max(c.open,c.close);
}
export function replayGaps(dataset:Dataset,request:ResearchRequest,from:number,through:number) {
  const step=request.intervalSeconds*1000, events:GapEvent[]=[],missing=new Map<string,Set<number>>();
  const candles=(dataset.priceCandles??[]).filter(c=>validPriceCandle(c)&&c.openTime>=from&&c.availableAt<=through);
  let observed=0;
  for(const instrument of dataset.instruments) {
    const books=dataset.observations.filter(o=>o.instrumentId===instrument.id&&o.at>=from&&o.at<through).sort((a,b)=>a.at-b.at);
    const present=new Set(books.map(o=>Math.floor((o.at-from)/step)));
    observed+=present.size;
    const absent=new Set<number>();missing.set(instrument.id,absent);
    const byClose=new Map(candles.filter(c=>c.instrumentId===instrument.id).map(c=>[c.availableAt,c]));
    let prior=0;
    for(let at=from;at<through;at+=step) {
      if(present.has(Math.floor((at-from)/step)))continue;
      absent.add(at);
      while(prior+1<books.length&&books[prior+1].at<=at)prior++;
      const old=books[prior],candle=byClose.get(at);
      const carry=old&&old.at<at&&at-old.at<=Math.min(step*1.5,GAP_POLICY.maxCarryMs);
      const price=candle?.close??(carry?(+old.depth.levels[0][0].px + +old.depth.levels[1][0].px)/2:null);
      events.push({at,instrumentId:instrument.id,missingSlot:true,price,observedAt:candle?.availableAt??(carry?old.at:null),source:candle?"closed_candle":carry?"carry_forward":"unavailable",...(candle?{candle}:{})});
    }
    // The last missing minute closes when a real book returns. Process that
    // candle too, but only at its close, before using the returned book.
    for(const c of byClose.values()) {
      if(events.some(e=>e.instrumentId===instrument.id&&e.at===c.availableAt))continue;
      if([...absent].some(t=>t>=c.openTime&&t<c.availableAt))events.push({at:c.availableAt,instrumentId:instrument.id,missingSlot:false,price:c.close,observedAt:c.availableAt,source:"closed_candle",candle:c});
    }
    if(absent.has(through-step)&&!events.some(e=>e.instrumentId===instrument.id&&e.at===through))events.push({at:through,instrumentId:instrument.id,missingSlot:false,price:null,observedAt:null,source:"unavailable"});
  }
  return {events,missing,candles,observed,expected:Math.ceil((through-from)/step)*dataset.instruments.length};
}
export function intervalHasCandles(candles:PriceCandle[],id:string,from:number,through:number) {
  if(through<=from)return true;
  for(let at=Math.floor(from/60000)*60000;at<through;at+=60000)
    if(!candles.some(c=>c.instrumentId===id&&c.openTime===at))return false;
  return true;
}
