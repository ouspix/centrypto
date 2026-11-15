import { parseDeskOrder } from "../execution-risk";
import type { ResearchRequest, Rule } from "./types";

const number = { type: "number" };
const ruleProperties = {
  name: { type: "string", minLength: 1, maxLength: 80 },
  signal: { type: "string", enum: ["momentum", "mean_reversion", "breakout", "trend_pullback"] },
  meanReference: {type:"string",enum:["lookback_price","prior_sma"],description:"Required for new mean_reversion rules. lookback_price fades the lookback return; prior_sma fades deviation from the arithmetic mean of preceding lookbackBars closes. Both use fixed stop/target/time exits, not an SMA exit."},
  entryFilter: {type:"string",enum:["stacked","setup_only","entry_only"],description:"Candle trend_pullback at 300 seconds only. Stacked reproduces live 1h/4h alignment + 15m + 5m resumption. Alternatives drop one resumption gate. Omission is the legacy single-interval proxy."},
  side: { type: "string", enum: ["long", "short", "both"] },
  lookbackBars: { type: "integer", minimum: 2, maximum: 360 },
  thresholdBps: { ...number, minimum: 0, maximum: 5000 },
  orderUsd: { ...number, exclusiveMinimum: 0 },
  stopBps: { ...number, exclusiveMinimum: 0, maximum: 5000 },
  targetBps: { ...number, exclusiveMinimum: 0, maximum: 10000 },
  maxHoldBars: { type: "integer", minimum: 1, maximum: 2160 },
  cooldownBars: { type: "integer", minimum: 1, maximum: 360 },
};
export const researchRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "hypothesis",
    "source",
    "start",
    "end",
    "instrumentIds",
    "intervalSeconds",
    "feeBpsPerSide",
    "extraSlippageBps",
  ],
  properties: {
    hypothesis: { type: "string", minLength: 8, maxLength: 2000 },
    engine: {type:"string",enum:["depth","candles"],description:"Use candles for multi-day swing research; depth for short execution replay."},
    source: { type: "string", enum: ["archive", "collector", "venue_candles"] },
    reuseDatasetRunId:{type:"string",maxLength:100,description:"Reuse the immutable candle dataset of a completed current-book run. Dates, interval and instruments must match exactly. Changes to rule/cost assumptions are explicit; no historical data or funding refetch."},
    proposalKey: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,79}$" },
    additionalWindows: {
      type: "array", minItems: 2, maxItems: 7,
      description: "Campaign: 2-7 additional chronological, non-overlapping windows on different UTC dates. Same fixed variants/costs for all windows. Select dates before examining returns.",
      items: { type: "object", additionalProperties: false, required: ["start", "end"], properties: {start: {type: "string"}, end: {type: "string"}} }
    },
    start: { type: "string" },
    end: { type: "string" },
    instrumentIds: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: { type: "string" },
    },
    intervalSeconds: { type: "integer", enum: [10, 30, 60, 300, 900, 3600] },
    feeBpsPerSide: { ...number, minimum: 0, maximum: 100 },
    extraSlippageBps: { ...number, minimum: 0, maximum: 100 },
    variants: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(ruleProperties).filter(k=>!["meanReference","entryFilter"].includes(k)),
        properties: ruleProperties,
        allOf:[{if:{properties:{signal:{const:"mean_reversion"}}},then:{required:["meanReference"]}}],
      },
    },
    orders: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["decidedAt", "evidenceAvailableAt", "order"],
        properties: {
          decidedAt: { type: "string" },
          evidenceAvailableAt: { type: "string" },
          order: {
            type: "object",
            additionalProperties: false,
            required: [
              "instrumentId",
              "side",
              "quantity",
              "limitPrice",
              "thesis",
            ],
            properties: {
              instrumentId: { type: "string" },
              side: { type: "string", enum: ["buy", "sell"] },
              quantity: { ...number, exclusiveMinimum: 0 },
              limitPrice: { ...number, exclusiveMinimum: 0 },
              stopPrice: { ...number, exclusiveMinimum: 0 },
              takeProfitPrice: { ...number, exclusiveMinimum: 0 },
              reduceOnly: { type: "boolean" },
              thesis: { type: "string" },
              eventId: { type: "string" },
            },
          },
        },
      },
    },
  },
};
const exact = (v: object, allowed: string[]) => {
  if (Object.keys(v).some((k) => !allowed.includes(k)))
    throw new Error(
      "Unknown research parameter; risk limits are owned by the book.",
    );
};
const finite = (v: unknown, lo: number, hi: number, integer = false) =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= lo &&
  v <= hi &&
  (!integer || Number.isInteger(v));
export function validateResearchRequest(
  input: unknown,
  testnet: boolean,
  now = Date.now(),
): ResearchRequest {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Supply a research request.");
  const a = input as ResearchRequest;
  exact(a, Object.keys(researchRequestSchema.properties));
  const candle = a.engine === "candles";
  if(a.engine!==undefined && !["depth","candles"].includes(a.engine))throw new Error("Invalid research engine");
  const start = Date.parse(a.start),
    end = Date.parse(a.end);
  if (
    ![a.start, a.end].every(
      (s) => typeof s === "string" && /(Z|[+-]\d\d:\d\d)$/.test(s),
    ) ||
    ![start, end].every(Number.isFinite) ||
    end > now ||
    end <= start ||
    end - start > (candle ? 180 * 86400000 : 6 * 3600000) ||
    end - start < (candle ? 7 * 86400000 : 30 * (a.intervalSeconds || 60) * 1000)
  )
    throw new Error(
      "Choose a completed window with timezones: candles 7-180 days; depth 30 bars to six hours.",
    );
  if (
    typeof a.hypothesis !== "string" ||
    a.hypothesis.trim().length < 8 ||
    a.hypothesis.length > 2000 ||
    !(candle ? ["venue_candles"] : ["archive", "collector"]).includes(a.source) ||
    !(candle ? [300,900,3600] : [10,30,60]).includes(a.intervalSeconds) ||
    !finite(a.feeBpsPerSide, 0, 100) ||
    !finite(a.extraSlippageBps, 0, 100)
  )
    throw new Error(
      "Invalid hypothesis, source, interval or cost assumptions.",
    );
  if (
    !Array.isArray(a.instrumentIds) ||
    !a.instrumentIds.length ||
    a.instrumentIds.length > 3 ||
    new Set(a.instrumentIds).size !== a.instrumentIds.length ||
    a.instrumentIds.some(
      (id) =>
        typeof id !== "string" ||
        !new RegExp(
          "^" +
            (testnet ? "testnet" : "mainnet") +
            ":perp:[A-Za-z0-9_.-]{1,50}$",
        ).test(id),
    )
  )
    throw new Error(
      "Choose one to three exact native perpetual IDs on the book network.",
    );
  if(a.reuseDatasetRunId!==undefined&&(!candle||typeof a.reuseDatasetRunId!=="string"||!a.reuseDatasetRunId||a.reuseDatasetRunId.length>100))throw new Error("Dataset reuse requires a candle run ID.");
  if(candle && (!a.variants || a.orders || a.additionalWindows))throw new Error("Candle research uses one chronological multi-day dataset with fixed variants and a frozen holdout; no recorded orders/additionalWindows.");
  if ((a.variants !== undefined) === (a.orders !== undefined))
    throw new Error("Supply variants or recorded orders, never both.");
  if (a.variants !== undefined) {
    if (
      !Array.isArray(a.variants) ||
      a.variants.length < 1 ||
      a.variants.length > 6 ||
      new Set(a.variants.map((v) => v.name)).size !== a.variants.length
    )
      throw new Error("Choose one to six uniquely named variants.");
    for (const v of a.variants) {
      if (!v || typeof v !== "object") throw new Error("Invalid rule.");
      exact(v, Object.keys(ruleProperties));
      if(v.meanReference!==undefined&&(v.signal!=="mean_reversion"||!["lookback_price","prior_sma"].includes(v.meanReference)))throw new Error("meanReference applies only to mean_reversion: choose lookback_price or prior_sma.");
      if(v.entryFilter!==undefined&&(!candle||v.signal!=="trend_pullback"||a.intervalSeconds!==300||!["stacked","setup_only","entry_only"].includes(v.entryFilter)))throw new Error("entryFilter needs candle trend_pullback at actual 300-second resolution.");
      if(!candle && v.signal === "trend_pullback")throw new Error("trend_pullback requires candle engine");
      if(candle && (v.maxHoldBars*a.intervalSeconds>48*3600 || (end-start)/4 < v.maxHoldBars*a.intervalSeconds*3000))throw new Error("Candle holding period must fit 48h and the validation partition with purge; expand history.");
      if (
        typeof v.name !== "string" ||
        !v.name.trim() ||
        v.name.length > 80 ||
        !["momentum", "mean_reversion", "breakout", "trend_pullback"].includes(v.signal) ||
        !["long", "short", "both"].includes(v.side) ||
        !finite(v.lookbackBars, 2, 360, true) ||
        !finite(v.thresholdBps, 0, 5000) ||
        !finite(v.orderUsd, 0.01, 1e8) ||
        !finite(v.stopBps, 0.01, 5000) ||
        !finite(v.targetBps, 0.01, 10000) ||
        !finite(v.maxHoldBars, 1, 2160, true) ||
        !finite(v.cooldownBars, 1, 360, true)
      )
        throw new Error("Invalid rule parameters.");
    }
  } else {
    if (!Array.isArray(a.orders) || a.orders.length > 200)
      throw new Error("At most 200 recorded orders.");
    for (const r of a.orders) {
      exact(r, ["decidedAt", "evidenceAvailableAt", "order"]);
      const at = Date.parse(r.decidedAt),
        evidence = Date.parse(r.evidenceAvailableAt);
      if (
        !Number.isFinite(at) ||
        !Number.isFinite(evidence) ||
        evidence > at ||
        at < start ||
        at >= end
      )
        throw new Error(
          "Order evidence must be available by its decision time inside the window.",
        );
      r.order = parseDeskOrder(r.order);
      if (!a.instrumentIds.includes(r.order.instrumentId))
        throw new Error("Recorded order is outside the requested instruments.");
    }
  }
  if (a.proposalKey !== undefined && (typeof a.proposalKey !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(a.proposalKey)))
    throw new Error("Invalid proposal key.");
  if (a.additionalWindows !== undefined) {
    if (!a.variants || !Array.isArray(a.additionalWindows) || a.additionalWindows.length < 2 || a.additionalWindows.length > 7)
      throw new Error("Campaigns require fixed variants and three to eight windows.");
    let previousEnd = end;
    const dates = new Set([new Date(start).toISOString().slice(0,10)]);
    for (const w of a.additionalWindows) {
      if (!w || typeof w !== "object") throw new Error("Invalid campaign window.");
      exact(w, ["start", "end"]);
      const { additionalWindows: _windows, ...base } = a;
      validateResearchRequest({...base, ...w}, testnet, now);
      const day = new Date(w.start).toISOString().slice(0,10);
      if (Date.parse(w.start) < previousEnd || dates.has(day)) throw new Error("Campaign windows must be chronological, non-overlapping and on distinct UTC dates.");
      dates.add(day); previousEnd = Date.parse(w.end);
    }
  }
  return structuredClone(a);
}
export function ruleDirection(rule: Rule, prices: number[]): number {
  if (prices.length < rule.lookbackBars + 1) return 0;
  const previous = prices.slice(-rule.lookbackBars - 1, -1),
    current = prices.at(-1)!;
  const reference=rule.signal==="mean_reversion"&&rule.meanReference==="prior_sma"?previous.reduce((n,p)=>n+p,0)/previous.length:previous[0];
  const move = (current / reference - 1) * 10000;
  let direction =
    rule.signal === "breakout"
      ? current > Math.max(...previous) * (1 + rule.thresholdBps / 10000)
        ? 1
        : current < Math.min(...previous) * (1 - rule.thresholdBps / 10000)
          ? -1
          : 0
      : Math.abs(move) >= rule.thresholdBps && move !== 0
        ? Math.sign(move) * (rule.signal === "mean_reversion" ? -1 : 1)
        : 0;
  if (
    (rule.side === "long" && direction < 0) ||
    (rule.side === "short" && direction > 0)
  )
    direction = 0;
  return direction;
}
