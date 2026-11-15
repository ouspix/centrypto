import { access, readFile, realpath } from "node:fs/promises";
import {
  createBacktestDbClient,
  DEFAULT_BACKTEST_DB_PATH,
} from "@/src/backtest/BacktestDb";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { hyperliquidInfoUrl } from "@/lib/hyperliquid-info";
import type { DeskInstrument } from "../instruments";
import { validPriceCandle } from "./gaps";
import { ENGINE_VERSION } from "./types";
import type { Dataset, Observation, ResearchRequest, PriceCandle } from "./types";

const isoTime = (v: unknown) =>
  v instanceof Date
    ? +v
    : typeof v === "bigint"
      ? Number(v)
      : typeof v === "number"
        ? v
        : Date.parse(String(v));
export function archivePath(testnet: boolean) {
  const p = testnet
    ? process.env.DESK_BACKTEST_TESTNET_DB
    : (process.env.DESK_BACKTEST_MAINNET_DB ?? DEFAULT_BACKTEST_DB_PATH);
  if (!p)
    throw new Error(
      "No historical L2 archive configured for this network; choose collector history.",
    );
  return p;
}
export async function archiveRecovery(file: string) {
  const resolved = await realpath(file);
  let raw: string;
  try {
    raw = await readFile(
      resolved.replace(/\.[^/.]+$/, "") + ".recovery.json",
      "utf8",
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const r = JSON.parse(raw);
  if (
    !["recovered", "recovered_with_gaps"].includes(r.status) ||
    JSON.stringify(r.integrityCheck) !== '["ok"]'
  )
    throw new Error("Archive recovery is not valid.");
  return {
    status: r.status,
    skippedRanges: r.skipped.length,
    affectedTables: [
      ...new Set(r.skipped.map((x: { table: string }) => x.table)),
    ],
  };
}
export async function researchCatalog(testnet: boolean) {
  const network = testnet ? "testnet" : "mainnet",
    db = testnet ? marketDbTest : marketDbMain;
  // Bound the scan to the maximum experiment window. Earlier deployments did not record quotes;
  // scanning from the oldest null-filled tick can exhaust every market DB connection.
  const collectors = await db.$queryRawUnsafe<Array<{ symbol: string; first: Date; last: Date; samples: bigint }>>(
    'SELECT "symbol",MIN("ts") AS "first",MAX("ts") AS "last",COUNT(*) AS "samples" FROM "MarketTick" WHERE "ts">=$1 AND "bookBidPx">0 AND "bookAskPx">"bookBidPx" AND "bookBidSz">0 AND "bookAskSz">0 GROUP BY "symbol" LIMIT 30',
    new Date(Date.now() - 6 * 3600000),
  );
  let archive: unknown;
  try {
    const file = archivePath(testnet);
    await access(file);
    const historical = createBacktestDbClient(file);
    try {
      const rows = await historical.$queryRawUnsafe<
        Array<{
          symbol: string;
          intervalSeconds: number;
          first: unknown;
          last: unknown;
          samples: bigint;
        }>
      >(
        'SELECT "symbol","intervalSeconds",MIN("ts") AS "first",MAX("ts") AS "last",COUNT(*) AS "samples" FROM "MarketBook" GROUP BY "symbol","intervalSeconds" LIMIT 90',
      );
      archive = {
        status: "observed",
        recovery: await archiveRecovery(file),
        coverage: rows.map((r) => ({
          instrumentId: network + ":perp:" + r.symbol.replace(/-PERP$/, ""),
          intervalSeconds: r.intervalSeconds,
          first: new Date(isoTime(r.first)).toISOString(),
          last: new Date(isoTime(r.last)).toISOString(),
          samples: Number(r.samples),
        })),
      };
    } finally {
      await historical.$disconnect();
    }
  } catch (e) {
    archive = {
      status: "unavailable",
      reason: e instanceof Error ? e.message : "Archive unavailable",
    };
  }
  return {
    engine: ENGINE_VERSION,
    network,
    archive,
    collector: {
      status: collectors.length ? "observed" : "unavailable",
      reason: collectors.length
        ? null
        : "No executable quote history recorded in the last six hours. Price and candle history alone cannot simulate depth fills.",
      coverageWindowHours: 6,
      depth: "Recorded top of book only; deeper liquidity is never invented.",
      coverage: collectors.map((r) => ({
        instrumentId: network + ":perp:" + r.symbol.replace(/-PERP$/, ""),
        first: r.first,
        last: r.last,
        samples: Number(r.samples),
      })),
    },
    candles: {engine:"candles",source:"venue_candles",intervalSeconds:[300,900,3600],maxDays:180,minDays:7,signals:["trend_pullback","momentum","breakout","mean_reversion"],ruleSemantics:{mean_reversion:"Explicit meanReference required: prior_sma deviation vs lookback_price reversal; fixed exits, no implicit mean target.",trend_pullback:"entryFilter stacked/setup_only/entry_only at intervalSeconds=300 reproduces explicit multi-timeframe filters; omit for single-interval proxy only."},history:"Automatically retrieves/caches closed venue candles for any native perp. Latest 5000 candles per interval plus observed cache; actual gaps reported per requested period. Settled funding fetched separately.",fidelity:"Candle OHLC simulation; no historic depth implied. Next-bar entries, gap-aware stop-first exits, one shared capital pool, risk sizing, purge and untouched holdout. Use 1h for 90 days, 15m for shorter fine-resolution tests."},
    capabilities: {
      signals: ["momentum", "mean_reversion", "breakout"],
      recordedOrders: true,
      sharedDeskRisk: true,
      gapPolicy: "Closed real candles bridge price and model conservative exits; new entries always require observed book depth. Carry-forward lasts at most 60 seconds. Coverage is assessed by partition and actual exposure, not a blanket whole-window veto.",
      maxHours: 6,
      maxCampaignWindows: 8,
      campaign: "Use additionalWindows for 3-8 distinct dates, with fixed rules/costs. Each window stays at most six hours; choose dates before inspecting performance.",
      maxInstruments: 3,
      maxVariants: 6,
      intervalSeconds: [10, 30, 60],
      fixedMandate: true,
      selection:
        "60% development, 20% validation, 20% untouched final candidate holdout",
    },
    limitations: [
      "Current instrument precision is assumed.",
      "News-driven roundtables are evaluated forward on active testnet, not reconstructed from this archive.",
    ],
  };
}
export async function loadResearchData(
  request: ResearchRequest,
  testnet: boolean,
  instruments: DeskInstrument[],
  signal: AbortSignal,
): Promise<Dataset> {
  const start = Date.parse(request.start),
    end = Date.parse(request.end),
    step = request.intervalSeconds * 1000;
  const db = testnet ? marketDbTest : marketDbMain,
    observations: Observation[] = [];
  const limitations: string[] = [],
    funding: Dataset["funding"] = [];
  const priceCandles: PriceCandle[] = [], fundingGaps: NonNullable<Dataset["fundingGaps"]> = [];
  let recovery: unknown = null,
    missingFunding = 0;
  const symbols = instruments.map((i) => i.coin + "-PERP");
  const collectorSymbols = instruments.map((i) => i.coin);
  const ticks =
    request.source === "collector"
      ? await db.$queryRawUnsafe<
          Array<{
            ts: Date;
            symbol: string;
            indexPrice: number | null;
            bookBidPx: number | null;
            bookBidSz: number | null;
            bookAskPx: number | null;
            bookAskSz: number | null;
          }>
        >(
          'SELECT DISTINCT ON (floor(extract(epoch from "ts") / $3),"symbol") "ts","symbol","indexPrice","bookBidPx","bookBidSz","bookAskPx","bookAskSz" FROM "MarketTick" WHERE "ts">=$1 AND "ts"<$2 AND "symbol"=ANY($4::text[]) ORDER BY floor(extract(epoch from "ts") / $3),"symbol",("bookBidPx">0 AND "bookAskPx">"bookBidPx" AND "bookBidSz">0 AND "bookAskSz">0) DESC NULLS LAST,"ts" DESC LIMIT 10000',
          new Date(start - 120000),
          new Date(end),
          request.intervalSeconds,
          collectorSymbols,
        )
      : [];
  if (signal.aborted) throw new Error("Research cancelled.");
  if (request.source === "archive") {
    const file = archivePath(testnet);
    await access(file);
    recovery = await archiveRecovery(file);
    const historical = createBacktestDbClient(file);
    try {
      const archivedTicks = await historical.$queryRawUnsafe<
        Array<{
          ts: unknown;
          symbol: string;
          indexPrice: number | null;
          bookBidPx: number | null;
          bookBidSz: number | null;
          bookAskPx: number | null;
          bookAskSz: number | null;
        }>
      >(
        'SELECT "ts","symbol","indexPrice","bookBidPx","bookBidSz","bookAskPx","bookAskSz" FROM "MarketTick" WHERE "ts">=? AND "ts"<? AND "symbol" IN (' +
          collectorSymbols.map(() => "?").join(",") +
          ') ORDER BY "ts" LIMIT 10000',
        new Date(start - 120000),
        new Date(end),
        ...collectorSymbols,
      );
      ticks.push(
        ...archivedTicks.map((t) => ({ ...t, ts: new Date(isoTime(t.ts)) })),
      );
      // Read directly: no schema preparation, hydration, synthetic candles or writes to recovered history.
      const rows = await historical.$queryRawUnsafe<
        Array<{
          ts: unknown;
          symbol: string;
          bidsJson: string;
          asksJson: string;
        }>
      >(
        'SELECT "ts","symbol","bidsJson","asksJson" FROM "MarketBook" WHERE "ts">=? AND "ts"<? AND "intervalSeconds"<=? AND "symbol" IN (' +
          symbols.map(() => "?").join(",") +
          ') ORDER BY "ts","symbol","intervalSeconds" DESC LIMIT 30000',
        new Date(start),
        new Date(end),
        request.intervalSeconds,
        ...symbols,
      );
      const candles = await historical.$queryRawUnsafe<Array<{symbol:string;openTime:unknown;open:number;high:number;low:number;close:number;volume:number}>>(
        `SELECT "symbol","openTime","open","high","low","close","volume" FROM "MarketCandle" WHERE "timeframe"='1m' AND "source"='real_1m' AND "volume">0 AND "openTime">=? AND "openTime"<? AND "symbol" IN (` + collectorSymbols.map(()=>"?").join(",") + ') ORDER BY "openTime" LIMIT 1200',
        new Date(start),new Date(end),...collectorSymbols);
      for(const c of candles) {
        const i=instruments.find(i=>i.coin===c.symbol);
        if(!i)continue;
        const candle:PriceCandle={instrumentId:i.id,openTime:isoTime(c.openTime),availableAt:isoTime(c.openTime)+60000,open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:Number(c.volume),source:"archive_real_1m"};
        if(validPriceCandle(candle))priceCandles.push(candle);
      }
      for (const r of rows) {
        const at = isoTime(r.ts),
          i = instruments.find((i) => i.coin + "-PERP" === r.symbol)!;
        const levels = (json: string) =>
          JSON.parse(json).map((l: { price: number; size: number }) => ({
            px: String(l.price),
            sz: String(l.size),
          }));
        observations.push({
          at,
          instrumentId: i.id,
          depth: { time: at, levels: [levels(r.bidsJson), levels(r.asksJson)] },
          oracle: null,
        });
      }
    } finally {
      await historical.$disconnect();
    }
  } else {
    const candles=await db.$queryRawUnsafe<Array<{symbol:string;openTime:Date;open:number;high:number;low:number;close:number;volume:number}>>(
      `SELECT "symbol","openTime","open","high","low","close","volume" FROM "MarketCandle" WHERE "timeframe"='1m' AND ("source" IS NULL OR "source"='real_1m') AND "volume">0 AND "openTime">=$1 AND "openTime"<$2 AND "symbol"=ANY($3::text[]) ORDER BY "openTime" LIMIT 1200`,new Date(start),new Date(end),collectorSymbols);
    for(const c of candles) {
      const i=instruments.find(i=>i.coin===c.symbol);if(!i)continue;
      const candle:PriceCandle={instrumentId:i.id,openTime:isoTime(c.openTime),availableAt:isoTime(c.openTime)+60000,open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:Number(c.volume),source:"collector_real_1m"};
      if(validPriceCandle(candle))priceCandles.push(candle);
    }
    limitations.push(
      "Collector history contains top-of-book depth only; larger orders may be rejected or partially filled.",
    );
    for (const r of ticks) {
      const at = +r.ts;
      if (
        at < start ||
        !r.bookBidPx ||
        !r.bookAskPx ||
        !(Number(r.bookBidSz) > 0) ||
        !(Number(r.bookAskSz) > 0)
      )
        continue;
      const i = instruments.find((i) => i.coin === r.symbol)!;
      observations.push({
        at,
        instrumentId: i.id,
        oracle: r.indexPrice,
        depth: {
          time: at,
          levels: [
            [{ px: String(r.bookBidPx), sz: String(r.bookBidSz) }],
            [{ px: String(r.bookAskPx), sz: String(r.bookAskSz) }],
          ],
        },
      });
    }
  }
  for (const i of instruments) {
    const byTime = ticks
      .filter(
        (t) => t.symbol === i.coin && t.indexPrice !== null && t.indexPrice > 0,
      )
      .sort((a, b) => +a.ts - +b.ts);
    const expected: number[] = [];
    for (
      let at = Math.floor(start / 3600000) * 3600000;
      at < end;
      at += 3600000
    )
      expected.push(at);
    let rows: Array<{ coin: string; time: number; fundingRate: string }> = [];
    try {
      const response = await fetch(hyperliquidInfoUrl(testnet), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "fundingHistory",
          coin: i.coin,
          startTime: Math.floor(start / 3600000) * 3600000,
          endTime: end - 1,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw new Error("Funding history unavailable.");
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("Invalid funding history.");
      rows = data;
    } catch (e) {
      if (signal.aborted) throw e;
    }
    for (const at of expected) {
      const r = rows.find(
        (r) =>
          r.coin === i.coin &&
          r.time >= at &&
          r.time < at + 60000 &&
          Number.isFinite(Number(r.fundingRate)),
      );
      if (r && (r.time < start || r.time >= end)) continue;
      if (!r && at + 60000 <= start) continue;
      const settledAt = r?.time ?? at;
      const oracle =
        byTime.findLast(
          (t) => +t.ts <= settledAt && settledAt - +t.ts <= 120000,
        )?.indexPrice ?? null;
      if (!r) {
        missingFunding++;
        fundingGaps.push({at:settledAt,instrumentId:i.id,reason:"Missing historical funding rate"});
        continue;
      }
      if (oracle === null) missingFunding++;
      funding.push({
        at: settledAt,
        instrumentId: i.id,
        rate: Number(r.fundingRate),
        oracle,
      });
    }
  }
  if (!observations.length)
    throw new Error(
      "No execution-book observations cover this window and network. Inspect backtest_catalog for recorded coverage; candles and marks cannot substitute for executable quotes.",
    );
  const valid: Observation[] = [],
    keys = new Set<string>();
  for (const o of observations) {
    if (
      !Number.isFinite(o.at) ||
      +o.depth.levels[0][0]?.px >= +o.depth.levels[1][0]?.px ||
      o.depth.levels.some(
        (side) =>
          !side.length ||
          side.some(
            (l) =>
              !Number.isFinite(+l.px) ||
              +l.px <= 0 ||
              !Number.isFinite(+l.sz) ||
              +l.sz <= 0,
          ),
      )
    )
      continue;
    const key = o.instrumentId + ":" + Math.floor((o.at - start) / step);
    if (keys.has(key)) continue;
    keys.add(key);
    valid.push(o);
  }
  const expectedBooks = Math.ceil((end - start) / step) * instruments.length,
    missingBooks = Math.max(0, expectedBooks - valid.length);
  if (!valid.length) throw new Error("No valid execution observations.");
  // Hashing this immutable payload, and saving it as an artifact, makes every used observation reproducible.
  const coverage = {
    source: request.source,
    missingBooks,
    expectedBooks,
    missingFunding,
    recovery,
    limitations,
  };
  return {
    network: testnet ? "testnet" : "mainnet",
    instruments,
    observations: valid.sort((a, b) => a.at - b.at),
    funding,
    priceCandles,
    fundingGaps,
    coverage,
  };
}
