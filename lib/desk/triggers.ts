import "server-only";
import { observePasses, releaseNewsPasses, routePasses } from "./pass-review";
import { LIVE_ORDER_STATES } from "./execution-risk";
import { watchOwner } from "./routine-work";
import type { DeskBook } from "@prisma/client";
import { prisma } from "@/lib/db";
import { deskNewsSince, type DeskNewsWake } from "@/lib/news/desk-events";
import type { DeskInstrument } from "./instruments";
import { queueWake } from "./books";
import { newsExposure } from "./news-exposure";
import { collectMids, instrument, publicQuote } from "./market";

type ArrivalQuote = { bid: number; ask: number; at: string; observedAt: string };

async function captureArrivalQuotes(events: DeskNewsWake[], assets: DeskInstrument[], isTestnet: boolean) {
    const urgent = (event: DeskNewsWake) => event.kind === "risk" || event.kind === "correction";
    const priority = [...events].sort((a, b) => Number(urgent(b)) - Number(urgent(a)));
    const ids = [...new Set(priority.flatMap((event) => event.instrumentIds))].slice(0, 4);
    const registry = new Map(assets.map((asset) => [asset.id, asset]));
    const captured = new Map<string, ArrivalQuote>();
    const gaps = new Map(ids.map((id) => [id, "quote_timeout"]));
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Queue saturated or venue offline: deliver the risk notice within the
    // deadline. A later quote must not be backdated as an arrival observation.
    try {
        await Promise.race([
            Promise.all(
                ids.map(async (id) => {
                    const asset = registry.get(id);
                    if (!asset) {
                        gaps.set(id, "unresolved_instrument");
                        return;
                    }
                    try {
                        const quote = await publicQuote(asset, isTestnet);
                        if (!done)
                            captured.set(id, {
                                bid: quote.bid,
                                ask: quote.ask,
                                at: new Date(quote.time).toISOString(),
                                observedAt: new Date().toISOString(),
                            });
                    } catch {
                        if (!done) gaps.set(id, "book_unavailable");
                    }
                }),
            ),
            new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, priority.some(urgent) ? 300 : 800);
            }),
        ]);
    } finally {
        done = true;
        clearTimeout(timeout);
    }
    return events.map((event) => {
        const arrivalQuotes: Record<string, ArrivalQuote> = {};
        const arrivalQuoteGaps: Record<string, string> = {};
        for (const id of event.instrumentIds) {
            const quote = captured.get(id);
            if (quote && Date.parse(quote.at) >= Date.parse(event.availableAt)) arrivalQuotes[id] = quote;
            else arrivalQuoteGaps[id] = quote ? "quote_predates_analysis" : (gaps.get(id) ?? "instrument_limit");
        }
        return { ...event, arrivalQuotes, arrivalQuoteGaps };
    });
}

async function priorBookEvents(bookId: string, eventKeys: string[]) {
    // Bound the lookup to the current page of corrections. Only this book's own
    // discussions, instructions and watches can make an old event relevant.
    const keys = JSON.stringify(eventKeys);
    const rows = await prisma.$queryRaw<Array<{ eventKey: string }>>`
        SELECT eventKey FROM DeskWatch WHERE bookId = ${bookId}
            AND eventKey IN (SELECT value FROM json_each(${keys}))
        UNION
        SELECT json_extract(requestJson, '$.eventId') FROM DeskIntent WHERE bookId = ${bookId}
            AND json_extract(requestJson, '$.eventId') IN (SELECT value FROM json_each(${keys}))
        UNION
        SELECT json_extract(payload, '$.eventKey') FROM DeskWake WHERE bookId = ${bookId}
            AND shiftId IS NOT NULL AND key LIKE 'news:%'
            AND json_extract(payload, '$.eventKey') IN (SELECT value FROM json_each(${keys}))
    `;
    return rows.map((row) => row.eventKey);
}

export async function ingestNews(book: DeskBook) {
    const resumeKey = "news:partial-scan";
    const [scope, watched, pendingEvents, progress] = await Promise.all([
        newsExposure(book),
        prisma.deskWatch.findMany({
            where: { bookId: book.id, eventKey: { not: null }, status: "open" },
            select: { eventKey: true },
        }),
        prisma.deskWake.findMany({
            where: {
                bookId: book.id,
                key: { startsWith: "news:" },
                shiftId: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            select: { payload: true },
        }),
        prisma.deskRecord.findUnique({
            where: { bookId_key: { bookId: book.id, key: resumeKey } },
            select: { dataJson: true },
        }),
    ]);
    // While coverage is degraded, page through new risk notices on a separate
    // checkpoint. Reprocess that range with authoritative scope after recovery.
    const provisional = progress ? (JSON.parse(progress.dataJson) as { base: number; cursor: number }) : null;
    const partial = scope.coverage.needsReconciliation;
    const start =
        partial && provisional?.base === book.newsCursor
            ? Math.max(provisional.cursor, book.newsCursor)
            : book.newsCursor;
    const page = await deskNewsSince(start, {
        isTestnet: book.isTestnet,
        instruments: scope.directory,
        heldInstrumentIds: scope.heldIds,
        collateralSymbols: scope.collateralSymbols,
        uncertainExposure: scope.coverage.exposure !== "observed",
        directoryMissing: scope.coverage.directory !== "observed",
        priorBookEvents: (keys) => priorBookEvents(book.id, keys),
        watchedEventKeys: [
            ...watched.flatMap((w) => (w.eventKey ? [w.eventKey] : [])),
            ...pendingEvents.map((w) => JSON.parse(w.payload).eventKey).filter(Boolean),
        ],
    });
    if (page.cursor === start) return;
    const eligible = page.events.filter(
        (event) => scope.coverage.directory === "observed" || event.kind === "risk" || event.kind === "correction",
    );
    const observedEvents = await captureArrivalQuotes(
        eligible,
        scope.coverage.directory === "observed" ? scope.directory : [],
        book.isTestnet,
    );
    await prisma.$transaction(
        async (tx) => {
            const advanced = await tx.deskBook.updateMany({
                where: { id: book.id, version: book.version, enabled: true, newsCursor: book.newsCursor },
                data: { newsCursor: partial ? book.newsCursor : page.cursor },
            });
            if (!advanced.count) return;
            if (partial) {
                const dataJson = JSON.stringify({ base: book.newsCursor, cursor: page.cursor });
                await tx.deskRecord.upsert({
                    where: { bookId_key: { bookId: book.id, key: resumeKey } },
                    create: { bookId: book.id, key: resumeKey, role: "system", kind: "news_scope", dataJson },
                    update: { dataJson },
                });
            } else if (progress) {
                await tx.deskRecord.deleteMany({ where: { bookId: book.id, key: resumeKey } });
            }
            for (const item of observedEvents) {
                const event = { ...item, coverage: scope.coverage };
                // A revised or retracted event supersedes both an unclaimed review and its future deadline.
                for (const old of pendingEvents) {
                    const prior = JSON.parse(old.payload);
                    if (prior.eventKey === event.eventKey && prior.revisionId !== event.revisionId) {
                        const prefix = "news:" + prior.revisionId;
                        await tx.deskWake.updateMany({
                            where: { bookId: book.id, shiftId: null, key: { in: [prefix, prefix + ":deadline"] } },
                            data: { expiresAt: new Date(0) },
                        });
                    }
                }
                const urgent = event.kind === "risk" || event.kind === "correction";
                const key = "news:" + event.revisionId;
                const parked = event.kind !== "research" && !partial &&
                    !await tx.deskWake.findUnique({ where: { bookId_key: { bookId: book.id, key } }, select: { id: true } }) &&
                    await releaseNewsPasses(tx, book, event.instrumentIds);
                const passReview = parked && event.kind === "discovery" &&
                    event.instrumentIds.every(id => !scope.heldIds.includes(id)) &&
                    !await tx.deskInventory.count({ where: { bookId: book.id, instrumentId: { in: event.instrumentIds },
                        OR: [{ quantity: { not: 0 } }, { suspended: true }] } }) &&
                    !await tx.deskIntent.count({ where: { bookId: book.id, instrumentId: { in: event.instrumentIds },
                        OR: [{ reservedUsd: { gt: 0 } }, { state: { in: LIVE_ORDER_STATES } }] } });
                const due = event.deadline ? new Date(event.deadline) : undefined;
                if (event.kind === "scheduled" && due && due.getTime() > Date.now()) {
                    await queueWake(
                        tx,
                        book,
                        key + ":deadline",
                        "deadline",
                        "live",
                        event,
                        8,
                        due,
                        new Date(due.getTime() + book.frequencySeconds * 1000),
                    );
                }
                await queueWake(
                    tx,
                    book,
                    key,
                    event.kind,
                    event.kind === "research" ? "research" : "live",
                    passReview ? { ...event, passReview: true, role: "lead" } : event,
                    urgent ? 10 : 4,
                    new Date(),
                    urgent ? null : new Date(event.expiresAt),
                );
            }
        },
        { timeout: 12000 },
    );
}

export async function wakeOnFills(book: DeskBook) {
    // Reconciliation imports exchange fills with stable IDs. Coalesce catch-up fills into shifts.
    const fills = await prisma.deskCashFlow.findMany({
        where: { bookId: book.id, occurredAt: { gte: new Date(Date.now() - 3600000) } },
        orderBy: { occurredAt: "desc" },
        take: 100,
    });
    const known = await prisma.deskWake.findMany({
        where: { bookId: book.id, key: { in: fills.map((f) => "fill:" + f.id) } },
        select: { key: true },
    });
    const keys = new Set(known.map((k) => k.key));
    for (const f of fills.filter((f) => !keys.has("fill:" + f.id)))
        await queueWake(
            prisma,
            book,
            "fill:" + f.id,
            "fill",
            "live",
            { instrumentId: f.instrumentId, quantity: f.quantity, price: f.price, kind: f.kind },
            7,
        );
}

export async function processWatches(book: DeskBook) {
    const watches = await prisma.deskWatch.findMany({
        where: { bookId: book.id, status: "open" },
        orderBy: { deadline: "asc" },
        take: 250,
    });
    if (!watches.length) return;
    const prices = watches.some((w) => w.instrumentId && w.threshold !== null)
        ? new Map((await collectMids(book.isTestnet)).map((m) => [m.instrumentId, m.mid]))
        : new Map<string, number>();
    for (const w of watches) {
        const elapsed = w.deadline.getTime() <= Date.now();
        const mid = w.instrumentId ? prices.get(w.instrumentId) : undefined;
        const crossed =
            w.threshold !== null &&
            mid !== undefined &&
            (w.kind === "above" ? mid >= w.threshold : w.kind === "below" && mid <= w.threshold);
        if (!elapsed && !crossed) continue;
        let outcome: Record<string, unknown> = w.outcomeJson ? JSON.parse(w.outcomeJson) : {};
        if (w.kind === "pass" && w.instrumentId && w.referencePrice) {
            try {
                if (Date.now() - w.deadline.getTime() > 60000) throw new Error("missed horizon");
                const quote = await publicQuote(await instrument(book.isTestnet, w.instrumentId), book.isTestnet);
                const exit = w.side === "sell" ? quote.ask : quote.bid;
                outcome = {
                    ...outcome,
                    referencePrice: w.referencePrice,
                    exitPrice: exit,
                    observedAt: quote.time,
                    grossBps: (w.side === "sell" ? -1 : 1) * (exit / w.referencePrice - 1) * 10000,
                };
            } catch {
                outcome = { ...outcome, coverage: "no executable observation at horizon" };
            }
        }
        await prisma.$transaction(async (tx) => {
            const changed = await tx.deskWatch.updateMany({
                where: { id: w.id, status: "open", outcomeJson: w.outcomeJson },
                data: { status: crossed ? "triggered" : "elapsed", outcomeJson: JSON.stringify(outcome) },
            });
            if (
                changed.count &&
                w.kind !== "pass" &&
                (w.mode === "research" || book.enabled) &&
                (crossed || (w.kind === "review" && Date.now() - w.deadline.getTime() < book.frequencySeconds * 1000))
            ) {
                await queueWake(
                    tx,
                    book,
                    "watch:" + w.id,
                    "watch",
                    w.mode === "live" ? "live" : "research",
                    {
                        role: await watchOwner(tx, w),
                        thesis: w.thesis,
                        instrumentId: w.instrumentId,
                        eventKey: w.eventKey,
                        mid,
                        condition: w.kind,
                        threshold: w.threshold,
                    },
                    6,
                    new Date(),
                    new Date(Date.now() + book.frequencySeconds * 1000),
                );
            }
        });
    }
}

export function detectMoves(
    previous: Map<string, number>,
    prices: { instrumentId: string; mid: number }[],
    threshold = 0.05,
) {
    return prices.flatMap((m) => {
        const old = previous.get(m.instrumentId);
        const move = old ? m.mid / old - 1 : 0;
        return Math.abs(move) >= threshold ? [{ ...m, previous: old, move }] : [];
    });
}

export async function sampleMarket(book: DeskBook, now = new Date()) {
    // Compare successive five-minute observations; do not treat a gap overnight as a five-minute move.
    const bucket = Math.floor(now.getTime() / 300000);
    const key = "market:" + bucket;
    if (await prisma.deskRecord.findUnique({ where: { bookId_key: { bookId: book.id, key } } })) return;
    const prices = await collectMids(book.isTestnet);
    if (!prices.length) return;
    const before = await prisma.deskRecord.findUnique({
        where: { bookId_key: { bookId: book.id, key: "market:" + (bucket - 1) } },
    });
    const previous = new Map<string, number>(before ? JSON.parse(before.dataJson) : []);
    const moves = detectMoves(previous, prices)
        .sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
    const passes = await observePasses(book, new Map(prices.map(p => [p.instrumentId, p.mid])), new Set(moves.map(m => m.instrumentId)), now);
    await prisma.$transaction(async (tx) => {
        if (!await tx.deskBook.count({ where: { id: book.id, version: book.version, enabled: true } }) ||
            await tx.deskRecord.findUnique({ where: { bookId_key: { bookId: book.id, key } } })) return;
        await tx.deskRecord.upsert({
            where: { bookId_key: { bookId: book.id, key } },
            create: {
                key,
                bookId: book.id,
                kind: "market_sample",
                role: "market",
                dataJson: JSON.stringify(prices.map((p) => [p.instrumentId, p.mid])),
            },
            update: {},
        });
        const handled = await routePasses(tx, book, passes, new Date());
        const deferred = moves.filter(m => handled.has(m.instrumentId));
        if (deferred.length) await tx.deskRecord.create({ data: {
            bookId: book.id, key: key + ":pass-routing", kind: "pass_review", role: "market",
            dataJson: JSON.stringify(deferred.map(({ instrumentId, move }) => ({ instrumentId, move, ...handled.get(instrumentId) }))),
        } });
        const actionable = moves.filter(m => !handled.has(m.instrumentId)).slice(0, 10);
        if (actionable.length)
            await queueWake(tx, book, key, "market_move", "live", { moves: actionable }, 5, now, new Date(+now + 300000));
        await tx.deskRecord.deleteMany({
            where: { bookId: book.id, kind: "market_sample", createdAt: { lt: new Date(+now - 86400000) } },
        });
    });
}
