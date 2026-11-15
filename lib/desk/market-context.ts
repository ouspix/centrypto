import "server-only";
import { createHash } from "node:crypto";
import type { DeskBook, DeskShift } from "@prisma/client";
import { prisma } from "@/lib/db";
import { newsAccountAddress } from "@/lib/news/account";
import { readOfficialCalendars } from "@/lib/news/official-calendar-store";
import { resolvableTargets } from "@/lib/news/desk-routing";
import { NewsIntelligenceService } from "@/services/NewsIntelligenceService";
import type { NewsSignal } from "@/types/news";
import { comparisonSlate } from "./candidate-comparison";
import { decodeDeskArtifact, saveDeskArtifact } from "./artifacts";
import { resolveDeskExposure } from "./instruments";
import { marketBreadth, minute, type MarketFeatureSnapshot } from "./market-features";
import { rankScreen, type Catalyst, type ScreenQuery } from "./market-screen";
import { contextMode, networkOf, readMarketFeatures } from "./market-snapshots";

type Calendar = Awaited<ReturnType<typeof readOfficialCalendars>>;
const unavailableCalendar = (): Calendar => [
    { source: "fed", status: "unavailable", url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", checkedAt: null, events: [] },
    { source: "bls", status: "unavailable", url: "https://www.bls.gov/schedule/news_release/bls.ics", checkedAt: null, events: [] },
];
const iso = (at: number) => new Date(at).toISOString();
function bounded<T>(task: Promise<T>, fallback: T, ms = 1800) {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([task.catch(() => fallback), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); })])
        .finally(() => clearTimeout(timer));
}
function compactSignal(signal: NewsSignal, availableAt: string) {
    return {
        eventKey: signal.eventKey, summary: signal.summary.slice(0, 280), direction: signal.direction,
        materiality: signal.materiality, confidence: signal.confidence, claimType: signal.claimType,
        contradictions: signal.contradictions.slice(0, 3).map(text => text.slice(0, 160)),
        evidenceIds: signal.evidenceIds.slice(0, 8), availableAt: signal.eventAvailableAt ?? availableAt, expiresAt: signal.expiresAt,
        deadline: signal.facts?.deadline ?? null,
    };
}

async function loadNews(snapshot: MarketFeatureSnapshot | null, at: number) {
    const service = new NewsIntelligenceService();
    const owner = newsAccountAddress();
    const [market, catalyst, calendar] = await Promise.all([
        service.marketBriefing(owner, new Date(at)), service.catalystBriefing(owner, new Date(at)), readOfficialCalendars(owner, at, 30).catch(unavailableCalendar),
    ]);
    const instruments = snapshot?.directory ?? [];
    const nativeIds = new Set(snapshot?.instruments.map(row => row.instrumentId) ?? []);
    const fresh = (availableAt: string | null) => availableAt && Date.parse(availableAt) <= at && at - Date.parse(availableAt) <= 120 * minute;
    const events = fresh(market.availableAt) ? market.signals
        .map(s => compactSignal(s, market.availableAt!))
        .sort((a, b) => b.materiality - a.materiality || b.availableAt.localeCompare(a.availableAt)) : [];
    const catalysts: Catalyst[] = [];
    if (fresh(catalyst.availableAt)) for (const signal of catalyst.signals) {
        const ids = new Set<string>();
        for (const target of resolvableTargets(signal)) {
            if (!target.symbol || !["direct", "indirect"].includes(target.relation) || !target.mechanism || target.channel === "none") continue;
            for (const item of resolveDeskExposure(instruments, target.symbol, target.contract, target.instrumentKind, target.quote)) if (nativeIds.has(item.id)) ids.add(item.id);
        }
        for (const instrumentId of ids) catalysts.push({ instrumentId, ...compactSignal(signal, catalyst.availableAt!) });
    }
    const evidenceIds = [...new Set(events.slice(0, 10).flatMap(event => event.evidenceIds))];
    const evidence = (await service.evidence(owner, evidenceIds).catch(() => [])).map(row => ({
        id: row.id, source: row.source.name, publishedAt: row.publishedAt?.toISOString() ?? null,
        collectedAt: row.collectedAt.toISOString(), completeness: row.completeness,
        ...(row.source.isPrivate ? {} : { url: row.canonicalUrl }),
    }));
    return { events: events.slice(0, 10).filter(event => event.evidenceIds.every(id => evidence.some(row => row.id === id))), status: market.availableAt && !fresh(market.availableAt) ? "stale" : market.status,
        briefingAt: market.availableAt, coverage: { ...market.coverage, gaps: market.coverage.gaps.slice(0, 10) }, evidence, catalysts, calendar };
}
type News = Awaited<ReturnType<typeof loadNews>>;
const noNews: News = { events: [], status: "unavailable", briefingAt: null,
    coverage: { configured: 0, healthy: 0, pendingDocuments: 0, gaps: [] }, evidence: [], catalysts: [], calendar: unavailableCalendar() };
const newsPolls = new Map<boolean, { nextAt: number; pending: boolean }>();
const newsNetwork = (testnet: boolean) => networkOf(testnet) + ":news:" +
    createHash("sha256").update(newsAccountAddress()).digest("hex").slice(0, 16);

export function scheduleMarketNews(isTestnet: boolean, signal: AbortSignal) {
    if (contextMode() === "legacy" || signal.aborted || !process.env.NEWS_COLLECTOR_OWNER_ADDRESS) return;
    const now = Date.now();
    const poll = newsPolls.get(isTestnet);
    if (poll && (poll.pending || poll.nextAt > now)) return;
    const state = { pending: true, nextAt: now + minute };
    newsPolls.set(isTestnet, state);
    void (async () => {
        const network = newsNetwork(isTestnet);
        const snapshot = await readMarketFeatures(isTestnet, undefined, now);
        const news = await loadNews(snapshot, now);
        signal.throwIfAborted();
        const dataJson = JSON.stringify(news);
        const id = createHash("sha256").update(network + ":" + now + ":" + dataJson).digest("hex");
        await prisma.$transaction([
            prisma.deskMarketSnapshot.upsert({ where: { id }, update: {}, create: { id, network, asOf: new Date(now), dataJson } }),
            prisma.deskMarketSnapshot.deleteMany({ where: { network, asOf: { lt: new Date(now - 30 * minute) } } }),
        ]);
    })().catch(() => {
        if (!signal.aborted) console.warn("[Trading desk] Market news context refresh unavailable.");
    }).finally(() => { state.pending = false; });
}

type MarketInputs = { at: number; numeric: MarketFeatureSnapshot | null; news: News };
async function currentInputs(book: Pick<DeskBook, "isTestnet">, snapshotId?: string): Promise<MarketInputs> {
    const at = Date.now();
    const [numeric, news] = await Promise.all([
        bounded(readMarketFeatures(book.isTestnet, snapshotId, at), null, 800),
        bounded((async () => {
            const row = await prisma.deskMarketSnapshot.findFirst({
                where: { network: newsNetwork(book.isTestnet), asOf: { gte: new Date(at - 3 * minute), lte: new Date(at) } },
                orderBy: { asOf: "desc" }, select: { dataJson: true },
            });
            return row ? JSON.parse(row.dataJson) as News : noNews;
        })(), noNews, 800),
    ]);
    return { at, numeric, news };
}
export const contextSections = ["benchmarks", "breadth", "positioning", "liquidity", "news", "calendar"] as const;
type ContextSection = typeof contextSections[number];
export type ContextQuery = { sections?: ContextSection[]; benchmarks?: string[]; eventDays?: number; snapshotId?: string; fresh?: boolean };
export const contextQueryProperties = {
    sections: { type: "array", maxItems: 6, items: { type: "string", enum: contextSections } },
    benchmarks: { type: "array", maxItems: 6, items: { type: "string", maxLength: 40 } },
    eventDays: { type: "integer", minimum: 1, maximum: 30 }, snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
    fresh: { type: "boolean" },
};

function contextFrom(book: Pick<DeskBook, "isTestnet">, { at, numeric, news }: MarketInputs, query: ContextQuery = {}) {
    const age = numeric ? at - numeric.asOf : null;
    const fresh = age != null && age >= 0 && age <= 2 * minute;
    const rows = fresh ? numeric!.instruments : [];
    const select = (name: ContextSection) => !query.sections || query.sections.includes(name);
    const benchmarkRows = rows.filter(row => (query.benchmarks ?? ["BTC", "ETH"]).includes(row.symbol));
    const spreads = rows.flatMap(row => row.spreadBps == null || at - row.observedAt! > 2 * minute ? [] : [{ symbol: row.symbol, at: iso(row.observedAt!), bps: row.spreadBps }]);
    const active = (event: { expiresAt: string; availableAt: string }) => Date.parse(event.availableAt) <= at && Date.parse(event.expiresAt) > at;
    const horizon = at + (query.eventDays ?? 7) * 24 * 60 * minute;
    const inHorizon = (event: { startsAt: string | null; date: string }) => event.startsAt
        ? Date.parse(event.startsAt) <= horizon : event.date <= iso(horizon).slice(0, 10);
    return {
        version: 1 as const, network: networkOf(book.isTestnet), mode: contextMode(), asOf: iso(at), snapshotId: numeric?.id ?? null,
        marketObservedAt: numeric ? iso(numeric.asOf) : null, marketAgeSeconds: age == null ? null : age / 1000,
        status: !numeric ? "unavailable" : fresh ? "observed" : "stale",
        coverage: { eligible: numeric?.instruments.length ?? 0, fresh: rows.filter(r => r.observedAt != null && at - r.observedAt <= 2 * minute).length,
            structural: Object.fromEntries(["15m", "1h", "4h"].map(tf => [tf, rows.filter(row => row.frame[tf as keyof typeof row.frame]).length])),
            candleError: numeric?.candleError ?? null },
        ...(select("benchmarks") ? { benchmarks: benchmarkRows.map(r => ({ symbol: r.symbol, observedAt: r.observedAt, returnClosedAt: r.returnClosedAt,
            returnsBps: r.changes, frame: r.frame })) } : {}),
        ...(select("breadth") ? { breadth: marketBreadth(rows, at) } : {}),
        ...(select("positioning") ? { positioning: { fundingMeasured: rows.filter(r => r.fundingHourly != null).length,
            fundingPercentileMeasured: rows.filter(r => r.fundingPercentile != null).length, oiMeasured: rows.filter(r => r.oiChange1hPct != null).length,
            benchmarks: benchmarkRows.map(r => ({ symbol: r.symbol, observedAt: r.observedAt, fundingHourly: r.fundingHourly,
                fundingPercentile: r.fundingPercentile, fundingSamples: r.fundingSamples, openInterestBase: r.openInterestBase,
                openInterestUsd: r.openInterestUsd, oiChange1hPct: r.oiChange1hPct, basisBps: r.basisBps })) } } : {}),
        ...(select("liquidity") ? { liquidity: { measured: spreads.length, spreads: spreads.slice(0, 32) } } : {}),
        ...(select("news") ? { news: { status: news.status, briefingAt: news.briefingAt, coverage: news.coverage,
            events: news.events.filter(active), evidence: news.evidence } } : {}),
        ...(select("calendar") ? { calendar: news.calendar.map(source => ({ ...source, events: source.events.filter(e => inHorizon(e) && (!e.startsAt || Date.parse(e.startsAt) >= at)).slice(0, 30) })) } : {}),
    };
}
export type MarketContextSnapshot = ReturnType<typeof contextFrom> & { evidenceId?: string };
const inputsKind = "market_context_inputs";
const pageKind = "market_screen_page";
async function artifactInputs(book: Pick<DeskBook, "id" | "isTestnet">, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const row = await prisma.deskArtifact.findFirst({ where: { id, bookId: book.id, kind: { in: [inputsKind, pageKind] } },
        select: { encoding: true, contentJson: true, sha256: true } });
    if (!row) return null;
    const input = decodeDeskArtifact(row) as MarketInputs;
    return input.numeric && input.numeric.network !== networkOf(book.isTestnet) ? null : input;
}
export async function readMarketContext(book: Pick<DeskBook, "id" | "isTestnet">, query: ContextQuery = {}, reviewId?: string) {
    const id = query.snapshotId ?? (!query.fresh ? reviewId : undefined);
    const input = id ? await artifactInputs(book, id) : await currentInputs(book);
    return input ? { ...contextFrom(book, input, query), ...(id ? { evidenceId: id } : {}) } : null;
}
const digest = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
export async function captureReviewContext(book: DeskBook, shift: DeskShift, snapshotId?: string) {
    if (contextMode() !== "enabled") return null;
    const key = "market-context:" + shift.id;
    const where = { bookId: book.id, key };
    const existing = await prisma.deskRecord.findUnique({ where: { bookId_key: where }, select: { dataJson: true } });
    if (existing) return JSON.parse(existing.dataJson) as { evidenceId: string; summary: ReturnType<typeof marketBrief> };
    const input = await currentInputs(book, snapshotId);
    const { artifactId: evidenceId } = await saveDeskArtifact(prisma, book.id, inputsKind, input);
    const dataJson = JSON.stringify({ evidenceId, summary: marketBrief(contextFrom(book, input)) });
    const row = await prisma.deskRecord.upsert({ where: { bookId_key: where }, update: {},
        create: { ...where, shiftId: shift.id, role: "host", kind: "market_context", dataJson } });
    return JSON.parse(row.dataJson) as { evidenceId: string; summary: ReturnType<typeof marketBrief> };
}
export function marketBrief(context: MarketContextSnapshot) {
    const n = (value: number | null | undefined) => value == null ? null : Math.round(value * 100) / 100;
    return {
        network: context.network, asOf: context.asOf, marketObservedAt: context.marketObservedAt, status: context.status,
        coverage: context.coverage,
        benchmarks: context.benchmarks?.map(b => ({ symbol: b.symbol, returnsBps: b.returnsBps,
            range1h: b.frame["1h"] ? [b.frame["1h"].priorLow, b.frame["1h"].priorHigh] : null,
            volatilityPercentile1h: n(b.frame["1h"]?.volatilityPercentile), trendEfficiency1h: n(b.frame["1h"]?.trendEfficiency) })),
        breadth1h: context.breadth?.["1h"], breadth4h: context.breadth?.["4h"],
        positioning: context.positioning?.benchmarks.map(b => ({ symbol: b.symbol, fundingPercentile: n(b.fundingPercentile), oiChange1hPct: n(b.oiChange1hPct) })),
        newsStatus: context.news?.status,
        news: context.news?.events.slice(0, 2).map(e => ({ summary: e.summary.slice(0, 160), availableAt: e.availableAt,
            expiresAt: e.expiresAt, eventKey: e.eventKey, evidenceIds: e.evidenceIds.slice(0, 2) })),
        calendar: context.calendar?.map(c => ({ source: c.source, status: c.status })),
        upcoming: context.calendar?.flatMap(c => c.events).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3)
            .map(e => ({ title: e.title.slice(0, 65), date: e.date, startsAt: e.startsAt, source: e.source })),
    };
}
export class ScreenCursorError extends Error {}

export async function screenBook(book: Pick<DeskBook, "id" | "isTestnet">, query: ScreenQuery, reviewId?: string) {
    const { cursor, ...criteria } = query;
    const queryHash = digest(criteria);
    let id = reviewId, offset = 0;
    if (cursor) {
        let decoded;
        try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
        catch { throw new ScreenCursorError("Invalid screen cursor"); }
        if (!/^[a-f0-9]{64}$/.test(decoded?.id ?? "") || decoded.q !== queryHash || (reviewId && decoded.id !== reviewId) ||
            !Number.isInteger(decoded.offset) || decoded.offset < 1 || decoded.offset > 10_000) throw new ScreenCursorError("Invalid screen cursor");
        id = decoded.id;
        offset = decoded.offset;
    }
    const input = id ? await artifactInputs(book, id) : await currentInputs(book);
    if (cursor && (!input || !reviewId && Date.now() - input.at > 30 * minute)) throw new ScreenCursorError("Screen cursor expired");
    const snapshot = input?.numeric ?? null;
    const valid = snapshot && input && input.at - snapshot.asOf >= 0 && input.at - snapshot.asOf <= 2 * minute;
    const [inventory, orders] = await Promise.all([
        prisma.deskInventory.findMany({ where: { bookId: book.id, quantity: { not: 0 } }, select: { instrumentId: true } }),
        prisma.deskIntent.findMany({ where: { bookId: book.id, state: { in: ["submitting", "unknown", "working", "settling"] } }, select: { instrumentId: true } }),
    ]);
    const output = valid ? rankScreen(snapshot, query, input.news.catalysts, input.at) : null;
    const rows = output?.candidates ?? [];
    const researchShortlist = rows.slice(offset, offset + query.limit);
    const lookup = new Map(snapshot?.instruments.map(row => [row.instrumentId, row]) ?? []);
    const receipt = (instrumentId: string) => ({
        instrumentId, symbol: lookup.get(instrumentId)?.symbol ?? null,
        status: output?.valuesById.has(instrumentId) ? "observed" : lookup.has(instrumentId) ? "unavailable" : "outside_snapshot",
        values: output?.valuesById.get(instrumentId) ?? null,
    });
    const researchLanes = [...new Set(researchShortlist.map(c => c.view))].map(view => ({
        family: view, question: "Investigate the measured " + view + " conditions on the chosen horizon.",
        candidates: researchShortlist.filter(c => c.view === view).slice(0, 2),
    }));
    let nextCursor: string | null = null;
    if (input && offset + query.limit < rows.length) {
        id ??= (await saveDeskArtifact(prisma, book.id, pageKind, input)).artifactId;
        nextCursor = Buffer.from(JSON.stringify({ id, q: queryHash, offset: offset + query.limit })).toString("base64url");
    }
    return {
        version: 1 as const, asOf: input ? iso(input.at) : null, network: networkOf(book.isTestnet), snapshotId: snapshot?.id ?? null,
        evidenceId: id ?? null, status: !valid ? snapshot ? "stale" : "unavailable" : rows.length ? "research_candidates" : "no_qualified_candidates",
        scanned: output?.coverage.fresh ?? 0, coverage: output?.coverage ?? { eligible: snapshot?.instruments.length ?? 0, fresh: 0, structural: 0, missingFilter: 0, filteredOut: 0 },
        query: criteria, totalMatches: rows.length, nextCursor, researchShortlist, researchLanes,
        comparisonBrief: comparisonSlate(researchLanes, researchShortlist),
        held: [...new Set([...inventory, ...orders].map(r => r.instrumentId))].map(receipt),
        nominations: query.nominate.map(receipt),
    };
}
export type ScreenResult = Awaited<ReturnType<typeof screenBook>>;

export async function featureDiscovery(isTestnet: boolean) {
    const input = await currentInputs({ isTestnet });
    if (!input.numeric || input.at - input.numeric.asOf > 2 * minute || input.numeric.asOf > input.at) return null;
    return { snapshot: input.numeric, catalysts: input.news.catalysts, at: input.at };
}
