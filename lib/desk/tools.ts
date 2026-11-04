import "server-only";
import { requestWatch } from "./routine-work";
import { createHash } from "crypto";
import type { DeskBook, DeskShift } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getMetaAndAssetCtxs, getOHLCV, hyperliquidInfoUrl } from "@/lib/hyperliquid-info";
import { deskNewsMarketContext } from "@/lib/news/market-observation";
import { deskEventHistory } from "@/lib/news/desk-events";
import { NewsIntelligenceService } from "@/services/NewsIntelligenceService";
import { newsDb } from "@/lib/news-db";
import { newsAccountAddress } from "@/lib/news/account";
import { record, queueWake } from "./books";
import { listInstruments } from "./instruments";
import { accountExposure, instrument, publicQuote } from "./market";
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
import { publicResearchTools } from "./research";
import type { DeskTool } from "./roundtable";

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
const orderSchema = obj(
    {
        instrumentId: string,
        side,
        quantity: positive,
        limitPrice: positive,
        reduceOnly: { type: "boolean" },
        stopPrice: positive,
        takeProfitPrice: positive,
        thesis: string,
        eventId: {
            type: "string",
            description: "Canonical news eventKey if the thesis originates from an event in news_history.",
        },
    },
    ["instrumentId", "side", "quantity", "limitPrice", "thesis"],
);
type Order = Parameters<typeof executeDeskOrder>[2];
function parseOrder(args: Args): Order {
    if (!["buy", "sell"].includes(String(args.side))) throw new Error("Choose buy or sell.");
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
    const publicCache = bookPublicCache(prisma, book, shift);
    const instruments = async () =>
        (await reads.read("instrument-directory", 30_000, () => listInstruments(net))).value;
    const readInstrument = async (id: unknown) => {
        const found = (await instruments()).find((i) => i.id === id);
        if (!found) throw new Error("Instrument is unavailable on this network");
        return found;
    };
    // Share one venue snapshot across the order book, cost, basis and history views. The
    // venue timestamp bounds its lifetime even if the underlying feed served an older book.
    const observedQuote = async (item: Awaited<ReturnType<typeof instrument>>) => {
        const observed = await reads.read(
            "l2:" + item.id,
            3_000,
            () => publicQuote(item, net),
            (q) => q.time + 10_000,
        );
        const q = observed.value;
        board.publish("l2:" + item.id, observed.expiresAt, {
            tool: "order_book",
            instrumentId: item.id,
            at: new Date(q.time).toISOString(),
            validUntil: new Date(observed.expiresAt).toISOString(),
            bid: q.bid,
            ask: q.ask,
            spreadBps: q.spreadBps,
        });
        return { ...q, observation: timeOf(observed) };
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
        const s = await deskExecutionState(book.id);
        return {
            inventory: s.inventory.map((p) => ({
                instrumentId: p.instrumentId,
                quantity: p.quantity,
                basis: p.basis,
                suspended: p.suspended,
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
            "Timestamped bid, ask, depth and spread for research. Roles share a book snapshot for up to three seconds.",
            obj({ instrumentId: string }),
            async (a) => observedQuote(await readInstrument(a.instrumentId)),
        ),
        get(
            "market_history",
            "Historical one-minute OHLCV; optionally measure price response from a supplied event timestamp.",
            obj({ instrumentId: string, since: string }, ["instrumentId"]),
            async (a) => {
                const item = await readInstrument(a.instrumentId);
                const since = a.since ? Date.parse(word(a.since)) : Date.now() - 3600000;
                if (!Number.isFinite(since) || since > Date.now() || since < Date.now() - 4 * 86400000)
                    throw new Error("Select an observation in the last four days.");
                const start = Math.floor(since / 60000) * 60000 - 60000;
                const candles = await reads.read("ohlcv:" + item.id + ":" + start, 15_000, () =>
                    getOHLCV(item.coin, "1m", net, start),
                );
                const rows = candles.value;
                const pre = rows.filter((c) => Number(c.T) < since).at(-1),
                    quote = await observedQuote(item);
                return {
                    candlesObserved: timeOf(candles),
                    before: pre ?? null,
                    current: quote,
                    returnSinceBps:
                        pre && Number(pre.c) > 0 ? ((0.5 * (quote.bid + quote.ask)) / Number(pre.c) - 1) * 1e4 : null,
                    candles: rows.slice(-90),
                };
            },
        ),
        get(
            "funding_and_basis",
            "Inspect a native perp's funding, premium, open interest and spot basis if a matching cash market exists.",
            obj({ instrumentId: string }),
            async (a) => {
                const p = await readInstrument(a.instrumentId);
                if (p.kind !== "perp") throw new Error("Select the perpetual contract.");
                const observation = await reads.read("funding", 10_000, async () => {
                    const meta = await getMetaAndAssetCtxs(net);
                    if (!meta) throw new Error("Funding data unavailable.");
                    return meta;
                });
                const meta = observation.value;
                const i = meta?.universe.findIndex((x) => x.name === p.coin) ?? -1;
                const ctx = meta?.assetCtxs[i];
                if (!ctx) throw new Error("Funding data unavailable.");
                const spots = (await instruments()).filter(
                    (x) => x.kind === "spot" && x.base === p.base && x.quote === "USDC",
                );
                const spot = spots.length === 1 ? await observedQuote(spots[0]) : null;
                const expires = Math.min(
                    observation.expiresAt,
                    spot ? Date.parse(spot.observation.expiresAt) : Infinity,
                );
                board.publish("funding:" + p.id, expires, {
                    tool: "funding_and_basis",
                    instrumentId: p.id,
                    fundingRate: ctx.funding,
                    mark: ctx.markPx,
                    oracle: ctx.oraclePx,
                    openInterest: ctx.openInterest,
                    retrievedAt: new Date(observation.observedAt).toISOString(),
                    validUntil: new Date(expires).toISOString(),
                });
                return {
                    observation: timeOf(observation),
                    fundingRate: ctx.funding,
                    mark: ctx.markPx,
                    oracle: ctx.oraclePx,
                    openInterest: ctx.openInterest,
                    spot,
                    basisBps: spot
                        ? (Number(ctx.markPx) / p.multiplier / (0.5 * (spot.bid + spot.ask)) - 1) * 1e4
                        : null,
                };
            },
        ),
        get(
            "account_exposure",
            "Whole account exposure and working orders; includes manual holdings that are observation-only.",
            obj({}),
            () => accountExposure(book),
        ),
        get(
            "desk_blotter",
            "Owned inventory, executable intents, recent fills, fees and performance.",
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
                return prisma.opportunityJournal.findMany({
                    where: {
                        accountAddress: book.ownerAddress,
                        network: net ? "testnet" : "mainnet",
                        symbol: item.coin + "-PERP",
                    },
                    take: 16,
                    orderBy: { timestamp: "desc" },
                    select: {
                        timestamp: true,
                        status: true,
                        setupType: true,
                        outcome15mJson: true,
                        outcome1hJson: true,
                    },
                });
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
                return prisma.$transaction(async (tx) => {
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
            "Schedule a review, executable-price alert, or track a passed idea against first executable price.",
            obj(
                {
                    kind: { enum: ["review", "above", "below", "pass"] },
                    instrumentId: string,
                    thesis: string,
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
                if (kind === "pass" && !["buy", "sell"].includes(String(a.side)))
                    throw new Error("Specify the side of the passed idea.");
                if (a.revisitWhen !== undefined && (kind !== "pass" || c.role !== "lead" || shift.mode !== "live" ||
                    !["bid_depth", "ask_depth", "both_depth", "material_news"].includes(String(a.revisitWhen)))) throw new Error("Revisit conditions require a live lead pass.");
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
                const watch = await prisma.$transaction((tx) =>
                    requestWatch(tx, book, shift, c.role, {
                        kind,
                        thesis,
                        eventKey: a.eventKey ? word(a.eventKey) : null,
                        instrumentId: m?.id,
                        side: a.side ? String(a.side) : null,
                        outcomeJson: quote
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
            "preview_order",
            "Check a concrete ticket against fresh venue data and the effective mandate. Returns a previewReceipt. Never signs or submits.",
            orderSchema,
            async (a, c) => ({ ...(await previewDeskOrder(book.id, parseOrder(a))), previewReceipt: c.callId }),
        ),
        get(
            "work_order",
            "Place a live order at the specified price and within the book mandate. Use the same ticket on retry.",
            obj({ ...orderSchema.properties, ticket: string }, [...orderSchema.required, "ticket"]),
            async (a) => {
                const order = parseOrder(a);
                if (order.eventId && !(await deskEventHistory(order.eventId)).length)
                    throw new Error("Unknown event key. Inspect news_history for a recorded event.");
                return executeDeskOrder(book.id, shift.id + ":" + word(a.ticket, 80), order);
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
                if (!result.sources.length) return;
                board.publish(
                    "public:" + topic.id + ":" + operation,
                    Date.parse(expiresAt),
                    {
                        tool: operation.startsWith("search:") ? "search_public_sources" : "read_public_source",
                        topicId: topic.id,
                        retrievedAt: result.retrievedAt,
                        validUntil: expiresAt,
                        sources: result.sources
                            .slice(0, 2)
                            .map((s) => ({
                                evidenceId: s.evidenceId,
                                title: s.title.slice(0, 100),
                                finding: s.finding.slice(0, 170),
                                publishedAt: s.publishedAt,
                            })),
                    },
                    async () => (await publicCache.revision(topic)) === revision,
                );
            },
            topics: async () => {
                const assets = (await instruments()).map((m) => ({ id: m.id, label: m.base }));
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
            run: async (a, c) => {
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
                    { name: tool.name, args: a },
                );
                try {
                    const out = await withDeskExecutionAuthority(authorize, () => tool.run(a, c));
                    await record(prisma, book.id, shift.id, key + ":result", "tool_result", c.role, {
                        name: tool.name,
                        result: JSON.stringify(out ?? null).slice(0, 6000),
                    });
                    return out;
                } catch (e) {
                    await record(prisma, book.id, shift.id, key + ":result", "tool_result", c.role, {
                        name: tool.name,
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
