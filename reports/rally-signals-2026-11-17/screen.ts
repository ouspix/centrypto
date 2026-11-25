import fs from "node:fs";
import path from "node:path";
import { aggregateBars, type SwingBar } from "../../lib/desk/swing";
import { instrumentFeatures, type MarketFeatureRow } from "../../lib/desk/market-features";
import { parseScreenQuery, rankScreen } from "../../lib/desk/market-screen";
import { discoverMarket, type DiscoveryTick } from "../../lib/desk/discovery";
import type { DeskInstrument } from "../../lib/desk/instruments";

const folder = path.resolve("data/research/centrypto/rally-signals-2026-11-17");
const source = JSON.parse(fs.readFileSync(path.join(folder,"screen-input.json"),"utf8"));
const minute = 60000;
const query = parseScreenQuery({});
const symbols: string[] = source.symbols;
const histories = new Map<string,SwingBar[]>();
const ticks = new Map<string,Map<number,DiscoveryTick>>();
const items = symbols.map(symbol => ({id:"mainnet:perp:"+symbol,coin:symbol})) as DeskInstrument[];
for (const symbol of symbols) {
    histories.set(symbol,source.bars[symbol]);
    ticks.set(symbol,new Map(source.ticks[symbol].map((r: DiscoveryTick & {step:number}) => [
        source.archiveStart+(r.step+1)*5*minute+5000,{...r,ts:new Date(r.ts),symbol}
    ])));
}
const alerts: {symbol:string;side:string;at:number;view:string}[]=[];
const attention: {symbol:string;at:number}[]=[];
const coverage: unknown[]=[];
for(let at=source.start+5000; at<source.end; at+=15*minute){
    const latest=(time:number)=>symbols.flatMap(symbol=>{
        const tick=ticks.get(symbol)!.get(time);
        return tick && +tick.ts>0 ? [tick] : [];
    });
    const current=latest(at), past=latest(at-60*minute), four=latest(at-240*minute);
    const scan=discoverMarket(items,current,past,four,[],[],at);
    attention.push(...scan.shortlist.map(row=>({symbol:row.symbol,at})));
    const instruments: MarketFeatureRow[]=scan.coverage.map(row=>{
        const bars=histories.get(row.symbol)!;
        let end=0;
        while(end<bars.length && bars[end].at+15*minute<=at)end++;
        // Runtime feature cache keeps seven days of native candles.
        const history=bars.slice(0,end).filter(bar=>bar.at>=at-7*24*60*minute);
        const feature=instrumentFeatures(history,at);
        const observed=row.status==="observed"?row:null;
        return {...feature,instrumentId:row.instrumentId,symbol:row.symbol,observedAt:observed?.observedAt??null,
            price:observed?.price??null,volume24h:observed?.volume24h??null,fundingHourly:observed?.fundingHourly??null,
            fundingPercentile:null,fundingSamples:0,openInterestBase:observed?.openInterestBase??null,
            openInterestUsd:observed?.openInterestBase!=null?observed.openInterestBase*observed.price:null,
            oiChange1hPct:observed?.oiChange1hPct??null,basisBps:null,spreadBps:null};
    });
    const result=rankScreen({version:1,id:"historical",network:"mainnet",asOf:at,durationMs:0,instruments,candleError:null},query,[],at);
    alerts.push(...result.candidates.slice(0,query.limit).filter(r=>r.direction).map(r=>({
        symbol:r.symbol,side:r.direction!,at,view:r.view
    })));
    coverage.push({at,...result.coverage});
}
fs.writeFileSync(path.join(folder,"screen.json"),JSON.stringify({alerts,attention,coverage}));
console.log("Screen candidates",alerts.length,"discovery attention",attention.length);
