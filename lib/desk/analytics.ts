import { readMarketContext, screenBook, contextQueryProperties, type ContextQuery } from "./market-context";
import { parseScreenQuery, screeningCatalog, screenQueryProperties } from "./market-screen";
import { contextMode } from "./market-snapshots";
import { comparisonSlate } from "./candidate-comparison";
import { strategyProfile } from "./decision-policy";
import { queueEvidenceFollowup } from "./evidence-followup";
import { assessEntryFilters } from "./entry-filters";
import { readDiscoveryScan } from "./discovery-scan";
import { historicalCandles, CANDLE_INTERVALS } from "./candle-history";
import { swingFeatures, SWING_PROFILE } from "./swing";
import type { DeskBook } from "@prisma/client";
import { prisma } from "@/lib/db";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import {
    MarketAnalysisService,
    type MarketMetrics,
    type OrderBookMetrics,
} from "@/services/MarketAnalysisService";
import {
    ScreenerService,
    type EnrichedMarketData,
} from "@/services/ScreenerService";
import { MarketSnapshotAssembler } from "@/services/MarketSnapshotAssembler";
import { MarketDerivedMetricsService } from "@/services/MarketDerivedMetricsService";
import type { MarketEntry } from "@/types/snapshot";
import { MarketStructureService } from "@/services/MarketStructureService";
import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";
import { parseDeskMandate } from "./mandate";
import type { DeskInstrument } from "./instruments";
import type { publicQuote } from "./market";
import type { DeskTool } from "./runtime";
import { ShiftReads } from "./read-cache";
import { candleCoverage, historicalMoveStudy } from "./research-data";
import { deskBacktestTools } from "./backtest-tools";
import { deskNewsSentiment } from "./news-sentiment";

type Quote = Awaited<ReturnType<typeof publicQuote>>;
import type { FundingSetup } from "./funding-gate";
type Context = {
    observeFundingSetup?: (setup:FundingSetup)=>void;
    book: DeskBook;
    marketContextId?: string;
    instruments: () => Promise<DeskInstrument[]>;
    perpetuals?: () => Promise<DeskInstrument[]>;
    instrument: (id: unknown) => Promise<DeskInstrument>;
    quote: (item: DeskInstrument) => Promise<Quote>;
};
const str = { type: "string" };
const object = (
    properties: Record<string, unknown>,
    required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });

function structureView(market: MarketEntry) {
    const s = new MarketStructureService().compute(market);
    return {
        ...s,
        range: {
            ...s.range,
            newHigh4h: market.high_low?.is_new_high_4h ?? null,
            newLow4h: market.high_low?.is_new_low_4h ?? null,
        },
        impulse: { ...s.impulse, ageMinutes: null },
    }; // The legacy service does not measure impulse age.
}
function derivedView(market: MarketEntry) {
    const { structure: _structure, edge, ...rest } = market.derived!;
    return {
        ...rest,
        historicalMoveBps: edge.expected_move_bps,
        moveMinusEstimatedCostsBps: edge.edge_bps,
        heuristicEdgeGatePassed: edge.edge_ok,
        heuristicOnly: true,
    };
}

/** The full calculations are reused, but unobserved defaults are not published as measurements. */
export function observedMetrics(metrics: MarketMetrics, minutes: number) {
    const m = structuredClone(metrics) as unknown as Record<string, any>;
    for (const [key, n] of Object.entries({
        m1: 2,
        m5: 6,
        m15: 16,
        h1: 61,
        h4: 241,
    })) {
        if (minutes < n) m.returns[key] = null;
    }
    for (const [key, n] of Object.entries({
        m1: 6,
        m5: 16,
        m15: 31,
        h1: 61,
        h4: 241,
    }))
        if (minutes < n) m.realized_vol[key] = null;
    for (const [key, n] of Object.entries({ m1: 15, m5: 71, m15: 211 }))
        if (minutes < n) m.rsi[key] = null;
    if (minutes < 20) m.bbands.m1 = null;
    if (minutes < 100) m.bbands.m5 = null;
    if (minutes < 175) m.macd.m5 = null;
    if (minutes < 2100) m.macd.h1 = null;
    if (minutes < 71) {
        m.atr.m5 = null;
        m.atr_pct.m5 = null;
    }
    if (minutes < 841) {
        m.atr.h1 = null;
        m.atr_pct.h1 = null;
    }
    if (minutes < 61) {
        m.volume_zscores = null;
        m.vol_zscores = null;
        m.high_low = null;
        m.regime_tags = [];
    }
    return m;
}

function bookMetrics(q: Quote, bands: string[]): OrderBookMetrics {
    const mid = (q.bid + q.ask) / 2;
    const depth = (levels: Array<{ px: string; sz: string }>, band: number) =>
        levels.reduce(
            (n, l) =>
                Math.abs(Number(l.px) / mid - 1) <= band
                    ? n + Number(l.px) * Number(l.sz)
                    : n,
            0,
        );
    const bid = depth(q.bids, 0.01),
        ask = depth(q.asks, 0.01);
    return {
        best_bid: q.bid,
        best_ask: q.ask,
        mid,
        spread_bps: q.spreadBps,
        depth_usd: { bid_1pct: bid, ask_1pct: ask },
        imbalance: ask > 0 ? bid / ask : 0,
        book_pressure: bid + ask > 0 ? (bid - ask) / (bid + ask) : 0,
        cost_bps: 0,
        depth_bands_usd: {
            bid: Object.fromEntries(
                bands.map((b) => [b, depth(q.bids, Number(b) / 100)]),
            ),
            ask: Object.fromEntries(
                bands.map((b) => [b, depth(q.asks, Number(b) / 100)]),
            ),
        },
    };
}

export function quantitativeTools(ctx: Context): DeskTool[] {
    const db = ctx.book.isTestnet ? marketDbTest : marketDbMain;
    const reads = new ShiftReads(),
        analysis = new MarketAnalysisService();
    // Ranking only: do not start a websocket, ingestion, or one REST book request per venue asset.
    const ranker = new ScreenerService(ctx.book.isTestnet, {
        disableLive: true,
    });
    const mandate = () => parseDeskMandate(ctx.book.mandateJson);
    const catalog = async (id: unknown) => {
        const item = await ctx.instrument(id);
        return item;
    };
    const candles = async (item: DeskInstrument, hours = 48) =>
        (
            await reads.read(
                `research-candles:${item.id}:${hours}`,
                30_000,
                async () => {
                    const rows = await db.marketCandle.findMany({
                        where: {
                            symbol: item.coin,
                            timeframe: "1m",
                            openTime: {
                                gte: new Date(Date.now() - hours * 3600000),
                                lt: new Date(
                                    Math.floor(Date.now() / 60000) * 60000,
                                ),
                            },
                        },
                        orderBy: { openTime: "asc" },
                        take: hours * 60 + 1,
                        select: {
                            openTime: true,
                            open: true,
                            high: true,
                            low: true,
                            close: true,
                            volume: true,
                        },
                    });
                    return candleCoverage(rows);
                },
            )
        ).value;
    const technical = async (item: DeskInstrument) => {
        const coverage = await candles(item);
        if (
            !coverage.fresh ||
            coverage.contiguous < 61 ||
            coverage.contiguousTradedCandles < 20
        )
            return {
                status: "data_unavailable" as const,
                item,
                coverage,
                metrics: null,
            };
        const rows = coverage.candles.slice(-coverage.contiguous);
        const metrics = analysis.calculateMetrics(
            rows.map((c) => ({
                t: +c.openTime,
                o: String(c.open),
                h: String(c.high),
                l: String(c.low),
                c: String(c.close),
                v: String(c.volume),
            })),
        );
        return { status: "observed" as const, item, coverage, metrics };
    };
    const publicCoverage = (c: Awaited<ReturnType<typeof candles>>) => ({
        count: c.count,
        contiguousMinutes: c.contiguous,
        tradedCandles: c.tradedCandles,
        contiguousTradedCandles: c.contiguousTradedCandles,
        missingMinutes: c.missingMinutes,
        ageSeconds: c.ageSeconds,
        latestClosedAt: c.latestClosedAt,
    });

    const settings = () => ({
        ...DEFAULT_SCREENER_CONFIG,
        topN: 8,
        discoveryMaxSymbols: 12,
        minDepthUsd: Math.max(
            DEFAULT_SCREENER_CONFIG.minDepthUsd,
            mandate().minDepthUsd,
        ),
        includeExecutionBlockedForDiagnostics: false,
    });
    const candidate = async (
        item: DeskInstrument,
        tick: {
            fundingRate: number | null;
            openInterest: number | null;
            volume24h: number | null;
            markPrice: number;
        },
        signal: AbortSignal,
    ) => {
        if (signal.aborted) throw new Error("Research cancelled");
        const t = await technical(item);
        if (!t.metrics || t.coverage.contiguous < 241) return null;
        const q = await ctx.quote(item);
        if (
            !Number.isFinite(q.time) ||
            Date.now() - q.time > 10000 ||
            q.time > Date.now() + 1000 ||
            !(q.ask >= q.bid && q.bid > 0)
        )
            return null;
        const cfg = settings();
        const data: EnrichedMarketData = {
            symbol: item.coin,
            price: (q.bid + q.ask) / 2,
            volume24h: tick.volume24h ?? 0,
            funding: tick.fundingRate ?? 0,
            openInterest: tick.openInterest ?? 0,
            recentQuoteVolume: t.coverage.candles
                .slice(-cfg.recentVolumeMinutes)
                .reduce((n, c) => n + c.volume * c.close, 0),
            metrics: t.metrics,
            bookMetrics: bookMetrics(q, cfg.depthBandsPct),
            isTestnet: ctx.book.isTestnet,
        };
        return {
            item,
            data,
            coverage: publicCoverage(t.coverage),
            bookAt: new Date(q.time).toISOString(),
        };
    };
    // Discovery only reads bulk collector snapshots. It does not hydrate candles,
    // quote the shortlist, inspect account balances or infer execution permission.
    const screen = async (signal: AbortSignal, nominated: string[] = []) =>
        (await reads.read("research-screen:" + nominated.join(","), 60_000, async () => {
            signal.throwIfAborted();
            const [inventory, orders] = await Promise.all([
                prisma.deskInventory.findMany({where:{bookId:ctx.book.id,quantity:{not:0}},select:{instrumentId:true}}),
                prisma.deskIntent.findMany({where:{bookId:ctx.book.id,state:{in:["submitting","unknown","working","settling"]}},select:{instrumentId:true}}),
            ]);
            const discovery = await readDiscoveryScan(ctx.book.isTestnet, {
                resolve: ctx.perpetuals ?? ctx.instruments,
                pinned: [...inventory, ...orders].map(i => i.instrumentId),
                nominated,
            });
            signal.throwIfAborted();
            const observed=discovery.coverage.filter(r=>r.status==="observed" && r.return1hBps!=null);
            return {at:new Date().toISOString(),scanned:discovery.scanned,discovery,
                regime:{status:"insufficient_coverage",current:null,validSymbols:0,
                    reason:"Execution regime classification deferred; whole-market returns below are descriptive breadth only.",
                    breadth:{measured:observed.length,advancing:observed.filter(r=>r.return1hBps!>0).length,declining:observed.filter(r=>r.return1hBps!<0).length}},
            };
        })).value;
    const tool = (
        name: string,
        description: string,
        inputSchema: DeskTool["inputSchema"],
        run: DeskTool["run"],
    ): DeskTool => ({ name, description, inputSchema, run, access: "read" });
    return [
        tool("screening_catalog", "Read market screening views, metrics, units and data requirements.", object({}), async () => screeningCatalog),
        tool("market_context", "Read Hyperliquid benchmark structure, breadth, positioning, liquidity, News Intelligence and official upcoming events. Omit fields for the complete view, select sections to narrow, use fresh=true for a newer snapshot or snapshotId for recorded evidence.", object(contextQueryProperties, []),
            async a => await readMarketContext(ctx.book, a as ContextQuery, ctx.marketContextId) ?? { status: "unavailable" }),
        tool(
            "screen_markets",
            "Find native perpetual research candidates by setup view, horizon, side, benchmark, metric filters and ordering. Read screening_catalog for available measurements. Held instruments and explicit nominations have separate receipts. Results prioritize investigation.",
            object(screenQueryProperties, []),
            async (a, c) => {
                const query = parseScreenQuery(a);
                if (contextMode() === "enabled") return screenBook(ctx.book, query, ctx.marketContextId);
                if (query.preset !== "balanced" || query.filters.length || query.sort.length || query.cursor || a.timeframe || a.direction || a.benchmark)
                    return screenBook(ctx.book, query, ctx.marketContextId);
                const s = await screen(c.signal, Array.isArray(a.nominate)?a.nominate.map(String):[]);
                return {
                    status:s.discovery.shortlist.length?"research_candidates":"no_qualified_candidates",
                    asOf:s.at,scanned:s.scanned,
                    researchLanes:s.discovery.researchLanes,
                    comparisonBrief:comparisonSlate(s.discovery.researchLanes,s.discovery.shortlist),
                    researchShortlist:s.discovery.shortlist.slice(0, query.limit).map(r=>({...r,liquidity:{status:"deferred",reason:"Read order_book when liquidity can change the thesis, timing, size or execution decision"}})),
                    discovery:{asOf:s.discovery.asOf,eligible:s.discovery.eligible,scanned:s.discovery.scanned,unavailable:s.discovery.unavailable,policy:s.discovery.policy,
                        coverageColumns:["symbol","status","return1hBps","return4hBps","relativeBtcBps","oiChange1hPct"],
                        coverage:s.discovery.coverage.map(r=>[r.symbol,r.status,...[r.return1hBps,r.return4hBps,r.relativeBtcBps,r.oiChange1hPct].map(v=>v==null?null:Math.round(v*100)/100)])},
                    held: s.discovery.shortlist.filter(r => r.pinned),
                    nominations: query.nominate.map(instrumentId => s.discovery.coverage.find(r => r.instrumentId === instrumentId) ??
                        { instrumentId, status: "outside_snapshot" }),
                    candidates:[],skipped:[],rejected:[],regime:s.regime,
                    limitations:["Collector-only discovery; no live depth, technical hydration, account lookup or execution classification performed.",
                        "Inspect up to four shortlist names sequentially, prioritizing different research lanes. A failed entry today does not invalidate historical research. Reuse fresh shared observations; request depth/cost/account data only if it can change the decision.",
                        "Ranks are research priorities, not forecasts. All native perps remain eligible; low volume can defer expensive work."]
                };
            },
        ),
        tool("setup_outcomes","Read prospective accepted, parked and rejected setup price outcomes by strategy version. These are price reactions, separate from modeled fills and actual book P&L.",object({},[]),async()=>{
            const rows=await prisma.deskRecord.findMany({where:{bookId:ctx.book.id,kind:"setup_observation"},orderBy:{createdAt:"desc"},take:100});
            return {scope:"prospective_price_response_not_trade_pnl",sampled:rows.length,observations:rows.map(r=>JSON.parse(r.dataJson)),note:"Coverage and actual first observation retained. No fictional fills or fee-free trading profits inferred."};
        }),
        tool("strategy_profile","Refresh the current book mandate and decision policy only when openingBrief.strategyProfile is missing or a policy change needs checking. The host already supplies this same profile at the start of each role turn. No venue read; inactive news has no independent budget.",object({},[]),()=>strategyProfile(prisma,ctx.book)),
        tool("swing_context","Staged candle context for one native perp. entryAssessment is an advisory continuation-pattern diagnostic, not a discretionary veto. Hourly resumption is not required. Default auto loads hourly candles first, then 15m only if hourly trend and 4h regime align, then 5m only if 15m resumption qualifies. Request stage=hourly for research planning; stage=setup or entry explicitly requests that resolution. No depth/account/funding calls. Closed candles are reused within the shift.",object({instrumentId:str,stage:{type:"string",enum:["auto","hourly","setup","entry"]}},["instrumentId"]),async(a,c)=>{
            const item=await catalog(a.instrumentId);if(item.kind!=="perp")throw new Error("Native perpetual required");
            const stage=String(a.stage??"auto");
            if(!["auto","hourly","setup","entry"].includes(stage))throw new Error("Choose a supported context stage");
            const now=Date.now();
            const history=async(interval:"1h"|"15m"|"5m")=>(await reads.read("swing:"+item.id+":"+interval,60_000,async()=>{
                // Five days covers the 20 closed 4h regime bars plus setup warmup.
                // The backtester obtains its own full experiment range on demand.
                const days=5;
                const h=await historicalCandles(item.coin,interval,now-days*86400000,now,ctx.book.isTestnet,c.signal);
                return {interval,coverage:h.coverage,source:h.source,retention:h.retention,features:swingFeatures(h.bars,CANDLE_INTERVALS[interval],Math.floor(now/CANDLE_INTERVALS[interval])*CANDLE_INTERVALS[interval])};
            },()=>Math.floor(now/CANDLE_INTERVALS[interval])*CANDLE_INTERVALS[interval]+CANDLE_INTERVALS[interval])).value;
            const hourly=await history("1h"),histories=[hourly],deferred:string[]=[];
            const f=hourly.features;
            const aligned=f.status==="observed"&&f.trendBps!=null&&f.regimeBps!=null&&Math.sign(f.trendBps)!==0&&Math.sign(f.trendBps)===Math.sign(f.regimeBps);
            if(stage==="setup"||stage==="entry"||stage==="auto"&&aligned){
                const setup=await history("15m");histories.push(setup);
                if(stage==="entry"||stage==="auto"&&setup.features.direction!==0)histories.push(await history("5m"));
                else deferred.push("5m: no qualifying setup resumption; entry refinement deferred");
            }else deferred.push("15m/5m deferred by the reference pattern or explicit hourly request; stage=setup/entry remains available for a discretionary question");
            const setup=histories.find(h=>h.interval==="15m"),entry=histories.find(h=>h.interval==="5m");
            const entryAssessment=assessEntryFilters(hourly.features,setup?.features,entry?.features);
            const qualifying=entryAssessment.stage==="ready";
            ctx.observeFundingSetup?.({instrumentId:item.id,qualifying,validUntil:Math.min(now+60_000,Math.floor(now/300_000)*300_000+300_000)});
            return {instrumentId:item.id,profile:SWING_PROFILE.version,stage,contextDays:5,histories,deferred,entryAssessment,referencePatternReady:qualifying,mandatoryForDiscretionary:false,note:"Recent five-day candle context. Missing reference-pattern conditions do not veto discretionary assessment. Use purpose=decision_research with a question for relevant funding reads; inspect liquidity, participation or catalysts when decision-relevant. Backtests retrieve their full historical range separately."};
        }),
        tool(
            "technical_analysis",
            "Read Centrypto technical indicators, returns, volatility, volume, RSI, bands, ATR and MACD for an exact instrument. Missing/stale or insufficient history is explicit; unavailable indicators are null, not neutral defaults.",
            object({ instrumentId: str }),
            async (a) => {
                const t = await technical(await catalog(a.instrumentId));
                return {
                    instrumentId: t.item.id,
                    status: t.status,
                    coverage: publicCoverage(t.coverage),
                    metrics: t.metrics
                        ? observedMetrics(t.metrics, t.coverage.contiguous)
                        : null,
                    note: "Calculated from closed collector candles; indicators are descriptive and do not establish expected profit.",
                };
            },
        ),
        tool(
            "market_regime",
            "Read measured market breadth and benchmark structure.",
            object({}),
            async (_, c) => {
                const context = contextMode() === "enabled" ? await readMarketContext(ctx.book, { sections: ["benchmarks", "breadth"] }, ctx.marketContextId) : null;
                if (context?.status === "observed") return {
                    asOf: context.asOf, scope: "hyperliquid_native_perps", evidenceId: context.evidenceId,
                    regime: { status: "descriptive", current: null, breadth: context.breadth?.["1h"] },
                    benchmarks: context.benchmarks, coverage: context.coverage,
                };
                const s = await screen(c.signal);
                return {
                    asOf: s.at,
                    regime: s.regime,
                    skipped: [],
                    scope: "whole_native_perpetual_collector_breadth",
                };
            },
        ),
        tool(
            "market_structure",
            "Read Centrypto momentum, breakout, pullback, participation and preset execution diagnostics for an exact perpetual. These rule-based signals and historical edge estimates are hypotheses, not fair value or trade approval.",
            object({ instrumentId: str }),
            async (a, c) => {
                const item = await catalog(a.instrumentId);
                if (item.kind !== "perp")
                    throw new Error(
                        "Centrypto structure adapter requires a native perpetual; use technical_analysis for spot.",
                    );
                const tick = await db.marketTick.findFirst({
                    where: {
                        symbol: item.coin,
                        ts: { gte: new Date(Date.now() - 120000) },
                    },
                    orderBy: { ts: "desc" },
                });
                if (!tick)
                    return {
                        status: "data_unavailable",
                        reason: "No fresh collector tick",
                    };
                const data = await candidate(item, tick, c.signal);
                if (!data)
                    return {
                        status: "data_unavailable",
                        reason: "Insufficient traded history or fresh book",
                    };
                const ranked = ranker.discoverAndRank(
                    [data.data],
                    [],
                    {
                        ...settings(),
                        forceIncludeSymbols: [item.coin],
                        includeExecutionBlockedForDiagnostics: true,
                    },
                    DEFAULT_AGENT_CONFIG,
                );
                const { markets } =
                    new MarketSnapshotAssembler().buildFromScreenedSymbols(
                        ranked,
                        new Map(),
                    );
                const market = markets[item.coin + "-PERP"];
                if (!market)
                    return {
                        status: "data_unavailable",
                        reason: "No assembled market",
                    };
                new MarketDerivedMetricsService().applyDerivedMetrics(
                    markets,
                    DEFAULT_AGENT_CONFIG,
                    "CHOP",
                    ctx.book.isTestnet,
                );
                return {
                    status: "observed",
                    instrumentId: item.id,
                    coverage: data.coverage,
                    bookAt: data.bookAt,
                    structure: structureView(market),
                    derived: derivedView(market),
                    execution: market.execution,
                    assumptions: {
                        preset: "Momentum Moderate",
                        regime: "CHOP sensitivity assumption",
                    },
                };
            },
        ),
        tool(
            "sentiment_snapshot",
            "Read current News Intelligence directional assessments for this exact instrument, with evidence dates, confidence, contradictions, causal mappings and source coverage. No relevant evidence is not neutral sentiment; expired or ambiguous signals are excluded.",
            object({ instrumentId: str }),
            async (a) => deskNewsSentiment(await catalog(a.instrumentId), await ctx.instruments()),
        ),
        tool(
            "historical_move_study",
            "Bound plausible price sensitivities from non-overlapping historical candle outcomes after a stated move. Requires at least 20 complete samples; does not assign scenario probabilities or forecast value. Use with technical_analysis and transaction_cost to investigate unknown magnitude.",
            object({
                instrumentId: str,
                historyHours: { type: "integer", minimum: 6, maximum: 168 },
                horizonMinutes: { type: "integer", minimum: 5, maximum: 240 },
                lookbackMinutes: { type: "integer", minimum: 1, maximum: 240 },
                direction: { type: "string", enum: ["any", "up", "down"] },
                minimumMoveBps: { type: "number", minimum: 0, maximum: 10000 },
            }),
            async (a, c) => {
                const item = await catalog(a.instrumentId),
                    rows = await candles(item, Number(a.historyHours));
                const study = historicalMoveStudy(
                    rows.candles, Number(a.horizonMinutes), Number(a.lookbackMinutes),
                    a.direction as "any" | "up" | "down", Number(a.minimumMoveBps),
                );
                const followUp = study.status === "insufficient_sample"
                    ? await queueEvidenceFollowup(prisma, ctx.book, c, { ...a, instrumentId: item.id }, study)
                    : null;
                return { instrumentId: item.id, ...study, followUp };
            },
        ),
        tool(
            "opportunity_diagnostics",
            "Read this desk book's proposals, research and observed outcome records for an exact instrument. These are dated evidence, not live approval or hypothetical-fill P&L.",
            object({ instrumentId: str }),
            async (a) => {
                const item = await catalog(a.instrumentId);
                const records = await prisma.deskRecord.findMany({
                    where: {
                        bookId: ctx.book.id,
                        kind: { in: ["trade_proposal", "proposal", "proposal_review", "pass_review", "tool_result", "research_result", "research_disposition"] },
                        dataJson: { contains: item.id },
                    },
                    orderBy: { id: "desc" }, take: 12,
                });
                const rows = records.filter(r => r.dataJson.includes(item.id)).slice(0, 12).map(r => ({
                    id: r.id, kind: r.kind, role: r.role, observedAt: r.createdAt, evidence: JSON.parse(r.dataJson),
                }));
                return {
                    instrumentId: item.id,
                    status: rows.length ? "historical" : "unavailable",
                    observations: rows,
                };
            },
        ),
        ...deskBacktestTools(ctx.book, ctx.instrument),
    ];
}
