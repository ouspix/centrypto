import { aggregateBars, swingFeatures, type SwingBar } from "./swing";
export type EntryFilter = "stacked" | "setup_only" | "entry_only";
type Features = ReturnType<typeof swingFeatures>;
/** The live sequence requires aligned 1h trend / 4h regime, not an extra 1h resumption. */
export function assessEntryFilters(hourly:Features,setup?:Features,entry?:Features,minTrendBps=0) {
    const observed=hourly.status==="observed"&&hourly.trendBps!=null&&hourly.regimeBps!=null;
    const direction=observed&&Math.abs(hourly.trendBps!)>=minTrendBps&&Math.sign(hourly.trendBps!)===Math.sign(hourly.regimeBps!)?Math.sign(hourly.trendBps!):0;
    const setupReady=!!direction&&setup?.status==="observed"&&setup.direction===direction;
    const entryReady=!!direction&&entry?.status==="observed"&&entry.direction===direction;
    return {direction,stacked:setupReady&&entryReady?direction:0,setup_only:setupReady?direction:0,entry_only:entryReady?direction:0,
        stage:!observed?"hourly_data":!direction?"alignment":!setupReady?"setup":!entryReady?"entry":"ready",
        blockers:!observed?["Fresh hourly trend/regime data"]:!direction?["Same-side hourly trend and four-hour regime"]:!setupReady?["15m closed-bar resumption"]:!entryReady?["5m closed-bar resumption"]:[],
        note:"Hourly resumption is not required. The latest closed 15m setup persists until the next 15m close; 5m entry is reassessed at each closed 5m bar. Alternatives are research filters, not live activation."};
}
function prefix(bars:SwingBar[],asOf:number,step:number,lookback:number){
    let lo=0,hi=bars.length;while(lo<hi){const mid=(lo+hi)>>>1;if(bars[mid].at+step<=asOf)lo=mid+1;else hi=mid;}
    return bars.slice(Math.max(0,lo-Math.max(lookback+2,Math.ceil(100*3600000/step))),lo);
}
/** Immutable dataset evaluator: aggregates once, consumes only bars closed by each decision. */
export function createEntryFilterEvaluator(input:SwingBar[],lookback=20){
    const bars=[...input].sort((a,b)=>a.at-b.at),end=(bars.at(-1)?.at??0)+300000;
    const hourly=aggregateBars(bars,3600000,300000,end),setup=aggregateBars(bars,900000,300000,end);
    const cache=new Map<string,Features>();
    function features(rows:SwingBar[],step:number,at:number){
        const closedAt=Math.floor(at/step)*step,key=step+":"+closedAt;
        let value=cache.get(key);if(value)return value;
        const tail=prefix(rows,closedAt,step,lookback);
        value=tail.at(-1)?.at!+step===closedAt?swingFeatures(tail,step,closedAt,lookback):{version:"continuation-1",status:"insufficient_history",direction:0,asOf:closedAt,reason:"No fresh closed bar at this boundary"};
        cache.set(key,value);return value;
    }
    return (asOf:number,minTrendBps=0)=>assessEntryFilters(features(hourly,3600000,asOf),features(setup,900000,asOf),features(bars,300000,asOf),minTrendBps);
}
