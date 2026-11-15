import type { DeskInstrument } from "../instruments";
import type { DeskMandate } from "../mandate";
import type { DeskL2, DeskOrder } from "../execution-types";

export const ENGINE_VERSION = "desk-research-4.3";
export type Rule = {
  name: string;
  meanReference?: "lookback_price" | "prior_sma";
  entryFilter?: "stacked" | "setup_only" | "entry_only";
  signal: "momentum" | "mean_reversion" | "breakout" | "trend_pullback";
  side: "long" | "short" | "both";
  lookbackBars: number;
  thresholdBps: number;
  orderUsd: number;
  stopBps: number;
  targetBps: number;
  maxHoldBars: number;
  cooldownBars: number;
};
export type RecordedOrder = {
  decidedAt: string;
  evidenceAvailableAt: string;
  order: DeskOrder;
};
export type ResearchRequest = {
  engine?: "depth" | "candles";
  hypothesis: string;
  proposalKey?: string;
  reuseDatasetRunId?: string;
  additionalWindows?: Array<{ start: string; end: string }>;
  source: "archive" | "collector" | "venue_candles";
  start: string;
  end: string;
  instrumentIds: string[];
  intervalSeconds: 10 | 30 | 60 | 300 | 900 | 3600;
  feeBpsPerSide: number;
  extraSlippageBps: number;
  variants?: Rule[];
  orders?: RecordedOrder[];
};
export type Observation = {
  at: number;
  instrumentId: string;
  depth: DeskL2;
  oracle: number | null;
};
export type FundingEvent = {
  at: number;
  instrumentId: string;
  rate: number;
  oracle: number | null;
};
export type PriceCandle = {
  instrumentId: string; openTime: number; availableAt: number;
  open: number; high: number; low: number; close: number; volume: number;
  source: "archive_real_1m" | "collector_real_1m";
};
export type ReplayQuality = {
  policy: "causal-gap-1"; mode: "conservative" | "observed_only";
  expectedBooks: number; observedBooks: number; missingBooks: number;
  candlePriceSteps: number; carriedPriceSteps: number; unpricedSteps: number;
  exposedGapIntervals: number; unresolvedExposureIntervals: number;
  modeledExitFills: number; modelDependentClosedTrades: number;
  missingFundingWhileExposed: number; usableForSelection: boolean;
};
export type Dataset = {
  network: "mainnet" | "testnet";
  instruments: DeskInstrument[];
  observations: Observation[];
  funding: FundingEvent[];
  priceCandles?: PriceCandle[];
  fundingGaps?: Array<{ at: number; instrumentId: string; reason: string }>;
  coverage: {
    source: string;
    missingBooks: number;
    expectedBooks: number;
    missingFunding: number;
    recovery: unknown;
    limitations: string[];
  };
};
export type ResearchContext = {
  bookId: string;
  bookVersion: number;
  isTestnet: boolean;
  mandate: DeskMandate;
};
export type Fill = {
  at: string;
  instrumentId: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  feeUsd: number;
  realizedPnlUsd: number;
  reason: string;
  executionModel?: "observed_depth" | "candle_gap_conservative";
};
export type ReplayResult = {
  dataQuality?: ReplayQuality;
  from: string;
  through: string;
  metrics: {
    initialCapitalUsd: number;
    equityUsd: number;
    netPnlUsd: number;
    returnPct: number;
    maxDrawdownPct: number;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    feesUsd: number;
    fundingUsd: number;
    fills: number;
    closedTrades: number;
    rejectedOrders: number;
    unfilledOrders: number;
  };
  endingPositions: Array<{
    instrumentId: string;
    quantity: number;
    basis: number;
    mark: number;
    markAgeSeconds: number;
  }>;
  fills: Fill[];
  rejections: Array<{ at: string; instrumentId: string; reason: string }>;
  equity: Array<{ at: string; equityUsd: number }>;
  limitations: string[];
};
