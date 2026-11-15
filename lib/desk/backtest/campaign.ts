import { createHash } from "node:crypto";
import { replayDesk, runDeskResearch } from "./engine";
import type { Dataset, ReplayResult, ResearchContext, ResearchRequest, ReplayQuality } from "./types";

export function researchWindows(request: ResearchRequest) {
  const { additionalWindows = [], ...base } = request;
  return [{ start: base.start, end: base.end }, ...additionalWindows].map(w => ({ ...base, ...w }));
}
function aggregate(parts: ReplayResult[]): ReplayResult {
  const first = parts[0], capital = first.metrics.initialCapitalUsd;
  const sum = (key: keyof ReplayResult["metrics"]) => parts.reduce((n,p) => n+p.metrics[key],0);
  const pnl = sum("netPnlUsd");
  const qualities=parts.map(p=>p.dataQuality);
  const qsum=(key:keyof ReplayQuality)=>qualities.reduce((n,q)=>n+(typeof q?.[key]==="number"?q[key] as number:0),0);
  const dataQuality:ReplayQuality|undefined=qualities.every(Boolean)?{
    policy:"causal-gap-1",mode:qualities[0]!.mode,expectedBooks:qsum("expectedBooks"),observedBooks:qsum("observedBooks"),missingBooks:qsum("missingBooks"),
    candlePriceSteps:qsum("candlePriceSteps"),carriedPriceSteps:qsum("carriedPriceSteps"),unpricedSteps:qsum("unpricedSteps"),exposedGapIntervals:qsum("exposedGapIntervals"),unresolvedExposureIntervals:qsum("unresolvedExposureIntervals"),modeledExitFills:qsum("modeledExitFills"),modelDependentClosedTrades:qsum("modelDependentClosedTrades"),missingFundingWhileExposed:qsum("missingFundingWhileExposed"),usableForSelection:qualities.every(q=>q?.usableForSelection===true)}:undefined;
  return {
    dataQuality,
    from: first.from, through: parts.at(-1)!.through,
    metrics: { initialCapitalUsd: capital, equityUsd: capital + pnl,
      netPnlUsd: pnl, returnPct: pnl / capital * 100,
      maxDrawdownPct: Math.max(...parts.map(p=>p.metrics.maxDrawdownPct)),
      realizedPnlUsd: sum("realizedPnlUsd"), unrealizedPnlUsd: sum("unrealizedPnlUsd"),
      feesUsd: sum("feesUsd"), fundingUsd: sum("fundingUsd"), fills: sum("fills"), closedTrades: sum("closedTrades"),
      rejectedOrders: sum("rejectedOrders"), unfilledOrders: sum("unfilledOrders") },
    endingPositions: parts.flatMap(p=>p.endingPositions), fills: parts.flatMap(p=>p.fills),
    rejections: parts.flatMap(p=>p.rejections), equity: [],
    limitations: [...new Set(parts.flatMap(p=>p.limitations)), "Independent windows each use the same fixed capital; cumulative P&L is normalized by that single capital allocation. No capital is multiplied by window count. This is a fixed-stake sum, not a self-financing compounded equity curve; drawdown is the worst individual window."]
  };
}
const complete = (p: ReplayResult) => p.dataQuality?.usableForSelection === true;
export function runResearchCampaign(datasets: Dataset[], context: ResearchContext, request: ResearchRequest) {
  const requests = researchWindows(request);
  if (datasets.length !== requests.length || datasets.length < 3) throw new Error("Campaign dataset count mismatch.");
  // Never evaluate per-window winners against holdout. Select once using pooled
  // validation; evaluate only that fixed candidate across all holdout partitions.
  const windows = datasets.map((d,i)=>runDeskResearch(d,context,requests[i],false));
  const variants = windows[0].variants.map((v,index)=>({
    name:v.name, rule:v.rule,
    development:aggregate(windows.map(w=>w.variants[index].development)),
    validation:aggregate(windows.map(w=>w.variants[index].validation)),
    validationObservedOnly:aggregate(windows.map(w=>w.variants[index].validationObservedOnly)),
    usableValidationWindows: windows.filter(w=>complete(w.variants[index].validation)).length
  }));
  const winner = variants.filter(v=>v.usableValidationWindows === windows.length && v.validation.metrics.closedTrades > 0)
    .sort((a,b)=>Math.min(b.validation.metrics.netPnlUsd,b.validationObservedOnly.metrics.netPnlUsd)-Math.min(a.validation.metrics.netPnlUsd,a.validationObservedOnly.metrics.netPnlUsd))[0];
  const holdouts = winner ? datasets.map((d,i)=>{
    const req=requests[i], start=Date.parse(req.start),end=Date.parse(req.end),step=req.intervalSeconds*1000;
    return replayDesk(d,context,req,start+Math.floor((end-start)*0.8/step)*step,end,winner.rule);
  }) : [];
  const holdout = holdouts.length ? aggregate(holdouts) : null;
  const referenceHoldouts=winner?datasets.map((d,i)=>{
    const req=requests[i],start=Date.parse(req.start),end=Date.parse(req.end),step=req.intervalSeconds*1000;
    return replayDesk(d,context,req,start+Math.floor((end-start)*0.8/step)*step,end,winner.rule,"observed_only");
  }):[];
  const holdoutObservedOnly=referenceHoldouts.length?aggregate(referenceHoldouts):null;
  const validationTrades = winner?.validation.metrics.closedTrades ?? Math.max(0,...variants.map(v=>v.validation.metrics.closedTrades));
  const unresolved=winner ? !winner.validation.dataQuality?.usableForSelection || !!holdout&&!holdout.dataQuality?.usableForSelection
    : variants.some(v=>!v.validation.dataQuality?.usableForSelection);
  const dependentValidation=winner?.validation.dataQuality?.modelDependentClosedTrades??0;
  const dependentHoldout=holdout?.dataQuality?.modelDependentClosedTrades??0;
  const assessment = {
    status: unresolved ? "unresolved_exposure" : validationTrades < 20 || !holdout || holdout.metrics.closedTrades < 10 ? "insufficient_sample"
      : validationTrades-dependentValidation<20 || holdout.metrics.closedTrades-dependentHoldout<10 ? "model_dependent_sample"
      : Math.sign(holdout.metrics.netPnlUsd)!==Math.sign(holdoutObservedOnly?.metrics.netPnlUsd??0) ? "gap_model_sensitive"
      : holdout.metrics.netPnlUsd <= 0 ? "non_positive_holdout" : "evidence_for_review",
    modelDependentValidationTrades:dependentValidation,modelDependentHoldoutTrades:dependentHoldout,
    gapSensitivityUsd:holdout&&holdoutObservedOnly?holdout.metrics.netPnlUsd-holdoutObservedOnly.metrics.netPnlUsd:null,
    selection:"Fixed causal gap policy; rank on the lower pooled validation P&L of conservative gap replay and observed-book-only reference. Holdout is never used to choose the policy or candidate.",
    windowCount: windows.length, validationClosedTrades: validationTrades, holdoutClosedTrades:holdout?.metrics.closedTrades ?? 0,
    note: "20 validation / 10 holdout closed trades are descriptive sample flags, not statistical significance or trading approval. Report each window, costs, coverage and rejection causes. Missing evidence does not establish negative edge."
  };
  return { ...windows[0], scope:"multi_window_desk_rules", proposalKey:request.proposalKey ?? null,
    dataHash:createHash("sha256").update(windows.map(w=>w.dataHash).join(":")).digest("hex"),
    coverage:{ windows:windows.map((w,i)=>({start:requests[i].start,end:requests[i].end,...w.coverage})) },
    variants, selectedVariant:winner?.name ?? null, holdout, holdoutObservedOnly, replay:null, assessment,
    windows:windows.map((w,i)=>({start:requests[i].start,end:requests[i].end,dataHash:w.dataHash,variants:w.variants,holdout:holdouts[i]??null,holdoutObservedOnly:referenceHoldouts[i]??null})),
    limitations:[...windows[0].limitations,"Dates and parameters fixed at submission. One candidate selected on pooled validation; holdouts never select windows or parameters."]
  };
}
