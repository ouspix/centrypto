import { createEntryFilterEvaluator } from "./entry-filters";
import { swingFeatures, type SwingBar } from "./swing";
import { ruleDirection } from "./backtest/request";
import type { Rule } from "./backtest/types";

/** One frozen rule interpretation for historical and prospective decisions. */
export function candleRuleDirection(rule:Rule,bars:SwingBar[],step:number,asOf:number) {
    if(rule.entryFilter){
        if(step!==300000||rule.signal!=="trend_pullback")return 0;
        let d=createEntryFilterEvaluator(bars,rule.lookbackBars)(asOf,rule.thresholdBps)[rule.entryFilter];
        if(rule.side==="long"&&d<0||rule.side==="short"&&d>0)d=0;return d;
    }
    const closed=bars.filter(b=>b.at+step<=asOf).sort((a,b)=>a.at-b.at);
    const required=Math.max(rule.lookbackBars+1,rule.signal==="trend_pullback"?80*3600000/step:2);
    const tail=closed.slice(-required);
    if(tail.length<required||tail.at(-1)!.at+step!==asOf||tail.some((b,i)=>i>0&&b.at-tail[i-1].at!==step))return 0;
    if(rule.signal!=="trend_pullback")return ruleDirection(rule,closed.map(b=>b.close));
    const f=swingFeatures(closed,step,asOf,rule.lookbackBars);
    let direction=f.status==="observed"&&Math.abs(f.trendBps??0)>=rule.thresholdBps?f.direction:0;
    if(rule.side==="long"&&direction<0||rule.side==="short"&&direction>0)direction=0;
    return direction;
}

/** Reuse immutable frame features across variants and chronological partitions. */
export function createCandleSignalEvaluator(bars:SwingBar[],step:number){
    const frames=new Map<number,ReturnType<typeof createEntryFilterEvaluator>>();
    return (rule:Rule,asOf:number)=>{
        if(rule.entryFilter){
            if(step!==300000||rule.signal!=="trend_pullback")return 0;
            let evaluate=frames.get(rule.lookbackBars);if(!evaluate){evaluate=createEntryFilterEvaluator(bars,rule.lookbackBars);frames.set(rule.lookbackBars,evaluate);}
            const d=evaluate(asOf,rule.thresholdBps)[rule.entryFilter];
            return rule.side==="long"&&d<0||rule.side==="short"&&d>0?0:d;
        }
        let lo=0,hi=bars.length;while(lo<hi){const mid=(lo+hi)>>>1;if(bars[mid].at+step<=asOf)lo=mid+1;else hi=mid;}
        return candleRuleDirection(rule,bars.slice(Math.max(0,lo-1200),lo),step,asOf);
    };
}
