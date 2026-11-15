import type { ScreenView } from "./market-screen";
import type { DeskInstrument } from "./instruments";
export type DiscoverySetup = { view: ScreenView; side: "long" | "short" | null; boundary: number | null;
    beyond: boolean | null; displacement: number | null; eventKey?: string };
export type DiscoveryTick = {symbol:string;ts:Date;markPrice:number;volume24h:number|null;fundingRate:number|null;openInterest:number|null;indexPrice?:number|null;bookBidPx?:number|null;bookAskPx?:number|null};
/** Full native-market coverage. Liquidity gates affect execution later, not discovery membership. */
export function discoverMarket(items:DeskInstrument[],ticks:DiscoveryTick[],pastHour:DiscoveryTick[],pastFourHours:DiscoveryTick[],pinned:string[],nominated:string[],now=Date.now()) {
    const latest=new Map(ticks.map(t=>[t.symbol,t])),hour=new Map(pastHour.map(t=>[t.symbol,t])),four=new Map(pastFourHours.map(t=>[t.symbol,t]));
    const change=(price:number,old?:number|null)=>Number.isFinite(price)&&old&&Number.isFinite(old)&&old>0?(price/old-1)*10000:null;
    const fresh = (tick: DiscoveryTick | undefined): tick is DiscoveryTick => !!tick &&
        +tick.ts >= now - 120000 && +tick.ts <= now + 1000 && Number.isFinite(tick.markPrice) && tick.markPrice > 0;
    const btc=latest.get("BTC"),eth=latest.get("ETH");
    const btcChange=fresh(btc)?change(btc.markPrice,hour.get("BTC")?.markPrice):null,ethChange=fresh(eth)?change(eth.markPrice,hour.get("ETH")?.markPrice):null;
    const coverage=items.map(i=>{
        const t=latest.get(i.coin);
        if(!fresh(t))return {instrumentId:i.id,symbol:i.coin,status:"unavailable" as const,reason:"No fresh collector price",score:0};
        const h=hour.get(i.coin),f=four.get(i.coin),return1hBps=change(t.markPrice,h?.markPrice),return4hBps=change(t.markPrice,f?.markPrice),oiChange1hPct=t.openInterest!==null?change(t.openInterest,h?.openInterest):null;
        const relativeBtcBps=return1hBps!==null&&btcChange!==null?return1hBps-btcChange:null,relativeEthBps=return1hBps!==null&&ethChange!==null?return1hBps-ethChange:null;
        // A research priority, not a direction, calibrated probability or expected return.
        const score=Math.abs(return1hBps??0)+Math.abs(return4hBps??0)*0.25+Math.abs(relativeBtcBps??0)*0.25;
        return {instrumentId:i.id,symbol:i.coin,status:"observed" as const,reason:"Included in full-universe assessment",score,observedAt:+t.ts,price:t.markPrice,volume24h:t.volume24h,fundingHourly:t.fundingRate,return1hBps,return4hBps,relativeBtcBps,relativeEthBps,oiChange1hPct:oiChange1hPct===null?null:oiChange1hPct/100,
            openInterestBase:t.openInterest,indexPrice:t.indexPrice??null,bookBidPx:t.bookBidPx??null,bookAskPx:t.bookAskPx??null,
            setup: null as DiscoverySetup | null, pinned:pinned.includes(i.id),nominated:nominated.includes(i.id)};
    });
    const ranked=coverage.filter(r=>r.status==="observed").sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));
    // These are cheap research nominations, not closed-bar signal confirmations.
    const lanes = [
        {family:"trend_pullback",question:"Does a retracement within a larger move resume? Test long and short expressions.",rows:ranked.filter(r=>r.return1hBps!=null&&r.return4hBps!=null&&Math.sign(r.return1hBps)!==Math.sign(r.return4hBps))},
        {family:"breakout",question:"Does aligned expansion continue after a breakout, or exhaust?",rows:ranked.filter(r=>r.return1hBps!=null&&r.return4hBps!=null&&Math.sign(r.return1hBps)===Math.sign(r.return4hBps)&&r.return1hBps!==0)},
        {family:"mean_reversion",question:"Is a large dislocation reversible after costs? Identify the regime that would falsify a fade.",rows:ranked},
    ].map(l=>({family:l.family,question:l.question,candidates:l.rows.slice(0,2).map(r=>({instrumentId:r.instrumentId,symbol:r.symbol,return1hBps:r.return1hBps,return4hBps:r.return4hBps}))}));
    const selected=new Map<string,typeof ranked[number]>();
    for(const r of ranked.filter(r=>r.pinned||r.nominated))selected.set(r.instrumentId,r);
    for(const lane of lanes)for(const c of lane.candidates){const r=ranked.find(r=>r.instrumentId===c.instrumentId)!;selected.set(r.instrumentId,r);}
    const priorityIds = [...new Set([...ranked.slice(0,5).map(r=>r.instrumentId), ...lanes.flatMap(l=>l.candidates.map(c=>c.instrumentId))])];
    for(const r of ranked.slice(0,5))selected.set(r.instrumentId,r);
    const rotation=ranked.filter(r=>!selected.has(r.instrumentId)).sort((a,b)=>a.symbol.localeCompare(b.symbol));
    const offset=rotation.length?Math.floor(now/600000)*5%rotation.length:0;
    const rotationIds: string[] = [];
    for(let n=0;n<Math.min(5,rotation.length);n++){const r=rotation[(offset+n)%rotation.length];selected.set(r.instrumentId,r);rotationIds.push(r.instrumentId);}
    return {featureVersion: 0, snapshotId: null as string | null, asOf:new Date(now).toISOString(),eligible:items.length,scanned:ranked.length,unavailable:coverage.filter(r=>r.status==="unavailable").length,coverage,shortlist:[...selected.values()],researchLanes:lanes,priorityIds,rotationIds,
        policy:"Every active native perp assessed; family-specific research nominations plus rotating coverage, held/working instruments and catalyst nominations. No top-volume cutoff. Shortlist is research priority, not order permission."};
}
