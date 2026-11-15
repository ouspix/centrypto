type Partition = {metrics:{netPnlUsd:number;closedTrades:number;netExpectancyUsd?:number|null;standardErrorDescriptiveUsd?:number|null};dataQuality:{usableForSelection:boolean}};
/** Economics and uncertainty are separate axes. Sample counts are descriptive,
 * never a significance test, investment approval, or a reason to retune a holdout. */
export function assessCandleEvidence(input:{coverage:boolean;validation?:Partition|null;holdout?:Partition|null;stress?:Partition|null;folds?:Partition[]}) {
    const {validation:v,holdout:h,stress:s}=input,folds=input.folds??[];
    const quality=!!v?.dataQuality.usableForSelection&&!!h?.dataQuality.usableForSelection&&!!s?.dataQuality.usableForSelection;
    const economics=!quality?"unresolved":!v!.metrics.closedTrades||!h!.metrics.closedTrades?"unobserved"
        :v!.metrics.netPnlUsd<=0&&h!.metrics.netPnlUsd<=0?"adverse"
        :v!.metrics.netPnlUsd<=0||h!.metrics.netPnlUsd<=0?"mixed"
        :s!.metrics.netPnlUsd<=0?"cost_sensitive":"positive_after_stress";
    const active=folds.filter(f=>f.metrics.closedTrades>0),losing=active.filter(f=>f.metrics.netPnlUsd<0);
    const n=v?.metrics.closedTrades??0,m=h?.metrics.closedTrades??0;
    const limitations:string[]=[];
    if(!input.coverage)limitations.push("Historical coverage is incomplete. Unexposed missing bars may omit opportunities; assess only observed history, without treating omitted signals as negative returns.");
    if(n<20||m<10)limitations.push("Limited trade count; 20 validation / 10 holdout are descriptive reference counts, not a pass/fail test or statistical confidence level.");
    if(folds.length<3)limitations.push("Fewer than three validation folds fit the holding horizon; temporal support is limited.");
    if(active.length<folds.length)limitations.push("Outcomes are concentrated in only part of the validation period.");
    if(losing.length)limitations.push("At least one active validation fold lost money after modeled costs.");
    limitations.push("Trades across assets or adjacent periods may be correlated. No IID confidence interval or guaranteed future expectancy is claimed.");
    const reliability=!quality?"data_limited":!n||!m?"unmeasured":!input.coverage?"coverage_limited":n<20||m<10||folds.length<3||active.length<folds.length?"preliminary":losing.length?"regime_sensitive":"broader_observed_support";
    return {version:"evidence-2",status:!quality?"data_incomplete":economics==="adverse"?"hypothesis_challenged":economics==="mixed"||economics==="cost_sensitive"?"fragile_economics":economics==="unobserved"?"no_outcome_evidence":"promising_for_review",
        economics,reliability,validationClosedTrades:n,holdoutClosedTrades:m,
        temporalSupport:{activeFolds:active.length,totalFolds:folds.length,losingFolds:losing.length},
        nextAction:!quality?"Resolve the specific exposed data gap before interpreting performance."
            :economics==="adverse"?"Preserve the failed result; test a distinct, predeclared mechanism only if its rationale survives."
            :economics==="mixed"||economics==="cost_sensitive"?"Identify the failure regime or cost dependency; do not rescue the hypothesis by tuning its observed holdout."
            :"Register the frozen rule for prospective observation, or predeclare a new time/asset test. Evaluate current entry eligibility separately; a missing entry today does not disprove the hypothesis.",
        limitations,executionApproval:false,note:"Research evidence only. Positive sparse results are preliminary; negative results remain visible regardless of sample size. Existing live strategy and risk controls are unchanged."};
}
