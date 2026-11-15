import { candidateComparisonSchema, reviewCandidateComparison, type CandidateComparison } from "./candidate-comparison";
import { missedFillReview, boundedRecoveryOrder, recoverySuffix } from "./missed-fill";
import { workLedgerTools } from "./work-ledger";
import { EXECUTABLE_STRATEGIES } from "./decision-policy";
import { preflightResearchRequest } from "./backtest/jobs";
import { assessNewsMomentum, NEWS_STRATEGY_PROFILE } from "./news-strategy";
import { historicalCandles } from "./candle-history";
import type { RevisionDetails, DeskNewsWake } from "@/lib/news/desk-routing";
import { technicalWatchSchema, validateTechnicalWatch } from "./technical-watches";
import { FundingReadGate, fundingPurpose } from "./funding-gate";
import { deskModelJson } from "./runtime";
import { sizeSwingRisk } from "./risk-sizing";
import { bandLiquidity } from "./liquidity";
import { pendingOrderExposure } from "./pending-exposure";
import { parseDeskMandate, bookRiskContext, DIRECTIONAL_HOST_LIMITS, LEGACY_SIZING_DEFAULTS } from "./mandate";
import "server-only";
import { requestWatch } from "./routine-work";
import { journalTransaction, reserveBacktestRun } from "./journal";
import { assessScenarios, repriceScenarios, scenarioAssessmentSchema, type ScenarioAssessment } from "./assessment";
import { createHash } from "crypto";
import { journalResult, saveDeskArtifact } from "./artifacts";
import type { DeskBook, DeskShift } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hyperliquidInfoUrl } from "@/lib/hyperliquid-info";
import { hyperliquidInfoPost } from "@/lib/rate-limit/hyperliquid-limiter";
import { deskFundingSnapshot, deskFundingHistory, fundingMetrics, spotBasisCandidates } from "./derivatives";
import { deskNewsMarketContext } from "@/lib/news/market-observation";
import { deskEventHistory } from "@/lib/news/desk-events";
import { NewsIntelligenceService } from "@/services/NewsIntelligenceService";
import { newsDb } from "@/lib/news-db";
import { newsAccountAddress } from "@/lib/news/account";
import { record, queueWake } from "./books";
import { listInstruments } from "./instruments";
import { accountExposure, instrument, publicQuote } from "./market";
import { readProtectionStatus } from "./protection-status";
import { portfolioContext } from "./portfolio-context";
import { allocationContext } from "./allocation-context";
import { portfolioFingerprint } from "./portfolio-coverage";
import { portfolioChoiceSchema, reviewPortfolioChoice, portfolioScenarioSchema, comparePortfolioScenarios, holdingPriceSensitivity, type PriceFacts, type PortfolioChoice, type PortfolioScenarioInput } from "./portfolio-choice";
import { reconcilePriceEvidence, type DecisionLevel } from "./price-evidence";
import { ShiftObservationBoard, ShiftReads, timeOf } from "./read-cache";
import { bookPublicCache } from "./public-cache";
import {
    withDeskExecutionAuthority,
    reviseDeskProtection,
    previewDeskOrder,
    executeDeskOrder,
    cancelDeskOrder,
    executeDeskPair,
    deskExecutionState,
    configureDeskQuotes,
} from "./execution";
import { instrumentResearchTopic, publicObservation, publicResearchTools, verifiedPrimarySource } from "./research";
import type { DeskTool } from "./roundtable";
import { quantitativeTools } from "./analytics";

type Args = Record<string, unknown>;
const string = { type: "string" },
    positive = { type: "number", exclusiveMinimum: 0 },
    side = { enum: ["buy", "sell"], type: "string" };
function obj(properties: Args, required: string[] = Object.keys(properties)) {
    return { type: "object", properties, required, additionalProperties: false };
}
function word(value: unknown, limit = 500): string {
    if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("Invalid text field.");
    return value.trim();
}
function fixedId(value: string) {
    return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
const orderSchema = { ...obj(
    {
        instrumentId: string,
        side,
        quantity: positive,
        limitPrice: positive,
        reduceOnly: { type: "boolean" },
        stopPrice: positive,
        takeProfitPrice: positive,
        thesis: string,
        strategyVersion:{type:"string",enum:[...EXECUTABLE_STRATEGIES]},
        proposalKey:{type:"string",pattern:"^[a-z0-9][a-z0-9_-]{0,79}$"},
        maxHoldHours:{type:"number",minimum:2,maximum:48},
        entryExpiresAt:{type:"string"},
        eventId: {
            type: "string",
            description: "Canonical news eventKey if the thesis originates from an event in news_history.",
        },
    },
    ["instrumentId", "side", "quantity", "limitPrice", "thesis"],
), allOf: [{ if: { required: ["strategyVersion"] }, then: { required: ["proposalKey", "maxHoldHours", "entryExpiresAt"] } }] };
const workOrderSchema = { ...obj({ ...orderSchema.properties, ticket: string }, [...orderSchema.required, "ticket"]), allOf: orderSchema.allOf };
const previewOrderSchema = { ...orderSchema, properties: { ...orderSchema.properties,
    ticket: { type: "string", minLength: 1, maxLength: 80, description: "Optional work_order reference; ignored by this read-only preview. It never submits or reserves an order." } } };
type Order = Parameters<typeof executeDeskOrder>[2];
function parseOrder(args: Args): Order {
    if (!["buy", "sell"].includes(String(args.side))) throw new Error("Choose buy or sell.");
    if (args.strategyVersion !== undefined) {
        for (const field of ["proposalKey", "entryExpiresAt"] as const) {
            if (typeof args[field] !== "string" || !args[field].trim())
                throw new Error(`Strategy ticket requires ${field}; read trade_plan and supply the current saved setup. No expiry is inferred or renewed.`);
        }
        if (typeof args.maxHoldHours !== "number" || !Number.isFinite(args.maxHoldHours))
            throw new Error("Strategy ticket requires numeric maxHoldHours from the current saved setup.");
    }
    const thesis = word(args.thesis, 1200);
    return {
        instrumentId: word(args.instrumentId),
        side: args.side as Order["side"],
        quantity: Number(args.quantity),
        limitPrice: Number(args.limitPrice),
        thesis,
        ...(args.reduceOnly === true ? { reduceOnly: true } : {}),
        ...(args.stopPrice !== undefined ? { stopPrice: Number(args.stopPrice) } : {}),
        ...(args.takeProfitPrice !== undefined ? { takeProfitPrice: Number(args.takeProfitPrice) } : {}),
        ...(args.strategyVersion?{strategyVersion:word(args.strategyVersion),proposalKey:word(args.proposalKey),maxHoldHours:Number(args.maxHoldHours),entryExpiresAt:word(args.entryExpiresAt)}:{}),
        ...(args.eventId ? { eventId: word(args.eventId) } : {}),
    };
}
function future(value: unknown) {
    const date = new Date(word(value));
    if (!Number.isFinite(+date) || +date <= Date.now() || +date > Date.now() + 90 * 86400000)
        throw new Error("Deadline must fall within the next 90 days.");
    return date;
}

export function deskTools(
    book: DeskBook,
    shift: DeskShift,
    marketContextId?: string,
): DeskTool[] & { sharedObservations: () => Promise<Record<string, unknown>[]> } {
    const net = book.isTestnet;
    const get = (
        name: string,
        description: string,
        schema: ReturnType<typeof obj>,
        run: DeskTool["run"],
        access: DeskTool["access"] = "read",
    ): DeskTool => ({ name, description, inputSchema: schema, access, run });
    const reads = new ShiftReads();
    const board = new ShiftObservationBoard();
    const priceFacts = new Map<string, PriceFacts>();
    const ticketOrder = async (args: Args): Promise<Order> => {
        if (args.strategyVersion !== undefined || args.reduceOnly === true || args.proposalKey === undefined)
            return parseOrder(args);
        // Recover only the identity of the exact saved plan. Never infer price,
        // size, protection, holding horizon or a new entry deadline.
        const row = await prisma.deskRecord.findUnique({ where: { bookId_key: {
            bookId: book.id, key: `proposal:${book.version}:live:${word(args.proposalKey, 80)}` } } });
        const p = row ? JSON.parse(row.dataJson) : null;
        const version = p?.setup?.strategyVersion;
        if (!p || !["candidate", "active"].includes(p.status) || !EXECUTABLE_STRATEGIES.includes(version) ||
            !p.legs?.some((leg: { instrumentId: string }) => leg.instrumentId === args.instrumentId) ||
            !(Date.parse(p.validUntil) > Date.now()) || !(Date.parse(p.setup.entryExpiresAt) > Date.now()))
            throw new Error("Missing strategyVersion: read the current active trade_plan. No valid saved strategy identity can be recovered for this instrument.");
        return parseOrder({ ...args, strategyVersion: version });
    };
    const fundingGate = new FundingReadGate(prisma,book,shift.mode);
    const publicCache = bookPublicCache(prisma, book, shift);
    const instruments = async (scope: "all" | "perp" = "all") =>
        (await reads.read("instrument-directory:" + scope, 60_000, () => listInstruments(net, scope))).value;
    const readInstrument = async (id: unknown) => {
        const found = (await instruments(typeof id === "string" && id.includes(":perp:") ? "perp" : "all")).find((i) => i.id === id);
        if (!found) throw new Error("Instrument is unavailable on this network");
        return found;
    };
    // Share one venue snapshot across the order book, cost, basis and history views. The
    // venue timestamp bounds its lifetime even if the underlying feed served an older book.
    const observedQuote = async (item: Awaited<ReturnType<typeof instrument>>) => {
        const observed = await reads.read(
            "l2:" + item.id,
            3_000,
            () => publicQuote(item, net, true),
            (q) => q.time + 5_000,
        );
        const q = observed.value;
        const priceEvidenceId = `${item.id}@${q.time}:${q.bid}:${q.ask}`;
        if (q.bid > 0 && q.ask >= q.bid && Number.isFinite(q.bid + q.ask + q.time) && q.time <= Date.now() + 1000 && Date.now() - q.time <= 5000) {
            priceFacts.set(priceEvidenceId, { instrumentId: item.id, bid: q.bid, ask: q.ask, time: q.time });
            if (priceFacts.size > 100) priceFacts.delete(priceFacts.keys().next().value!);
        }
        const liquidity=bandLiquidity({time:q.time,levels:[q.bids,q.asks]},parseDeskMandate(book.mandateJson),item.quote==="USDC"?1:undefined);
        board.publish("l2:" + item.id, observed.expiresAt, {
            tool: "order_book",
            priceEvidenceId,
            instrumentId: item.id,
            at: new Date(q.time).toISOString(),
            validUntil: new Date(observed.expiresAt).toISOString(),
            bid: q.bid,
            ask: q.ask,
            spreadBps: q.spreadBps,
            liquidity,
        });
        return { ...q, priceEvidenceId, liquidity, observation: timeOf(observed) };
    };
    const observedFees = () =>
        reads.read("user-fees", 60_000, async () => {
            const resp = await fetch(hyperliquidInfoUrl(net), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "userFees", user: book.accountAddress }),
                signal: AbortSignal.timeout(5000),
                cache: "no-store",
            });
            if (!resp.ok) throw new Error("Fee schedule unavailable");
            return (await resp.json()) as { userSpotCrossRate?: string; userCrossRate?: string };
        });
    const deskState = async () => {
        const [s, protection, portfolio] = await Promise.all([deskExecutionState(book.id), readProtectionStatus(prisma, book), portfolioContext(prisma, book)]);
        return {
            riskPolicy: bookRiskContext(book),
            protection,
            portfolio,
            inventory: s.inventory.map((p) => ({
                instrumentId: p.instrumentId,
                quantity: p.quantity,
                basis: p.basis,
                suspended: p.suspended,
                stopPrice: p.stopPrice, targetPrice: p.targetPrice, openedAt: p.since,
            })),
            orders: s.intents.slice(0, 32).map((o) => ({
                id: o.id,
                instrumentId: o.instrumentId,
                side: o.side,
                state: o.state,
                quantity: o.quantity,
                filled: o.filledQty,
                price: o.limitPrice,
            })),
            fills: s.fills.slice(0, 24).map((f) => ({
                instrumentId: f.instrumentId,
                quantity: f.quantity,
                price: f.price,
                fee: f.feeUsd,
                pnl: f.pnlUsd,
                at: f.occurredAt,
            })),
            performance: s.metrics && {
                net: s.metrics.netPnlUsd,
                unrealized: s.metrics.unrealizedUsd,
                drawdown: s.metrics.drawdownUsd,
            },
        };
    };
    const result: DeskTool[] = [
        ...workLedgerTools(prisma,book,shift),
        get("news_strategy_context", "Assess the unactivated news-momentum-1 candidate against the latest material event revision, a current exact primary-source read, original arrival quote and closed 5m breakout. Host-sourced data only. Records an assessment, never grants entry permission; old events, relays and unbound source claims fail closed.",
            obj({ eventKey: string, instrumentId: string, evidenceId: string, side }), async (a, c) => {
                const item = await readInstrument(a.instrumentId);
                if (item.kind !== "perp" || !["buy", "sell"].includes(String(a.side))) throw new Error("Choose a native perpetual and side");
                const eventKey = word(a.eventKey, 180);
                const row = await newsDb.newsEventRevision.findFirst({ where: { ownerAddress: newsAccountAddress(), eventKey, material: true }, orderBy: { id: "desc" } });
                if (!row) return { status: "blocked", executionAuthorized: false, blockers: ["event_revision_unavailable"], profile: NEWS_STRATEGY_PROFILE };
                const details = JSON.parse(row.detailsJson) as RevisionDetails;
                const wake = await prisma.deskWake.findUnique({ where: { bookId_key: { bookId: book.id, key: `news:${row.id}` } } });
                const delivered = wake ? JSON.parse(wake.payload) as DeskNewsWake & { arrivalQuotes?: Record<string, { bid: number; ask: number; at: string }> } : null;
                const epoch = Math.min(Date.parse(details.firstSeenAt), details.publishedAt ? Date.parse(details.publishedAt) : Infinity);
                if (!Number.isFinite(epoch) || Date.now() - epoch > NEWS_STRATEGY_PROFILE.maxEventAgeMs)
                    return { status: "blocked", executionAuthorized: false, blockers: ["event_window_expired_or_unknown"], eventKey, revisionId: row.id, profile: NEWS_STRATEGY_PROFILE };
                const topic = instrumentResearchTopic(item);
                const primary = await verifiedPrimarySource(publicCache, topic, word(a.evidenceId, 100));
                if (!primary || !details.origins.some(o => o.public && o.basis === "official_notice" && o.url === primary.source.url))
                    return { status: "blocked", executionAuthorized: false,
                        blockers: [primary ? "primary_source_not_bound_to_event" : "current_primary_read_required"],
                        eventKey, revisionId: row.id, profile: NEWS_STRATEGY_PROFILE };
                const at = Date.now(), end = Math.floor(at / 300_000) * 300_000;
                const history = await historicalCandles(item.coin, "5m", end - 3 * 300_000, end, net, c.signal);
                // Fetch the quote last: a candle request must not age an execution quote.
                const quote = await publicQuote(item, net);
                const latest = await newsDb.newsEventRevision.findFirst({ where: { ownerAddress: newsAccountAddress(), eventKey, material: true }, orderBy: { id: "desc" }, select: { id: true } });
                if (latest?.id !== row.id || primary && await publicCache.revision(topic) !== primary.revision)
                    return { status: "blocked", executionAuthorized: false, blockers: ["event_or_source_superseded_during_assessment"], revisionId: row.id };
                const arrival = delivered?.arrivalQuotes?.[item.id];
                const result = assessNewsMomentum({ now: Date.now(), instrumentId: item.id, side: a.side as "buy" | "sell",
                    event: { key: eventKey, revisionId: row.id, firstSeenAt: Date.parse(details.firstSeenAt),
                        publishedAt: details.publishedAt ? Date.parse(details.publishedAt) : null,
                        availableAt: +row.availableAt, expiresAt: Date.parse(details.signal.expiresAt),
                        change: details.signal.facts?.change ?? "unknown", impact: details.signal.facts?.impact ?? "unknown",
                        direction: details.signal.direction, material: details.material, contradictions: details.signal.contradictions,
                        instrumentMatched: delivered?.eventKey === eventKey && !!delivered.instrumentIds.includes(item.id),
                        primaryUrls: details.origins.filter(o => o.public && o.basis === "official_notice").map(o => o.url) },
                    primary: primary ? { url: primary.source.url, evidenceId: primary.source.evidenceId,
                        verifiedAt: Date.parse(primary.verifiedAt), expiresAt: Date.parse(primary.expiresAt) } : null,
                    arrival: arrival ? { price: (arrival.bid + arrival.ask) / 2, at: Date.parse(arrival.at) } : null,
                    quote: { bid: quote.bid, ask: quote.ask, at: quote.time }, bars: history.bars });
                return { ...result, profile: NEWS_STRATEGY_PROFILE, primaryFinding: primary?.source.finding ?? null,
                    dataCoverage: history.coverage, scope: "live_observation_not_execution_permission" };
            }),
        ...quantitativeTools({book,marketContextId,instruments,perpetuals:()=>instruments("perp"),instrument:readInstrument,quote:observedQuote,observeFundingSetup:s=>fundingGate.observeSetup(s)}),
        get("allocation_context", "Refresh local common-driver exposure and seven-day actual closed outcomes after fees/funding when openingBrief.allocationContext is missing or exposure changed. Same-side totals include pending entries. Family labels are judgments, not measured correlations or diversification. No orders or performance gate.", obj({}), () => allocationContext(prisma, book)),
        get("trade_plan","Retrieve a saved live proposal by its exact key, including expired plans outside the brief. Includes the decisionPlan and recent criteria history for evaluating the original entry test. No order authorization.",obj({proposalKey:string}),async a=>{
            const row=await prisma.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key:`proposal:${book.version}:live:${word(a.proposalKey,80)}`}}});
            if(!row)return {status:"not_found",instruction:"No saved entry permission. Evaluate a fresh idea and save a new plan; never invent an old expiry."};
            const proposal=JSON.parse(row.dataJson);
            const history=await prisma.deskRecord.findMany({where:{bookId:book.id,kind:"proposal_revision",key:{startsWith:`proposal:${book.version}:live:${word(a.proposalKey,80)}:revision:`}},orderBy:{id:"desc"},take:4});
            return {status:"found",proposal,decisionHistory:history.map(r=>{const p=JSON.parse(r.dataJson);return {revision:p.revision,at:p.updatedAt,decisionPlan:p.decisionPlan??null};}),entryExpired:!proposal.setup?.entryExpiresAt||Date.parse(proposal.setup.entryExpiresAt)<=Date.now(),instruction:"Evaluate the saved sufficient evidence and invalidation before adding confirmation. Changed criteria need new material evidence. A stored plan is not order approval. Expired entries require a fresh assessment and plan."};
        }),
        get("size_swing_trade","Supply the exact intended limitPrice when known; re-size if it changes. Derive size from stop distance and conservative cost allowance under fresh collateral, existing exposure, commitments, aggregate risk and lot precision. Includes every position, no diversification credit. Returns an illustrative preview size, never submits.",obj({instrumentId:string,side,stopPrice:positive,limitPrice:positive},["instrumentId","side","stopPrice"]),async a=>{
            const i=await readInstrument(a.instrumentId);if(i.kind!=="perp")throw new Error("Native perpetual required");
            const [q,account,owned,intents]=await Promise.all([observedQuote(i),accountExposure(book),prisma.deskInventory.findMany({where:{bookId:book.id,quantity:{not:0}}}),prisma.deskIntent.findMany({where:{bookId:book.id,state:{in:["submitting","unknown","working","settling","blocked"]}}})]);
            const m=parseDeskMandate(book.mandateJson),c=account.collateral;
            const equity=c.accountMode==="unifiedAccount"?c.spotUsdcAvailable:c.perpEquityUsd;
            if(equity===null||!["unified_usdc_collateral_present","perp_equity_present_requires_order_preview"].includes(c.status))throw new Error("Usable collateral is unavailable; read account_exposure");
            let gross=0,risk=0,instrumentUsd=0;
            for(const p of account.positions){
                const value=Math.abs(Number(p.value)),quantity=Number(p.quantity),held=owned.find(o=>o.instrumentId.endsWith(":perp:"+p.coin));
                gross+=value;if(p.coin===i.coin)instrumentUsd+=value;
                const mark=quantity?value/Math.abs(quantity):0;
                risk+=held?.stopPrice&&!held.suspended?Math.max(0,(mark-held.stopPrice)*quantity)+value*(m.costAllowanceBps??LEGACY_SIZING_DEFAULTS.costAllowanceBps)/10000:value;
            }
            const positionRiskUsd=risk,pending=intents.map(r=>pendingOrderExposure(r,m.costAllowanceBps??LEGACY_SIZING_DEFAULTS.costAllowanceBps));
            const reserved=pending.reduce((n,r)=>n+r.notionalUsd,0),pendingRiskUsd=pending.reduce((n,r)=>n+r.riskUsd,0);risk+=pendingRiskUsd;
            const count=new Set([...account.positions.filter((p:{quantity:string})=>Number(p.quantity)!==0).map((p:{coin:string})=>p.coin),...intents.filter(r=>r.reservedUsd>0).map(r=>r.coin),i.coin]).size;
            if(count>(m.maxConcurrentPositions??LEGACY_SIZING_DEFAULTS.concurrentPositions))return {status:"concurrent_position_limit",quantity:0};
            const buy=a.side==="buy",entry=a.limitPrice===undefined?(buy?q.ask:q.bid):Number(a.limitPrice);
            const liquidity=q.liquidity,entryDepth=buy?liquidity.asks:liquidity.bids;
            if(entryDepth.observedDepthUsd===null)throw new Error("Quote currency USD conversion unavailable");
            if(entryDepth.status==="incomplete")return {status:"depth_data_incomplete",quantity:0,liquidity,note:"Returned depth does not establish the minimum. Obtain a fresh book/preview; do not label the instrument illiquid."};
            const depthUsd=entryDepth.observedDepthUsd!;
            const headroom = 1 - DIRECTIONAL_HOST_LIMITS.sizingHeadroomBps / 10000;
            return {...sizeSwingRisk({entry,stop:Number(a.stopPrice),side:buy?"buy":"sell",equityUsd:equity,committedUsd:gross+reserved,openRiskUsd:risk,instrumentUsd,depthUsd,szDecimals:i.szDecimals,mandate:{...m,maxRiskPerTradeUsd:m.maxRiskPerTradeUsd*headroom,maxOrderUsd:m.maxOrderUsd*headroom,maxInstrumentUsd:m.maxInstrumentUsd*headroom}}),liquidity,riskPolicy:bookRiskContext(book),sizingHeadroomBps:DIRECTIONAL_HOST_LIMITS.sizingHeadroomBps,policyRiskPerTradeUsd:m.maxRiskPerTradeUsd,entry,stop:Number(a.stopPrice),collateral:c,riskBreakdown:{positionRiskUsd,pendingRiskUsd,pendingNotionalUsd:reserved,aggregateRiskLimitUsd:m.maxOpenRiskUsd??m.maxRiskPerTradeUsd*2},observedAt:new Date(q.time).toISOString()};
        }),
        get(
            "assess_trade_scenarios",
            "Calculate conditional outcomes for a concrete trade, plus entry sensitivity at the current quote with fixed exits. Choose scenario count and horizon for the mechanism, not a mandatory favorable/base/adverse template. Give each scenario a basis: why that level and outcome belong at this horizon and what remains an assumption. Supply decimal fee rates, signed funding and additional costs. Null probabilities do not imply a pass; this calculator neither verifies assumptions nor previews/submits orders.",
            scenarioAssessmentSchema,
            async (a) => {
                const item = await readInstrument(a.instrumentId);
                const [quote, fees] = await Promise.all([
                    observedQuote(item).catch(() => null), observedFees().catch(() => null),
                ]);
                const fee = Number(fees?.value[item.kind === "spot" ? "userSpotCrossRate" : "userCrossRate"]);
                const entry = quote ? (a.side === "buy" ? quote.ask : quote.bid) : null;
                return { ...assessScenarios(a as unknown as ScenarioAssessment),
                    currentEntrySensitivity: repriceScenarios(a as unknown as ScenarioAssessment, entry),
                    marketChecks: {
                        network: net ? "testnet" : "mainnet",
                        quote: quote ? { bid: quote.bid, ask: quote.ask, observation: quote.observation } : null,
                        observedTakerFeeRate: Number.isFinite(fee) ? fee : null,
                        feeObservation: fees ? timeOf(fees) : null,
                        suppliedEntryDistanceBps: entry ? (Number(a.entryPrice) / entry - 1) * 10000 : null,
                        suppliedEntryFeeBelowObservedTaker: Number.isFinite(fee) ? Number(a.entryFeeRate) < fee : null,
                        note: "Current top of book and taker fees are observed checks. Size impact, conditional entry, future exits, funding and scenario probabilities remain supplied assumptions. No probability calibration or execution approval is implied.",
                    },
                    quoteCurrency: item.quote, contractMultiplier: item.multiplier,
                    quantityUnit: "venue quantity; use venue prices without dividing by contractMultiplier" };
            },
        ),
        get(
            "find_instruments",
            "Find tradable instruments by exact venue identity, symbol or base name.",
            obj({ query: string }),
            async (a) => {
                const q = String(a.query ?? "").toLowerCase();
                return (await instruments())
                    .filter((x) => [x.id, x.base, x.coin].some((s) => s.toLowerCase().includes(q)))
                    .slice(0, 50);
            },
        ),
        get(
            "order_book",
            "Fresh book with host-calculated USD liquidity inside the mandate's midpoint slippage band, from all returned venue levels. Use liquidity.bids/asks totals and coverage; displayed six levels are only a preview. Shared for up to three seconds; fresh execution checks remain required.",
            obj({ instrumentId: string }),
            async (a) => {
                const item=await readInstrument(a.instrumentId),q=await observedQuote(item);
                return {...q,bids:q.bids.slice(0,6),asks:q.asks.slice(0,6),
                    displayedLevels:{purpose:"visual_preview_only",bidsTruncated:q.bids.length>6,asksTruncated:q.asks.length>6}};
            },
        ),
        get(
            "market_history",
            "OHLCV plus livePriceEvidence comparing timestamped executable bid/ask with the last completed and forming candles. Supply up to six decisionLevels to expose disagreements across a saved threshold. Completed evidence and live location must both be weighed; forming does not mean irrelevant. Choose a horizon-relevant interval. No entry veto or automatic signal.",
            obj({ instrumentId: string, since: string, interval:{type:"string",enum:["1m","5m","15m","1h"]},
                decisionLevels:{type:"array",maxItems:6,items:{type:"object",additionalProperties:false,required:["label","price"],properties:{label:{type:"string",minLength:1,maxLength:100},price:positive}}} }, ["instrumentId"]),
            async (a) => {
                const item = await readInstrument(a.instrumentId);
                const interval=String(a.interval??"1m");
                const step=({"1m":60000,"5m":300000,"15m":900000,"1h":3600000} as Record<string,number>)[interval];
                if(!step)throw new Error("Choose 1m, 5m, 15m or 1h history.");
                const since = a.since ? Date.parse(word(a.since)) : Date.now() - Math.max(3600000,24*step);
                if (!Number.isFinite(since) || since > Date.now() || since < Date.now() - 4 * 86400000)
                    throw new Error("Select an observation in the last four days.");
                const start = Math.floor(since / step) * step - step;
                const candles = await reads.read("ohlcv:" + item.id + ":" + interval + ":" + start, 15_000, async () => {
                    const sampledAt = Date.now();
                    const rows = await hyperliquidInfoPost<Array<{ t:number; T:number; o:string; h:string; l:string; c:string; v:string }>>(
                        "hl:info:candleSnapshot", hyperliquidInfoUrl(net),
                        { type:"candleSnapshot", req:{ coin:item.coin, interval, startTime:start, endTime:sampledAt } },
                        { ttlMs:0, staleMs:0, allowStale:false },
                    );
                    if (!Array.isArray(rows)) throw new Error("Candle history unavailable.");
                    return { rows, sampledAt };
                });
                const rows = candles.value.rows;
                const pre = rows.filter((c) => Number(c.T) < since).at(-1),
                    quote = await observedQuote(item);
                const holding = await prisma.deskInventory.findUnique({ where: { bookId_instrumentId: { bookId: book.id, instrumentId: item.id } } });
                return {
                    interval,
                    requestedSince:new Date(since).toISOString(),
                    returnedBars:Math.min(rows.length,90),
                    omittedEarlierBars:Math.max(0,rows.length-90),
                    note:"A completed candle records past retention; the live bid/ask may already contradict it. Forming observations are provisional, not irrelevant. Weigh these clocks explicitly against the thesis horizon without moving saved tests merely because price changed.",
                    livePriceEvidence: reconcilePriceEvidence(rows, candles.value.sampledAt, quote, a.decisionLevels as DecisionLevel[] | undefined),
                    holdingSensitivity: holding?.quantity && !holding.suspended && priceFacts.has(quote.priceEvidenceId) ? holdingPriceSensitivity(holding, quote) : null,
                    candlesObserved: timeOf(candles),
                    before: pre ?? null,
                    current: quote,
                    returnSinceBps:
                        pre && Number(pre.c) > 0 ? ((0.5 * (quote.bid + quote.ask)) / Number(pre.c) - 1) * 1e4 : null,
                    candles: rows.slice(-90).map(c=>({...c,closed:Number(c.T)<candles.value.sampledAt})),
                };
            },
        ),
        get(
            "funding_and_basis",
            "Read funding and positioning for a concrete decision. purpose=decision_research plus question allows investigation before any candle pattern or proposal. Choose includeBasis only if spot/perp pricing answers that question; it additionally fetches spot metadata and both books. Reuse fresh observations. Legacy setup_cost, carry_research and position_risk are supported.",
            obj({ instrumentId: string, purpose:fundingPurpose, question:{type:"string",minLength:10,maxLength:1000}, proposalKey:string, includeBasis:{type:"boolean"} },["instrumentId","purpose"]),
            async (a) => {
                const deferred=await fundingGate.check(String(a.instrumentId),a.purpose??"setup_cost",a.proposalKey,a.question);
                if(deferred)return deferred;
                if(a.includeBasis===true && !["carry_research","decision_research"].includes(String(a.purpose)))throw new Error("Request basis for a concrete decision_research question or documented carry research.");
                const p = await readInstrument(a.instrumentId);
                if (p.kind !== "perp") throw new Error("Select the perpetual contract.");
                const observation = await reads.read("funding", 10_000, () => deskFundingSnapshot(net));
                const meta = observation.value;
                const i = meta?.universe.findIndex((x) => x.name === p.coin) ?? -1;
                const ctx = meta?.assetCtxs[i];
                if (!ctx) throw new Error("Funding data unavailable.");
                const includeBasis=a.includeBasis===true;
                const spots = includeBasis ? spotBasisCandidates(p, await instruments()) : [];
                // Missing spot liquidity must not hide valid perpetual funding data.
                const [perpResult, spotResult] = await Promise.allSettled([
                    includeBasis ? observedQuote(p) : Promise.resolve(null),
                    spots.length === 1 ? observedQuote(spots[0]) : Promise.resolve(null),
                ]);
                const perp = perpResult.status === "fulfilled" ? perpResult.value : null;
                const spot = spotResult.status === "fulfilled" ? spotResult.value : null;
                const metrics = fundingMetrics(ctx, p.multiplier, perp, spot);
                const expires = Math.min(
                    observation.expiresAt,
                    spot ? Date.parse(spot.observation.expiresAt) : Infinity,
                    perp ? Date.parse(perp.observation.expiresAt) : Infinity,
                );
                board.publish("funding:" + p.id, expires, {
                    tool: "funding_and_basis",
                    instrumentId: p.id,
                    fundingRate: metrics.fundingRate,
                    fundingIntervalHours: 1,
                    positiveRate: "longs pay shorts",
                    shortFundingPerHourPerVenueUnit: metrics.shortFundingPerHourPerVenueUnit,
                    mark: metrics.mark,
                    oracle: metrics.oracle,
                    openInterest: metrics.openInterest,
                    contractMultiplier: p.multiplier,
                    retrievedAt: new Date(observation.observedAt).toISOString(),
                    validUntil: new Date(expires).toISOString(),
                });
                return {
                    instrumentId: p.id,
                    observation: { ...timeOf(observation), expiresAt: new Date(expires).toISOString() },
                    fundingObservation: timeOf(observation),
                    ...metrics,
                    perp,
                    spot,
                    spotMatch: {
                        status: !includeBasis ? "not_requested" : spots.length === 1 ? "ticker_candidate_only" : spots.length ? "ambiguous" : "none",
                        candidates: spots.map(s => s.id),
                        limitation: "Ticker equality does not verify underlying identity, redemption, wrapper equivalence or borrow. No automatic wrapped-token aliases.",
                    },
                    quoteErrors: {
                        perp: perpResult.status === "rejected" ? "Fresh perpetual quote unavailable" : null,
                        spot: spotResult.status === "rejected" ? "Fresh spot quote unavailable" : null,
                    },
                };
            },
        ),
        get(
            "funding_history",
            "Summarize 1–72 hours of settled hourly funding for a native perp, including missing samples and sign changes. Use for a concrete carry thesis; historical persistence is not a forecast.",
            obj({ instrumentId: string, hours: { type: "integer", minimum: 1, maximum: 72 },purpose:fundingPurpose,question:{type:"string",minLength:10,maxLength:1000},proposalKey:string },["instrumentId","hours","purpose"]),
            async (a) => {
                const deferred=await fundingGate.check(String(a.instrumentId),a.purpose??"carry_research",a.proposalKey,a.question);
                if(deferred)return deferred;
                const p = await readInstrument(a.instrumentId);
                if (p.kind !== "perp") throw new Error("Select the perpetual contract.");
                const hours = Number(a.hours);
                if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw new Error("Choose 1 to 72 hours of funding history.");
                const observation = await reads.read("funding-history:" + p.id + ":" + hours, 60_000,
                    () => deskFundingHistory(net, p.coin, hours));
                return { instrumentId: p.id, observation: timeOf(observation), ...observation.value };
            },
        ),
        get(
            "account_exposure",
            "Whole account exposure and working orders; includes manual holdings that are observation-only.",
            obj({}),
            async () => {
                const exposure=(await reads.read("account-exposure",5_000,()=>accountExposure(book))).value;
                fundingGate.observePositions(exposure.positions.filter((p:{quantity:string})=>Number(p.quantity)!==0).map((p:{coin:string})=>`${net?"testnet":"mainnet"}:perp:${p.coin}`));
                return { ...exposure, protection: await readProtectionStatus(prisma, book) };
            },
        ),
        get(
            "desk_blotter",
            "Owned inventory, executable intents, recent fills, fees, performance, and timestamped native stop and local time-exit verification. Stale evidence is explicitly unverified.",
            obj({}),
            deskState,
        ),
        get(
            "transaction_cost",
            "Estimate one-way taker fees and walking available depth at the requested size; exclude unknown costs explicitly.",
            obj({ instrumentId: string, side, quantity: positive }),
            async (a) => {
                const m = await readInstrument(a.instrumentId),
                    q = await observedQuote(m);
                const levels = a.side === "buy" ? q.asks : q.bids,
                    qty = Number(a.quantity);
                let left = qty,
                    usd = 0;
                for (const level of levels) {
                    const fill = Math.min(left, Number(level.sz));
                    usd += fill * Number(level.px);
                    left -= fill;
                    if (left <= 0) break;
                }
                const fees = await observedFees().catch(() => null);
                const rate = fees?.value[m.kind === "spot" ? "userSpotCrossRate" : "userCrossRate"];
                board.publish("cost:" + m.id + ":" + a.side + ":" + qty, Date.parse(q.observation.expiresAt), {
                    tool: "transaction_cost",
                    instrumentId: m.id,
                    side: a.side,
                    quantity: qty,
                    priced: qty - left,
                    average: qty > left ? usd / (qty - left) : null,
                    takerFeeQuote: rate !== undefined ? Number(rate) * usd : null,
                    asOf: new Date(q.time).toISOString(),
                    validUntil: q.observation.expiresAt,
                });
                return {
                    observation: q.observation,
                    feeObservation: fees ? timeOf(fees) : null,
                    filledEstimate: qty - left,
                    unpricedQuantity: left,
                    average: qty > left ? usd / (qty - left) : null,
                    takerFeeUsd: rate !== undefined ? Number(rate) * usd : null,
                    spreadBps: q.spreadBps,
                    asOf: q.time,
                };
            },
        ),
        get(
            "price_since_event",
            "Compare the executable book with the pre-event price and deadline for an event revision.",
            obj({ eventKey: string, instrumentId: string }),
            async (a) => {
                const [history, item] = await Promise.all([
                    deskEventHistory(word(a.eventKey)),
                    instrument(net, a.instrumentId),
                ]);
                if (!history.length) throw new Error("No such event.");
                return deskNewsMarketContext(item, {
                    publishedAt: history[0].publishedAt,
                    deadline: history[0].signal.facts?.deadline ?? null,
                });
            },
        ),
        get(
            "news_history",
            "Inspect dated event revisions, sources and corrections.",
            obj({ eventKey: string }),
            (a) => deskEventHistory(word(a.eventKey)),
        ),
        get(
            "search_news",
            "Search captured evidence for a named asset, issuer or public event, including unlisted assets.",
            obj({ query: string }),
            async (a) => {
                const term = word(a.query, 100);
                return newsDb.newsDocument.findMany({
                    where: { ownerAddress: newsAccountAddress(), text: { contains: term, mode: "insensitive" } },
                    orderBy: { availableAt: "desc" },
                    take: 10,
                    select: { id: true, publishedAt: true, availableAt: true, source: { select: { name: true } } },
                });
            },
        ),
        get(
            "read_evidence",
            "Read original local news evidence by ID.",
            obj({ ids: { type: "array", items: string, maxItems: 8 } }),
            async (a) => {
                const docs = await new NewsIntelligenceService().evidence(
                    newsAccountAddress(),
                    (a.ids as string[]).slice(0, 8),
                );
                return docs.map((d) => ({
                    id: d.id,
                    source: d.source.name,
                    published: d.publishedAt,
                    collected: d.collectedAt,
                    text: d.text.slice(0, 2200),
                    url: d.source.isPrivate ? undefined : d.canonicalUrl,
                }));
            },
        ),
        get(
            "outcomes",
            "Recent recorded technical opportunities and forward outcomes for this account and instrument.",
            obj({ instrumentId: string }),
            async (a) => {
                const item = await instrument(net, a.instrumentId);
                const rows = await prisma.deskRecord.findMany({
                    where: { bookId: book.id, kind: { in: ["pass_review", "research_result", "proposal", "tool_result"] } },
                    take: 100, orderBy: { id: "desc" },
                });
                return rows.filter(r => r.dataJson.includes(item.id)).slice(0, 16).map(r => ({
                    id: r.id, kind: r.kind, at: r.createdAt, evidence: JSON.parse(r.dataJson),
                }));
            },
        ),
        get(
            "write_thesis",
            "Record an idea, invalidation, supporting evidence and next review.",
            obj({ thesis: string, invalidation: string, eventKey: string, reviewAt: string }, [
                "thesis",
                "invalidation",
                "reviewAt",
            ]),
            async (a, c) => {
                const thesis = word(a.thesis, 1400),
                    deadline = future(a.reviewAt),
                    invalidation = word(a.invalidation, 800);
                const key = shift.id + ":thesis:" + c.role + ":" + fixedId(thesis);
                return journalTransaction(prisma, book, shift, c.signal, async (tx) => {
                    const scheduled = await requestWatch(tx, book, shift, c.role, {
                        kind: "review",
                        thesis,
                        deadline,
                        eventKey: a.eventKey ? word(a.eventKey) : null,
                    });
                    await record(tx, book.id, shift.id, key, "thesis", c.role, {
                        thesis,
                        invalidation,
                        eventKey: a.eventKey,
                        reviewAt: scheduled.deadline ?? null,
                        watchId: scheduled.watchId,
                    });
                    return scheduled;
                });
            },
            "journal",
        ),
        get(
            "set_watch",
            "Schedule a review, executable-price alert, or track a passed idea. Use kind=technical with side, instrumentId and technical={intervalSeconds:300|900|3600,condition:alignment|resumption,minTrendBps} to monitor a future closed-bar transition; it wakes one review and never orders. Do not encode technical reopening as material_news. thesis must be 1-1000 characters; deadline is a future ISO timestamp. A pass needs instrumentId and side. passBasis/previewReceipt/revisitWhen apply only to live lead passes. Save update_trade_proposal and await its receipt BEFORE linking proposalKey here, in the same mode. Closed passes without keepAfterClosure become outcome-only; a distinct reopening condition needs explicit keepAfterClosure=true. not_scheduled means nothing was registered; satisfy its prerequisite before retrying. Same conditions reuse an ID regardless of wording. read_desk_work lists current IDs and conditions; manage_watch amends/cancels/supersedes. Confirm watchId in the receipt.",
            obj(
                {
                    kind: { enum: ["review", "above", "below", "pass", "technical"] },
                    technical:technicalWatchSchema,
                    proposalKey:{type:"string",pattern:"^[a-z0-9][a-z0-9_-]{0,79}$",description:"Link the saved idea this condition monitors."},
                    keepAfterClosure:{type:"boolean",description:"True only for a distinct fresh-assessment trigger that should survive closing this proposal; explain it in thesis."},
                    instrumentId: string,
                    thesis: {type:"string",minLength:1,maxLength:1000,description:"Concise decision and reopening condition, at most 1000 characters. Keep the full analysis in the journal."},
                    deadline: string,
                    threshold: positive,
                    passBasis: { enum: ["independent_reason", "after_preview"], description: "Required for live directional lead passes. Explain the decisive reason in thesis." },
                    previewReceipt: { type: "string", description: "Receipt returned by this shift's lead preview of the proposed order (success or error)." },
                    revisitWhen: { enum: ["bid_depth", "ask_depth", "both_depth", "material_news"], description: "Live lead pass only. Revisit on material news or when the specified side(s) reach mandate depth inside the slippage band." },
                    side,
                    eventKey: string,
                },
                ["kind", "thesis", "deadline"],
            ),
            async (a, c) => {
                const kind = String(a.kind),
                    thesis = word(a.thesis, 1000),
                    deadline = future(a.deadline);
                const m = a.instrumentId ? await instrument(net, a.instrumentId) : null;
                if (kind !== "review" && !m) throw new Error("Select a tradable instrument.");
                const threshold = a.threshold === undefined ? null : Number(a.threshold);
                if ((kind === "below" || kind === "above") && !(threshold && threshold > 0))
                    throw new Error("Specify a positive price threshold.");
                if (["pass","technical"].includes(kind) && !["buy", "sell"].includes(String(a.side)))
                    throw new Error("Specify the side of the passed idea.");
                if (a.revisitWhen !== undefined && (kind !== "pass" || c.role !== "lead" || shift.mode !== "live" ||
                    !["bid_depth", "ask_depth", "both_depth", "material_news"].includes(String(a.revisitWhen)))) throw new Error("Revisit conditions require a live lead pass.");
                const technical=kind==="technical"?validateTechnicalWatch(a.technical):undefined;
                if(technical&&m?.kind!=="perp")throw new Error("Technical watches require native perpetuals.");
                if(kind!=="technical"&&a.technical!==undefined)throw new Error("Use kind=technical for a closed-bar condition.");
                const livePass = kind === "pass" && shift.mode === "live" && book.kind === "directional" && c.role === "lead";
                if (livePass && !["independent_reason", "after_preview"].includes(String(a.passBasis)))
                    throw new Error("Choose a passBasis. If only pricing is unresolved, preview the proposed ticket first.");
                let assessment: Record<string, unknown> | undefined;
                if (livePass && a.passBasis === "after_preview") {
                    const receipt = word(a.previewReceipt, 200);
                    const key = shift.id + ":lead:" + receipt;
                    const rows = await prisma.deskRecord.findMany({
                        where: { bookId: book.id, shiftId: shift.id, role: "lead", key: { in: [key, key + ":result"] } },
                    });
                    const request = rows.find(row => row.kind === "tool" && row.key === key);
                    const response = rows.find(row => row.kind === "tool_result" && row.key === key + ":result");
                    const ticket = request && JSON.parse(request.dataJson);
                    const result = response && JSON.parse(response.dataJson);
                    if (ticket?.name !== "preview_order" || result?.name !== "preview_order" ||
                        ticket.args.instrumentId !== m?.id || ticket.args.side !== a.side)
                        throw new Error("Expected a completed lead preview for this instrument and side in this shift.");
                    assessment = { passBasis: a.passBasis, previewReceipt: key, previewAt: response!.createdAt,
                        ...(result.error ? { previewError: result.error } : { preview: JSON.parse(result.result) }) };
                } else if (livePass) {
                    if (a.previewReceipt !== undefined) throw new Error("Use after_preview to cite a preview receipt.");
                    assessment = { passBasis: a.passBasis };
                }
                type Arrival = { bid: number; ask: number; at: string; observedAt: string };
                const triggers = JSON.parse(shift.briefJson).triggers as {
                    payload?: { eventKey?: string; arrivalQuotes?: Record<string, Arrival> };
                }[];
                const first =
                    m && a.eventKey
                        ? triggers.find((t) => t.payload?.eventKey === a.eventKey && t.payload?.arrivalQuotes?.[m.id])
                              ?.payload?.arrivalQuotes?.[m.id]
                        : null;
                const quote = kind === "pass" && m ? (first ?? (await publicQuote(m, net).catch(error => {
                    if (assessment?.previewReceipt) return null;
                    throw error;
                }))) : null;
                const watch = await journalTransaction(prisma, book, shift, c.signal, (tx) =>
                    requestWatch(tx, book, shift, c.role, {
                        kind,
                        thesis,
                        ...(a.proposalKey?{proposalKey:String(a.proposalKey)}:{}),
                        ...(a.keepAfterClosure!==undefined?{keepAfterClosure:!!a.keepAfterClosure}:{}),
                        eventKey: a.eventKey ? word(a.eventKey) : null,
                        instrumentId: m?.id,
                        side: a.side ? String(a.side) : null,
                        outcomeJson: technical ? JSON.stringify({technical}) : quote
                            ? JSON.stringify({
                                  ...assessment,
                                  ...(a.revisitWhen ? { revisitWhen: a.revisitWhen } : {}),
                                  referenceAt: "at" in quote ? quote.at : new Date(quote.time).toISOString(),
                                  referenceSource: first ? "first observed book after event" : "book at pass decision",
                              })
                            : assessment ? JSON.stringify({ ...assessment, revisitWhen: a.revisitWhen, coverage: "No executable pass reference" }) : null,
                        referencePrice: quote ? (a.side === "buy" ? quote.ask : quote.bid) : null,
                        threshold,
                        deadline,
                    }),
                );
                return assessment ? { ...watch, ...assessment, decisionReason: thesis } : watch;
            },
            "journal",
        ),
        get(
            "assess_portfolio_choices",
            "Compare holding an OWNED native USDC perp, exiting to cash and an optional replacement on the SAME forward horizon. Uses current owned quantity, walked quotes and fee schedule; excludes sunk entry PnL/fees. Supply 2-4 conditional scenarios with executable future exits and explicit signed funding/additional costs; probabilities may all be null. Candidate quantity is hypothetical, not sized/approved. Respect original deadlines (earlier exit then cash). Returns no winner, orders or replacement permission.",
            portfolioScenarioSchema,
            async a => {
                const input = a as unknown as PortfolioScenarioInput;
                if (input.candidateInstrumentId === input.holdingInstrumentId) throw new Error("Choose a distinct replacement or null candidate.");
                const context = await portfolioContext(prisma, book);
                const held = context.holdings.find(p => p.instrumentId === input.holdingInstrumentId);
                if (!held?.quantity || held.suspended || !context.reconciledRecently) return { status: "reconciliation_required", executionAuthorized: false, portfolio: context };
                const holding = await readInstrument(input.holdingInstrumentId);
                const candidate = input.candidateInstrumentId ? await readInstrument(input.candidateInstrumentId) : null;
                if ([holding, ...(candidate ? [candidate] : [])].some(i => i.kind !== "perp" || i.quote !== "USDC")) throw new Error("Comparison requires native USDC perpetuals.");
                const [hq, cq, fees] = await Promise.all([observedQuote(holding), candidate ? observedQuote(candidate) : null, observedFees().catch(() => null)]);
                const current = await prisma.deskInventory.findUnique({ where: { bookId_instrumentId: { bookId: book.id, instrumentId: holding.id } } });
                if (!current || current.suspended || current.quantity !== held.quantity || current.since.toISOString() !== held.openedAt) return { status: "position_changed", executionAuthorized: false, instruction: "Refresh the comparison; owned exposure changed during observation." };
                const fee = fees ? Number(fees.value.userCrossRate) : NaN;
                const result = { ...comparePortfolioScenarios(input, held.quantity, hq, cq, Number.isFinite(fee) ? fee : null),
                    evidenceIds: input.evidenceIds, assumptions: input.assumptions, portfolio: context,
                    holdingQuoteAt: new Date(hq.time).toISOString(), candidateQuoteAt: cq ? new Date(cq.time).toISOString() : null,
                    originalDeadlineWithinHorizon: held.remainingHours !== null && input.horizonHours > held.remainingHours,
                    deadlineInstruction: "If the original exit falls within this horizon, use a holding exit at that deadline and cash thereafter. This calculator cannot extend it or predict a stop fill." };
                const fingerprint = portfolioFingerprint(context);
                if (result.outcomes && fingerprint) board.publish("portfolio-calculation:" + input.holdingInstrumentId,
                    Math.min(Date.now() + Math.min(book.frequencySeconds * 1000, 300_000), held.originalExitDeadline ? Date.parse(held.originalExitDeadline) : Infinity), {
                        tool: "assess_portfolio_choices", holdingInstrumentId: input.holdingInstrumentId,
                        candidateInstrumentId: input.candidateInstrumentId, quoteObservedAt: result.holdingQuoteAt,
                        quantity: held.quantity, horizonHours: input.horizonHours, exitVwap: result.currentCosts?.exitVwap,
                        assumptions: input.assumptions.slice(0, 200), historical: true, executionAuthorized: false,
                        outcomes: result.outcomes.map(s => ({ label: s.label, basis: s.basis.slice(0, 120), holdingExitPrice: s.holdingExitPrice,
                            holdingFundingUsd: s.holdingFundingUsd, holdingOtherCostsUsd: s.holdingOtherCostsUsd,
                            candidateExitPrice: s.candidateExitPrice, probability: s.probability,
                            holdMinusCashUsd: s.holdMinusCashUsd, rotateMinusHoldUsd: s.rotateMinusHoldUsd })),
                        instruction: "Dated calculation already completed this shift, not a fresh quote or trade permission. Reuse its arithmetic and assumptions unless changed prices, costs, evidence, exposure or horizon could change the decision. Do not rerun solely because another role is speaking. Numerical claims retain their original timestamp.",
                    }, async () => portfolioFingerprint(await portfolioContext(prisma, book, Date.now(), false)) === fingerprint);
                return result;
            },
        ),
        get(
            "record_portfolio_comparison",
            "Journal one holding per call, keyed separately within this shift. Compare hold / exit-to-cash / rotate on equal forward terms with forwardCase, a common remaining horizon, costs, contrary evidence and checked priceClaims from the observed priceEvidenceId. No candidate is required: mark rotation unavailable with a reason. Hold, cash and unresolved are valid. This journal never gates urgent protection or authorizes orders.",
            portfolioChoiceSchema,
            async (a, c) => {
                const comparison = a as unknown as PortfolioChoice;
                const context = await portfolioContext(prisma, book);
                if (!context.holdings.some(p => p.instrumentId === comparison.holdingInstrumentId))
                    return {recorded:false,portfolioRecorded:false,status:"no_owned_holding",
                        instruction:"No nonzero owned holding exists. Do not repeat this comparison or submit another exit. Reconciliation issues are host work; assess new candidates against cash without portfolioChoice."};
                const review = reviewPortfolioChoice(comparison, priceFacts.get(comparison.priceEvidenceId ?? ""));
                await journalTransaction(prisma, book, shift, c.signal, tx => record(tx, book.id, shift.id,
                    "portfolio-comparison:" + shift.id + ":" + c.role + ":" + comparison.holdingInstrumentId, "portfolio_comparison", c.role,
                    { ...comparison, bookVersion: book.version, portfolio: context, mode: shift.mode, review, at: new Date().toISOString() }));
                return { ...review, portfolioRecorded: true, holdingInstrumentId: comparison.holdingInstrumentId };
            }, "journal",
        ),
        get(
            "record_candidate_comparison",
            "Save this shift's comparison of up to four candidates. If a candidate could change an existing allocation, include portfolioChoice comparing hold, cash and rotation or use record_portfolio_comparison. A passed unrelated candidate does not require rewriting unchanged holdings; cite their recent assessment. preferredInstrumentId=null means no new candidate, not liquidation. Cite evidence and explain limited coverage; no trade quota or order authority.",
            candidateComparisonSchema,
            async (a, c) => {
                let comparison = a as unknown as CandidateComparison;
                const context = comparison.portfolioChoice ? await portfolioContext(prisma, book) : null;
                const closedHolding = comparison.portfolioChoice && !context?.holdings.some(p => p.instrumentId === comparison.portfolioChoice!.holdingInstrumentId);
                if (closedHolding) { const { portfolioChoice: _, ...candidatesOnly } = comparison; comparison = candidatesOnly; }
                const facts = priceFacts.get(comparison.portfolioChoice?.priceEvidenceId ?? "");
                const review = reviewCandidateComparison(comparison, facts);
                await journalTransaction(prisma, book, shift, c.signal, async tx => {
                    await record(tx, book.id, shift.id, "candidate-comparison:" + shift.id + ":" + c.role,
                        "candidate_comparison", c.role, { ...comparison, mode: shift.mode, review, at: new Date().toISOString() });
                    if (comparison.portfolioChoice) await record(tx, book.id, shift.id, "portfolio-comparison:" + shift.id + ":" + c.role + ":" + comparison.portfolioChoice.holdingInstrumentId,
                        "portfolio_comparison", c.role, { ...comparison.portfolioChoice, bookVersion: book.version, review: reviewPortfolioChoice(comparison.portfolioChoice, facts), portfolio: context, mode: shift.mode, at: new Date().toISOString() });
                });
                return { recorded: true, portfolioRecorded: !!comparison.portfolioChoice, holdingInstrumentId: comparison.portfolioChoice?.holdingInstrumentId,
                    ...(closedHolding ? {portfolioSkipped:"No nonzero owned holding. Candidate comparison saved; do not repeat a closed-position comparison."} : {}), ...review };
            },
            "journal",
        ),
        get(
            "preview_order",
            "Check a concrete ticket against fresh venue data and the effective mandate. Accepts work_order fields; ticket is optional and ignored. Include strategyVersion, proposalKey, maxHoldHours and entryExpiresAt from the saved setup. An omitted strategyVersion alone can be recovered from that exact current active proposal; no horizon or expiry is inferred. Returns a previewReceipt, not a fill guarantee. Never signs, submits or reserves.",
            previewOrderSchema,
            async (a, c) => {
                const order = await ticketOrder(a);
                for (let attempt = 0; ; attempt++) {
                    if (c.signal.aborted) throw new Error("Shift cancelled.");
                    try { return { ...(await previewDeskOrder(book.id, order)), previewReceipt: c.callId }; }
                    catch (e) {
                        if (attempt >= 2 || !(e instanceof Error) || !e.message.includes("Desk execution busy")) throw e;
                        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                    }
                }
            },
        ),
        get(
            "work_order",
            "Place a live order at the specified price and within the book mandate. New discretionary entries require the saved decisionPlan.allocation payoff, event action and joint theme review to match this ticket. Use the same ticket on retry.",
            workOrderSchema,
            async (a) => {
                const order = await ticketOrder(a);
                if (order.eventId && !(await deskEventHistory(order.eventId)).length)
                    throw new Error("Unknown event key. Inspect news_history for a recorded event.");
                const result = await executeDeskOrder(book.id, shift.id + ":" + word(a.ticket, 80), order);
                const recovery = missedFillReview(result);
                if (recovery.eligible) await queueWake(prisma, book, "missed-fill:" + result.id,
                    "missed_fill", "live", recovery, 8, new Date(Date.now() + 5000), new Date(order.entryExpiresAt!));
                return { ...result, executionRecovery: recovery };
            },
            "lead",
        ),
        get(
            "recover_missed_fill",
            "One bounded recovery of a confirmed zero-fill unmatched IOC. First reassess and save the current decision, then size using the intended price. Supply the original intentId, no larger quantity and a same-or-better limit. Host preserves original stop, target, holding window and expiry, performs a fresh preview and execution checks, and uses a stable recovery key. No chasing, expiry renewal or recovery chains.",
            obj({ intentId: string, quantity: positive, limitPrice: positive, reassessment: { type: "string", minLength: 20, maxLength: 1200 } }),
            async (a) => {
                const intent = await prisma.deskIntent.findUnique({ where: { id: word(a.intentId) } });
                if (!intent || intent.bookId !== book.id || intent.policyVersion !== book.version)
                    throw new Error("Original intent must belong to this book and mandate version.");
                word(a.reassessment, 1200);
                const key = intent.intentKey + recoverySuffix;
                const prior = await prisma.deskIntent.findUnique({ where: { bookId_intentKey: { bookId: book.id, intentKey: key } } });
                if (prior) return { ...prior, reused: true, executionRecovery: missedFillReview(prior) };
                const order = boundedRecoveryOrder(intent, Number(a.quantity), Number(a.limitPrice));
                await previewDeskOrder(book.id, order);
                const result = await executeDeskOrder(book.id, key, order);
                return { ...result, executionRecovery: missedFillReview(result) };
            },
            "lead",
        ),
        get(
            "revise_protection",
            "Revise the risk controls on an owned position within the book mandate.",
            obj({ instrumentId: string, stopPrice: positive, takeProfitPrice: positive }, [
                "instrumentId",
                "stopPrice",
            ]),
            (a) =>
                reviseDeskProtection(
                    book.id,
                    word(a.instrumentId),
                    Number(a.stopPrice),
                    a.takeProfitPrice === undefined ? undefined : Number(a.takeProfitPrice),
                ),
            "lead",
        ),
        get(
            "delegate_execution",
            "Give the execution trader an expiring, single-use order ticket at a maximum quantity and a bounded price.",
            obj({ ticket: string, order: orderSchema, deadline: string }),
            async (a, c) => {
                const order = parseOrder(a.order as Args),
                    deadline = future(a.deadline);
                const preview = await previewDeskOrder(book.id, order);
                const ticket = shift.id + ":" + word(a.ticket, 64);
                const data = { ticket, order, deadline: deadline.toISOString(), version: book.version };
                const stored = await prisma.$transaction(async (tx) => {
                    const r = await record(tx, book.id, shift.id, "delegation:" + ticket, "order_grant", c.role, data);
                    await queueWake(
                        tx,
                        book,
                        "work:" + ticket,
                        "order_ticket",
                        "live",
                        { ticket },
                        8,
                        new Date(),
                        deadline,
                    );
                    return JSON.parse(r.dataJson);
                });
                return { grant: stored, preview };
            },
            "lead",
        ),
        get(
            "work_delegated_ticket",
            "Work a persisted lead ticket once, at the same or better limit and no more than the authorized size.",
            obj({ ticket: string, quantity: positive, limitPrice: positive }),
            async (a) => {
                const ticket = word(a.ticket, 150),
                    r = await prisma.deskRecord.findUnique({
                        where: { bookId_key: { bookId: book.id, key: "delegation:" + ticket } },
                    });
                if (r?.kind !== "order_grant" || r.role !== "lead") throw new Error("Unknown lead ticket.");
                const grant = JSON.parse(r.dataJson),
                    o = parseOrder(grant.order),
                    q = Number(a.quantity),
                    price = Number(a.limitPrice);
                const checkGrant = async () => {
                    if (
                        grant.version !== book.version ||
                        Date.now() >= Date.parse(grant.deadline) ||
                        !(q > 0 && q <= o.quantity) ||
                        !(price > 0 && (o.side === "buy" ? price <= o.limitPrice : price >= o.limitPrice))
                    )
                        throw new Error("Lead ticket expired or exceeded.");
                };
                await checkGrant();
                // Execution uses the same durable ticket regardless of worker restart or shift.
                return executeDeskOrder(book.id, "delegated:" + ticket, { ...o, quantity: q, limitPrice: price });
            },
            "execution",
        ),
        get(
            "cancel_owned_order",
            "Cancel an owned working intent.",
            obj({ intentId: string }),
            (a) => cancelDeskOrder(book.id, word(a.intentId)),
            "lead",
        ),
        get(
            "work_pair",
            "Work two bounded legs with a maximum unhedged exposure and timed unwind.",
            obj({
                ticket: string,
                legs: { type: "array", items: orderSchema, minItems: 2, maxItems: 2 },
                maxUnhedgedUsd: positive,
                timeoutSeconds: positive,
            }),
            (a) => {
                const legs = a.legs as Args[];
                return executeDeskPair(book.id, shift.id + ":" + word(a.ticket, 80), {
                    legs: [parseOrder(legs[0]), parseOrder(legs[1])],
                    maxUnhedgedUsd: Number(a.maxUnhedgedUsd),
                    timeoutSeconds: Number(a.timeoutSeconds),
                    onFailure: "unwind",
                });
            },
            "lead",
        ),
        get(
            "authorize_quotes",
            "Set the standing execution mandate for the dedicated quoting subaccount.",
            obj({ instrumentId: string, halfSpreadBps: positive, orderUsd: positive, inventoryLimitUsd: positive }),
            async (a, c) => {
                if (book.kind !== "quoting") throw new Error("Dedicated quoting book required.");
                const grant = {
                    instrumentId: word(a.instrumentId),
                    halfSpreadBps: Number(a.halfSpreadBps),
                    orderUsd: Number(a.orderUsd),
                    inventoryLimitUsd: Number(a.inventoryLimitUsd),
                };
                await configureDeskQuotes(book.id, grant);
                await record(
                    prisma,
                    book.id,
                    shift.id,
                    "quote-grant:" + shift.id + ":" + c.callId,
                    "quote_grant",
                    c.role,
                    { ...grant, version: book.version },
                );
                return grant;
            },
            "lead",
        ),
        get(
            "adjust_quotes",
            "Work within the lead's latest standing grant. May widen spread or reduce inventory or clip size.",
            obj({ halfSpreadBps: positive, orderUsd: positive, inventoryLimitUsd: positive }),
            async (a) => {
                const row = await prisma.deskRecord.findFirst({
                    where: { bookId: book.id, kind: "quote_grant" },
                    orderBy: { id: "desc" },
                });
                const grant = row && JSON.parse(row.dataJson);
                if (
                    !grant ||
                    grant.version !== book.version ||
                    grant.revoked ||
                    Number(a.halfSpreadBps) < grant.halfSpreadBps ||
                    Number(a.orderUsd) > grant.orderUsd ||
                    Number(a.inventoryLimitUsd) > grant.inventoryLimitUsd
                )
                    throw new Error("Lead quote grant exceeded or unavailable.");
                return configureDeskQuotes(book.id, {
                    instrumentId: grant.instrumentId,
                    halfSpreadBps: Number(a.halfSpreadBps),
                    orderUsd: Number(a.orderUsd),
                    inventoryLimitUsd: Number(a.inventoryLimitUsd),
                });
            },
            "execution",
        ),
        get(
            "stop_quotes",
            "Withdraw standing quotes on the dedicated quoting book.",
            obj({}),
            async (_, c) => {
                await record(
                    prisma,
                    book.id,
                    shift.id,
                    "quote-stop:" + shift.id + ":" + c.callId,
                    "quote_grant",
                    c.role,
                    { revoked: true },
                );
                return configureDeskQuotes(book.id, null);
            },
            "lead",
        ),
        ...publicResearchTools({
            cache: publicCache,
            observed: (topic, operation, result, expiresAt, revision) => {
                if (!result.sources.length && !result.readVerification) return;
                board.publish(
                    "public:" + topic.id + ":" + operation,
                    Date.parse(expiresAt),
                    publicObservation(topic, operation, result, expiresAt),
                    async () => (await publicCache.revision(topic)) === revision,
                );
            },
            topics: async () => {
                const assets = (await instruments()).map(instrumentResearchTopic);
                const events = JSON.parse(shift.briefJson).triggers as { payload?: { publicSubject?: string } }[];
                const names = events
                    .map((e) => e.payload?.publicSubject)
                    .filter((v): v is string => typeof v === "string" && /^[a-zA-Z0-9 ._-]{1,50}$/.test(v));
                return [...new Set(names)].map((label) => ({ id: "public:" + label, label })).concat(assets);
            },
        }),
    ];
    const tools = result.map(
        (tool): DeskTool => ({
            ...tool,
            onValidationError: async (args,context,error) => {
                const key=`${shift.id}:${context.role}:${context.callId}:schema`;
                await record(prisma,book.id,shift.id,key,"tool_validation_error",context.role,
                    JSON.parse(deskModelJson({name:tool.name,args,error,callId:context.callId})));
            },
            run: async (a, c) => {
                // Providers may reuse call IDs in a later consultation or resumed lead turn.
                // Namespace receipts and journals by the host invocation so observations cannot collide.
                if (c.invocationId) c = { ...c, callId: c.invocationId + ":" + c.callId };
                const authorize = async () => {
                    if (c.signal.aborted) throw new Error("Shift cancelled.");
                    const [current, lease] = await Promise.all([
                        prisma.deskBook.findUnique({ where: { id: book.id } }),
                        prisma.deskShift.findUnique({ where: { id: shift.id } }),
                    ]);
                    if (
                        shift.bookId !== book.id ||
                        lease?.bookId !== book.id ||
                        !current ||
                        current.version !== book.version ||
                        lease?.lease !== shift.lease ||
                        lease.status !== "running" ||
                        !lease.leaseUntil ||
                        lease.leaseUntil <= new Date()
                    )
                        throw new Error("This shift has lost its mandate or lease.");
                    if (tool.name === "work_delegated_ticket") {
                        const grant = await prisma.deskRecord.findUnique({
                            where: { bookId_key: { bookId: book.id, key: "delegation:" + word(a.ticket, 150) } },
                        });
                        if (!grant || Date.parse(JSON.parse(grant.dataJson).deadline) <= Date.now())
                            throw new Error("Lead order ticket expired.");
                    }
                    const write = tool.access === "execution" || tool.access === "lead";
                    if (
                        write &&
                        (!current.enabled ||
                            shift.mode !== "live" ||
                            (tool.access === "lead" ? c.role !== "lead" : c.role !== "execution"))
                    )
                        throw new Error("Tool outside this role's authority.");
                };
                await authorize();
                const key = shift.id + ":" + c.role + ":" + c.callId;
                await record(
                    prisma,
                    book.id,
                    shift.id,
                    key,
                    tool.access === "execution" || tool.access === "lead" ? "dispatch" : "tool",
                    c.role,
                    { name: tool.name, args: a, invocationId: c.invocationId, callId: c.callId },
                );
                try {
                    if (tool.name === "backtest_strategy") {
                        await preflightResearchRequest(prisma,book,a);
                        await reserveBacktestRun(prisma, book, shift, c.role, c.callId, c.signal);
                    }
                    const out = await withDeskExecutionAuthority(authorize, () => tool.run(a, c));
                    if(tool.name==="backtest_status") {
                        const result=out as {runId:string;status:string;observedStatus?:string};
                        board.publish("research:"+result.runId,Date.now()+30*60_000,{tool:"backtest_status",runId:result.runId,status:result.status,observedStatus:result.observedStatus,
                            note:"This run was already observed this shift. Reuse the colleague's result; status is frozen until the next shift. Pending work wakes on completion."});
                    }
                    const artifact = await saveDeskArtifact(prisma, book.id, "tool_result", out);
                    await record(prisma, book.id, shift.id, key + ":result", "tool_result", c.role, {
                        name: tool.name, invocationId: c.invocationId, callId: c.callId,
                        ...journalResult(out, artifact),
                    });
                    return out;
                } catch (e) {
                    await record(prisma, book.id, shift.id, key + ":result", "tool_result", c.role, {
                        name: tool.name, invocationId: c.invocationId, callId: c.callId,
                        error: e instanceof Error ? e.message.slice(0, 350) : "Tool failed",
                    });
                    if (tool.name === "preview_order")
                        throw new Error(`previewReceipt=${c.callId}. ${e instanceof Error ? e.message : "Preview unavailable"}`);
                    throw e;
                }
            },
        }),
    );
    return Object.assign(tools, { sharedObservations: () => board.recent() });
}
