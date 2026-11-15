import { GAP_POLICY, replayGaps, intervalHasCandles } from "./gaps";
import { createHash } from "node:crypto";
import { venueLimitPrice } from "../venue-price";
import {
  assessDeskOrder,
  inspectBook,
  inventoryAfter,
  parseDeskOrder,
} from "../execution-risk";
import {
  positionKey,
  type DeskAccount,
  type DeskOrder,
} from "../execution-types";
import { ruleDirection } from "./request";
import {
  ENGINE_VERSION,
  type Dataset,
  type Observation,
  type ResearchContext,
  type ResearchRequest,
  type ReplayResult,
  type Rule,
  type Fill,
} from "./types";

type Position = {
  quantity: number;
  basis: number;
  stop?: number;
  target?: number;
  openedAt: number;
  gapAffected?: boolean;
  pendingGapExit?: string;
};
type Pending = { at: number; order: DeskOrder };
export function replayDesk(
  dataset: Dataset,
  context: ResearchContext,
  request: ResearchRequest,
  from: number,
  through: number,
  rule?: Rule,
  gapMode: "conservative" | "observed_only" = "conservative",
): ReplayResult {
  const step = request.intervalSeconds * 1000,
    positions = new Map<string, Position>(),
    marks = new Map<string, { price: number; at: number }>();
  const history = new Map<string, number[]>(),
    previousAt = new Map<string, number>(),
    cooldown = new Map<string, number>();
  const gaps=replayGaps(dataset,request,from,through);
  const signalBucket=new Map<string,number>();
  const exposureIntervals:Array<{id:string;from:number;through:number}>=[];
  let candleSteps=0,carriedSteps=0,unpricedSteps=0,modeledExits=0,modelClosed=0,missingFundingExposed=0;
  const latest = new Map<string, Observation>(),
    pending: Pending[] = [];
  const fills: Fill[] = [],
    rejections: ReplayResult["rejections"] = [],
    equity: ReplayResult["equity"] = [];
  const limitations = new Set(dataset.coverage.limitations);
  let cash = context.mandate.capitalUsd,
    realized = 0,
    fees = 0,
    funding = 0,
    closed = 0,
    unfilled = 0;
  let peak = cash,
    drawdown = 0;
  const daily = new Map<string, number>();
  const owned = (id: string) => positions.get(id)?.quantity ?? 0;
  const unrealized = () =>
    [...positions].reduce(
      (n, [id, p]) =>
        n + p.quantity * ((marks.get(id)?.price ?? p.basis) - p.basis),
      0,
    );
  const gross = () =>
    [...positions].reduce(
      (n, [id, p]) =>
        n + Math.abs(p.quantity) * (marks.get(id)?.price ?? p.basis),
      0,
    );
  const pnl = (at: number, delta: number) => {
    const day = new Date(at).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + delta);
  };
  const account = (): DeskAccount => ({
    positions: new Map(
      dataset.instruments.map((i) => [positionKey(i), owned(i.id)]),
    ),
    freeSpot: new Map(),
    tokenUsd: new Map([[0, 1]]),
    marks: new Map([...marks].map(([id, m]) => [id, m.price])),
    openOrders: [],
    equity: cash + unrealized(),
    grossUsd: gross(),
    rollingPnl: [...daily.values()].at(-1) ?? 0,
  });
  const appendPrice = (id:string,at:number,price:number) => {
    const bucket=Math.floor((at-from)/step), previous=signalBucket.get(id);
    const prices=previous===bucket || previous===bucket-1 ? (history.get(id)??[]) : [];
    if(previous===bucket && prices.length) prices[prices.length-1]=price;
    else prices.push(price);
    if(prices.length>361)prices.shift();
    history.set(id,prices);signalBucket.set(id,bucket);
    return prices;
  };
  const applyFill = (id:string,at:number,buy:boolean,size:number,price:number,reason:string,
    stop:number|undefined,target:number|undefined,modeled=false) => {
    const fee=size*price*request.feeBpsPerSide/10000,old=positions.get(id);
    const state=inventoryAfter(old?.quantity??0,old?.basis??0,(buy?1:-1)*size,price);
    realized+=state.pnl;fees+=fee;cash+=state.pnl-fee;pnl(at,state.pnl-fee);
    if(!state.quantity){positions.delete(id);closed++;if(old?.gapAffected||modeled)modelClosed++;cooldown.set(id,at);}
    else positions.set(id,{...state,stop:stop??old?.stop,target:target??old?.target,openedAt:old?.openedAt??at,gapAffected:old?.gapAffected||modeled,pendingGapExit:old?.pendingGapExit});
    if(modeled)modeledExits++;
    fills.push({at:new Date(at).toISOString(),instrumentId:id,side:buy?"buy":"sell",quantity:size,price,feeUsd:fee,realizedPnlUsd:state.pnl,reason,executionModel:modeled?"candle_gap_conservative":"observed_depth"});
  };
  const markEquity = (at:number) => {
    const value=cash+unrealized();peak=Math.max(peak,value);drawdown=Math.max(drawdown,peak>0?(peak-value)/peak*100:0);
    equity.push({at:new Date(at).toISOString(),equityUsd:value});
  };
  const fillOrder = (
    raw: DeskOrder,
    obs: Observation,
    reason: string,
    protective = false,
  ) => {
    try {
      const order = parseDeskOrder(raw),
        instrument = dataset.instruments.find(
          (i) => i.id === order.instrumentId,
        )!;
      if (!instrument) throw new Error("Unknown instrument.");
      const a = account();
      if (
        [...positions].some(
          ([id]) => !marks.has(id) || obs.at - marks.get(id)!.at > step * 2,
        )
      )
        a.riskWarnings = ["Held-position mark is stale; new risk blocked."];
      // Protective exits reduce existing exposure even when the entry liquidity/slippage budget no longer fits.
      const checked = protective
        ? {
            quantity: Math.min(order.quantity, Math.abs(owned(instrument.id))),
            limitPrice: order.limitPrice,
            stopPrice: undefined,
            targetPrice: undefined,
          }
        : assessDeskOrder({
            order,
            instrument,
            instruments: dataset.instruments,
            account: a,
            depth: obs.depth,
            mandate: context.mandate,
            reserved: [],
            owned: owned(instrument.id),
            suspended: false,
            dailyPnlUsd:
              daily.get(new Date(obs.at).toISOString().slice(0, 10)) ?? 0,
            deskGrossUsd: gross(),
            openInstrumentIds:[...positions.keys()],
            openRiskUsd:[...positions].reduce((n,[id,p])=>{const price=marks.get(id)?.price??p.basis;return n+(p.stop?Math.max(0,(price-p.stop)*p.quantity):Math.abs(p.quantity)*price)+Math.abs(p.quantity)*price*(context.mandate.costAllowanceBps??0)/10000;},0),
            quoting: false,
            now: obs.at,
          });
      const buy = order.side === "buy";
      let left = checked.quantity,
        total = 0,
        size = 0;
      for (const level of obs.depth.levels[buy ? 1 : 0]) {
        const rawPrice = +level.px,
          price =
            rawPrice *
            (1 + ((buy ? 1 : -1) * request.extraSlippageBps) / 10000);
        if (buy ? price > checked.limitPrice : price < checked.limitPrice)
          break;
        const take = Math.min(left, +level.sz);
        if (!(take > 0)) continue;
        total += take * price;
        size += take;
        left -= take;
        level.sz = String(+level.sz - take);
        if (left < 1e-12) break;
      }
      if (!size) {
        unfilled++;
        return false;
      }
      applyFill(instrument.id,obs.at,buy,size,total/size,reason,checked.stopPrice,checked.targetPrice);
      if (left > 1e-12) unfilled++;
      return true;
    } catch (error) {
      rejections.push({
        at: new Date(obs.at).toISOString(),
        instrumentId: raw.instrumentId,
        reason: error instanceof Error ? error.message : "Rejected",
      });
      return false;
    }
  };
  const close = (id: string, obs: Observation, reason: string) => {
    const p = positions.get(id);
    if (!p) return;
    // Market-like protective/end exits walk observed depth; no invented liquidity for the remainder.
    fillOrder(
      {
        instrumentId: id,
        side: p.quantity > 0 ? "sell" : "buy",
        quantity: Math.abs(p.quantity),
        limitPrice: p.quantity > 0 ? 1e-10 : 1e15,
        reduceOnly: true,
        thesis: reason,
      },
      obs,
      reason,
      true,
    );
  };
  const events = [
    ...dataset.observations
      .filter((o) => o.at >= from && o.at < through)
      .map((o) => ({ at: o.at, kind: "book" as const, value: o })),
    ...gaps.events.map(g=>({at:g.at,kind:"gap" as const,value:g})),
    ...(dataset.fundingGaps??[]).filter(g=>g.at>=from&&g.at<through).map(g=>({at:g.at,kind:"funding_gap" as const,value:g})),
    ...dataset.funding
      .filter((f) => f.at >= from && f.at < through)
      .map((f) => ({ at: f.at, kind: "funding" as const, value: f })),
  ].sort(
    (a, b) =>
      a.at - b.at || ({funding:0,funding_gap:0,gap:1,book:2}[a.kind] - {funding:0,funding_gap:0,gap:1,book:2}[b.kind]),
  );
  const recorded = (request.orders ?? [])
    .filter(
      (r) =>
        Date.parse(r.decidedAt) >= from && Date.parse(r.decidedAt) < through,
    )
    .sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt));
  let recordedIndex = 0;
  for (const event of events) {
    if(event.kind === "funding_gap") {
      if(owned(event.value.instrumentId)){missingFundingExposed++;limitations.add("Missing funding while a position was held; net P&L is incomplete.");}
      continue;
    }
    if(event.kind === "gap") {
      const g=event.value,p=positions.get(g.instrumentId),c=g.candle;
      if(p) {
        p.gapAffected=true;
        exposureIntervals.push({id:g.instrumentId,from:Math.max(from,p.openedAt,c?.openTime??g.at-step),through:g.at});
      }
      if(gapMode === "observed_only") {history.delete(g.instrumentId);signalBucket.delete(g.instrumentId);continue;}
      if(g.source === "closed_candle")candleSteps++;else if(g.source === "carry_forward")carriedSteps++;else unpricedSteps++;
      if(g.price!==null && g.observedAt!==null) {
        marks.set(g.instrumentId,{price:g.price,at:g.observedAt});
        appendPrice(g.instrumentId,g.at,g.price);
      } else {history.delete(g.instrumentId);signalBucket.delete(g.instrumentId);}
      if(p&&c) {
        const long=p.quantity>0,oldBook=latest.get(g.instrumentId);
        const halfSpread=oldBook?Math.max(0,(+oldBook.depth.levels[1][0].px - +oldBook.depth.levels[0][0].px)/(+oldBook.depth.levels[1][0].px + +oldBook.depth.levels[0][0].px)):0;
        const friction=halfSpread+request.extraSlippageBps/10000;
        const adverse=(long?c.low:c.high)*(1+(long?-1:1)*friction);
        const adverseEquity=cash+unrealized()+p.quantity*((long?c.low:c.high)-(marks.get(g.instrumentId)?.price??p.basis));
        drawdown=Math.max(drawdown,peak>0?(peak-adverseEquity)/peak*100:0);
        const stopped=p.stop!==undefined&&(long?adverse<=p.stop:adverse>=p.stop);
        // Never credit a target that might have traded before this position opened.
        const targeted=p.openedAt<=c.openTime&&p.target!==undefined&&(long?c.high>=p.target:c.low<=p.target);
        const timedOut=!!rule&&g.at-p.openedAt>=rule.maxHoldBars*step;
        if(stopped||targeted||timedOut||p.pendingGapExit) {
          const reason=stopped?"stop":timedOut?"max_hold":p.pendingGapExit??"target";
          p.pendingGapExit=reason;
          const price=reason!=="target"?adverse:(long?Math.min(p.target!,c.close):Math.max(p.target!,c.close))*(1+(long?-1:1)*friction);
          const decimals=dataset.instruments.find(i=>i.id===g.instrumentId)!.szDecimals;
          const rawSize=Math.min(Math.abs(p.quantity),c.volume*GAP_POLICY.candleExitParticipation);
          const size=Number((Math.floor(rawSize*10**decimals+1e-9)/10**decimals).toFixed(decimals));
          if(size>0)applyFill(g.instrumentId,g.at,!long,size,price,"gap_candle_"+reason,undefined,undefined,true);
        }
      }
      markEquity(g.at);
      continue;
    }
    if (event.kind === "funding") {
      const f = event.value,
        q = owned(f.instrumentId);
      if (q) {
        if (f.oracle === null) {
          missingFundingExposed++;
          limitations.add("Funding settlement lacks an oracle observation; net P&L is incomplete.");
        } else {
          const amount = -q * f.oracle * f.rate;
          funding += amount;
          cash += amount;
          pnl(f.at, amount);
        }
      }
      continue;
    }
    const obs = structuredClone(event.value),
      id = obs.instrumentId;
    let mid: number;
    try {
      mid = inspectBook(obs.depth, obs.at).mid;
    } catch {
      limitations.add("Invalid book observations were excluded.");
      continue;
    }
    marks.set(id, { price: mid, at: obs.at });
    latest.set(id, obs);
    const prices=appendPrice(id,obs.at,mid);
    previousAt.set(id, obs.at);
    const p = positions.get(id);
    if (p) {
      const executable = +(
        obs.depth.levels[p.quantity > 0 ? 0 : 1][0]?.px ?? NaN
      );
      if(p.pendingGapExit) close(id,obs,"gap_deferred_"+p.pendingGapExit);
      else if (
        p.stop &&
        (p.quantity > 0 ? executable <= p.stop : executable >= p.stop)
      )
        close(id, obs, "stop");
      else if (
        p.target &&
        (p.quantity > 0 ? executable >= p.target : executable <= p.target)
      )
        close(id, obs, "target");
      else if (rule && obs.at - p.openedAt >= rule.maxHoldBars * step)
        close(id, obs, "max_hold");
    }
    while (
      recordedIndex < recorded.length &&
      Date.parse(recorded[recordedIndex].decidedAt) < obs.at
    ) {
      const r = recorded[recordedIndex++];
      pending.push({ at: Date.parse(r.decidedAt), order: r.order });
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const candidate = pending[i];
      if (candidate.order.instrumentId !== id || candidate.at >= obs.at)
        continue;
      pending.splice(i, 1);
      if (obs.at - candidate.at > step * 2 || [...(gaps.missing.get(id)??[])].some(at=>at>candidate.at&&at<obs.at)) {
        rejections.push({
          at: new Date(obs.at).toISOString(),
          instrumentId: id,
          reason: "No timely execution observation after decision.",
        });
        continue;
      }
      fillOrder(candidate.order, obs, "decision");
    }
    if (
      rule &&
      !positions.has(id) &&
      obs.at - (cooldown.get(id) ?? -Infinity) >= rule.cooldownBars * step &&
      !pending.some((p) => p.order.instrumentId === id)
    ) {
      const direction = ruleDirection(rule, prices);
      if (direction) {
        const instrument = dataset.instruments.find((i) => i.id === id)!;
        const rawLimit =
          mid * (1 + (direction * context.mandate.maxSlippageBps) / 10000);
        pending.push({
          at: obs.at,
          order: {
            instrumentId: id,
            side: direction > 0 ? "buy" : "sell",
            quantity: rule.orderUsd / mid,
            limitPrice: venueLimitPrice(rawLimit, instrument.szDecimals, true, direction > 0),
            stopPrice: mid * (1 - (direction * rule.stopBps) / 10000),
            takeProfitPrice: mid * (1 + (direction * rule.targetBps) / 10000),
            thesis: request.hypothesis,
          },
        });
        cooldown.set(id, obs.at);
      }
    }
    markEquity(obs.at);
  }
  // Preserve positions and last valid marks: ending liquidation is never silently assumed.
  const endingPositions = [...positions].map(([instrumentId, p]) => ({
    instrumentId,
    quantity: p.quantity,
    basis: p.basis,
    mark: marks.get(instrumentId)?.price ?? p.basis,
    markAgeSeconds: (through - (marks.get(instrumentId)?.at ?? from)) / 1000,
  }));
  if (
    endingPositions.some((p) => p.markAgeSeconds > request.intervalSeconds * 2)
  )
    limitations.add(
      "Ending positions have stale marks; reported equity is provisional.",
    );
  if (dataset.coverage.missingFunding && dataset.fundingGaps === undefined && fills.length) {
    missingFundingExposed++;
    limitations.add("Legacy dataset lacks funding gap timestamps; reported net P&L is incomplete.");
  }
  const unresolved=exposureIntervals.filter(g=>gapMode === "observed_only" || !intervalHasCandles(gaps.candles,g.id,g.from,g.through)).length;
  const staleEnding=endingPositions.some(p=>p.markAgeSeconds>step*2/1000);
  if(gaps.expected>gaps.observed)limitations.add(GAP_POLICY.description);
  if(unresolved)limitations.add("Some held-position intervals have no independent price coverage; execution-path outcome is incomplete.");
  const dataQuality = {policy:GAP_POLICY.version,mode:gapMode,expectedBooks:gaps.expected,observedBooks:gaps.observed,missingBooks:Math.max(0,gaps.expected-gaps.observed),
    candlePriceSteps:candleSteps,carriedPriceSteps:carriedSteps,unpricedSteps,
    exposedGapIntervals:exposureIntervals.length,unresolvedExposureIntervals:unresolved,
    modeledExitFills:modeledExits,modelDependentClosedTrades:modelClosed,missingFundingWhileExposed:missingFundingExposed,
    usableForSelection:gaps.observed>0&&!unresolved&&!missingFundingExposed&&!staleEnding};
  const endEquity = cash + unrealized();
  return {
    dataQuality,
    from: new Date(from).toISOString(),
    through: new Date(through).toISOString(),
    metrics: {
      initialCapitalUsd: context.mandate.capitalUsd,
      equityUsd: endEquity,
      netPnlUsd: endEquity - context.mandate.capitalUsd,
      returnPct: (endEquity / context.mandate.capitalUsd - 1) * 100,
      maxDrawdownPct: drawdown,
      realizedPnlUsd: realized,
      unrealizedPnlUsd: unrealized(),
      feesUsd: fees,
      fundingUsd: funding,
      fills: fills.length,
      closedTrades: closed,
      rejectedOrders: rejections.length,
      unfilledOrders:
        unfilled + pending.length + (recorded.length - recordedIndex),
    },
    endingPositions,
    fills,
    rejections,
    equity,
    limitations: [...limitations],
  };
}

export function runDeskResearch(
  dataset: Dataset,
  context: ResearchContext,
  request: ResearchRequest,
  evaluateHoldout = true,
) {
  if (
    dataset.network !== (context.isTestnet ? "testnet" : "mainnet") ||
    dataset.instruments.some((i) => i.isTestnet !== context.isTestnet)
  )
    throw new Error("Research network mismatch.");
  const start = Date.parse(request.start),
    end = Date.parse(request.end),
    step = request.intervalSeconds * 1000;
  if (request.variants?.some((v) => v.orderUsd > context.mandate.maxOrderUsd))
    throw new Error("Variant order size exceeds the fixed book mandate.");
  const b1 = start + Math.floor(((end - start) * 0.6) / step) * step,
    b2 = start + Math.floor(((end - start) * 0.8) / step) * step;
  const variants = (request.variants ?? []).map((rule) => ({
    name: rule.name,
    rule,
    development: replayDesk(dataset, context, request, start, b1, rule),
    validation: replayDesk(dataset, context, request, b1, b2, rule),
    validationObservedOnly: replayDesk(dataset, context, request, b1, b2, rule, "observed_only"),
  }));
  const eligible = variants.filter(
    (v) =>
      v.validation.metrics.fills > 0 &&
      v.validation.dataQuality?.usableForSelection === true,
  );
  const winner = [...eligible].sort(
    (a, b) => Math.min(b.validation.metrics.netPnlUsd,b.validationObservedOnly.metrics.netPnlUsd) - Math.min(a.validation.metrics.netPnlUsd,a.validationObservedOnly.metrics.netPnlUsd),
  )[0];
  const holdout = winner && evaluateHoldout
    ? replayDesk(dataset, context, request, b2, end, winner.rule)
    : null;
  const replay =
    request.orders !== undefined
      ? replayDesk(dataset, context, request, start, end)
      : null;
  const dataHash = createHash("sha256")
    .update(JSON.stringify(dataset))
    .digest("hex");
  return {
    engine: ENGINE_VERSION,
    scope:
      request.orders !== undefined
        ? "recorded_desk_orders"
        : "explicit_desk_rules",
    network: dataset.network,
    hypothesis: request.hypothesis,
    mandate: context.mandate,
    dataHash,
    coverage: dataset.coverage,
    assumptions: {
      feeBpsPerSide: request.feeBpsPerSide,
      extraSlippageBps: request.extraSlippageBps,
      gapPolicy:GAP_POLICY,
      execution:
        "Next observed book after decision; IOC depth walk; shared desk risk checks; partial fills retained.",
      funding:
        "Hourly signed cash flows at historical oracle price; missing rates/prices invalidate completeness.",
      marks:
        "Last observed midpoint, with freshness reported; positions remain open at partition end.",
      metadata:
        "Current instrument precision is a declared assumption, not historical contract metadata.",
    },
    assessment: {status: request.orders !== undefined ? "recorded_order_replay" : "preliminary_smoke_test", windowCount:1,
      note:"One short historical window cannot establish an edge. Use a predeclared multi-date campaign; sparse or missing observations remain inconclusive."},
    baseline: { name: "take_no_risk", netPnlUsd: 0 },
    variants,
    selectedVariant: winner?.name ?? null,
    holdout,
    holdoutObservedOnly: winner && evaluateHoldout ? replayDesk(dataset,context,request,b2,end,winner.rule,"observed_only") : null,
    replay,
    limitations: [
      "This tests explicit rules/orders, not a regenerated historical LLM/news roundtable.",
      "Sampled books cannot reproduce queue position, latency between samples or unseen intrabar paths.",
      "60/20/20 chronological partitions reset capital and positions; only validation selects the final holdout candidate.",
      "Repeated experiments can overfit the holdout. All attempts are retained; no result promotes itself to trading.",
      "Testnet forward fills measure operation on testnet, not mainnet liquidity or profitability.",
    ],
  };
}
