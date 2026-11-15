import type { Rule } from "./types";
export function describeRule(rule:Rule,intervalSeconds:number|null){
    const reference=rule.signal==="mean_reversion"?(rule.meanReference??"lookback_price"):null;
    const formula=rule.signal==="mean_reversion"?(reference==="prior_sma"?"10000 * (last closed price / arithmetic mean of preceding lookbackBars closes - 1); fade its sign":"10000 * (last closed price / close lookbackBars ago - 1); fade its sign")
        :rule.signal==="momentum"?"10000 * (last closed price / close lookbackBars ago - 1); follow its sign"
        :rule.signal==="breakout"?"Break beyond preceding lookbackBars closing-price range by thresholdBps"
        :rule.entryFilter?"1h/4h alignment plus "+(rule.entryFilter==="stacked"?"15m AND 5m resumption":rule.entryFilter==="setup_only"?"15m resumption":"5m resumption")
        :"Single-interval aligned pullback/resumption proxy; not the full live multi-timeframe sequence";
    return {name:rule.name,signal:rule.signal,meanReference:reference,entryFilter:rule.entryFilter??null,formula,thresholdBps:rule.thresholdBps,
        lookbackBars:rule.lookbackBars,lookbackTimeframe:rule.entryFilter?"lookbackBars applied independently to each timeframe":intervalSeconds===null?"not supplied in legacy artifact":intervalSeconds+" seconds",
        exits:"Fixed entry-relative stop/target or maximum hold. No moving-average target or exit is implied.",maxHoldHours:intervalSeconds===null?null:rule.maxHoldBars*intervalSeconds/3600,
        legacyReference:rule.signal==="mean_reversion"&&rule.meanReference===undefined,executionApproval:false};
}
/** 4.2 studies retain their original single-interval/return-fade semantics. */
export function compatibleForwardEngine(engine:string,rule:Rule,current:string){
    return engine===current||engine==="desk-research-4.2"&&!rule.entryFilter&&!rule.meanReference;
}
