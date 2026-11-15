// @vitest-environment node
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { randomUUID, webcrypto } from "node:crypto";
import { chatRequestId } from "@/components/desk/chat-request-id";
import { deskChat } from "@/lib/desk/chat";
import { PrismaClient as PgClient } from "@prisma/app-postgres-client";
import { registerAppPostgres } from "@/lib/app-database-provider";
import { prisma as appClient } from "@/lib/db";
import { PrismaClient, type DeskBook } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskTurn } from "@/lib/desk/runtime";
import type { RevisionDetails } from "@/lib/news/desk-routing";

const fixture = vi.hoisted(() => ({
    client: null as PrismaClient | null,
    metadataDown: false,
    model: vi.fn<[DeskTurn], Promise<string>>(),
    quote: vi.fn(),
    preview: vi.fn(),
    mids: vi.fn(),
    exposure: vi.fn(),
    newsRows: vi.fn(),
    latest: vi.fn(),
    watchFailures: 0,
}));
vi.mock("@/lib/desk/routine-work", async original => {
    const actual = await original<typeof import("@/lib/desk/routine-work")>();
    return { ...actual, requestWatch: async (...args: Parameters<typeof actual.requestWatch>) => {
        if (fixture.watchFailures > 0) {
            fixture.watchFailures--;
            await actual.requestWatch(...args); // The failed transaction must roll this insert back.
            throw Object.assign(new Error("Transaction already closed: expired transaction"), { code: "P2028" });
        }
        return actual.requestWatch(...args);
    } };
});
vi.mock("@/lib/desk/execution", async (orig) => ({
    ...(await orig<typeof import("@/lib/desk/execution")>()),
    previewDeskOrder: fixture.preview,
}));
vi.mock("@/lib/db", () => ({
    prisma: new Proxy(
        {},
        {
            get(_, property) {
                if (!fixture.client) throw new Error("Test database is unavailable");
                const value = Reflect.get(fixture.client, property);
                return typeof value === "function" ? value.bind(fixture.client) : value;
            },
        },
    ),
}));
vi.mock("@/lib/news-db", () => ({
    newsDb: { newsEventRevision: { findMany: fixture.newsRows, groupBy: fixture.latest } },
}));
vi.mock("@/lib/market-db", () => ({
    marketDbMain: { marketTick: { findMany: async () => [] }, marketCandle: { findMany: async () => [] } },
    marketDbTest: { marketTick: { findMany: async () => [] }, marketCandle: { findMany: async () => [] } },
}));
vi.mock("@/lib/desk/runtime", async (orig) => ({
    ...(await orig<typeof import("@/lib/desk/runtime")>()),
    codexDeskTransport: fixture.model,
}));
vi.mock("@/lib/desk/instruments", async (orig) => {
    const actual = await orig<typeof import("@/lib/desk/instruments")>();
    return {
        ...actual,
        listInstruments: async (test: boolean) => {
            if (fixture.metadataDown) throw new Error("metadata unavailable");
            return actual.nativeInstruments(test, [{ name: "SOL", szDecimals: 2 }], { tokens: [], universe: [] });
        },
    };
});
vi.mock("@/lib/desk/market", async (orig) => ({
    ...(await orig<typeof import("@/lib/desk/market")>()),
    collectMids: fixture.mids,
    accountExposure: fixture.exposure,
    publicQuote: fixture.quote,
}));

import { TradingDeskWorker } from "@/services/TradingDeskWorker";
import { queueWake, operatorMessage } from "@/lib/desk/books";
import { claimShift, runShift } from "@/lib/desk/shifts";
import { deskTools } from "@/lib/desk/tools";
import { ingestNews, processWatches, sampleMarket, wakeOnFills } from "@/lib/desk/triggers";
import { DEFAULT_DESK_MANDATE, SWING_DESK_MANDATE } from "@/lib/desk/mandate";
import { type RoleNote } from "@/lib/desk/roles";
import { reviewSchedule, verifiedFlatBook } from "@/lib/desk/review-schedule";
import { portfolioContext } from "@/lib/desk/portfolio-context";
import { savePortfolioCoverage, recentPortfolioCoverage } from "@/lib/desk/portfolio-coverage";
import { advanceDiscovery } from "@/lib/desk/discovery-queue";
import { discoverMarket } from "@/lib/desk/discovery";
import { nativeInstruments } from "@/lib/desk/instruments";
import { monitorLiquidityWatches } from "@/lib/desk/pass-review";
import { admitReview } from "@/lib/desk/review-triage";
import { syncDiscoveryReviews } from "@/lib/desk/review-memory";
import { catalystInvestigation } from "@/lib/desk/catalyst-memory";
import { checkpointRoleNote, scheduleRoleFollowUp, reserveBacktestRun } from "@/lib/desk/journal";
import { loadTradeProposals, saveTradeProposal, loadTradeProposalReviews, type ProposalDraft } from "@/lib/desk/proposals";

const owner = "0x" + "a".repeat(40);
const sub = "0x" + "b".repeat(40);
const eventKey = "contract-settlement";
const sol = "mainnet:perp:SOL";
let directory: string;
let db: PrismaClient;
let url: string;

async function newBook(accountAddress = owner) {
    return db.deskBook.create({
        data: {
            accountAddress,
            ownerAddress: owner,
            isTestnet: false,
            enabled: true,
            kind: "directional",
            nextReviewAt: new Date(Date.now() + 3600000),
            mandateJson: JSON.stringify(DEFAULT_DESK_MANDATE),
        },
    });
}
function note(role: string): RoleNote {
    return {
        summary: role + " reviewed the notice",
        thesis: role === "lead" ? "Pass until liquidity recovers" : "Depth is thin",
        invalidation: "Fresh deep quotes",
        evidenceIds: [eventKey],
        dissent: role === "risk" ? "Do not increase exposure" : "",
        followUpAt: null,
    };
}
function tool(turn: DeskTurn, name: string, args: Record<string, unknown>) {
    const fn = turn.tools.find((t) => t.name === name);
    if (!fn) throw new Error("Missing fixture tool " + name);
    return fn.run(args, { role: turn.role, shiftId: turn.shiftId, callId: randomUUID(), signal: turn.signal! });
}
function proposalDraft(): ProposalDraft {
    return { key: "sol-dislocation", expectedRevision: 0, status: "researching", thesis: "Possible relative mispricing",
        horizon: "Next funding interval", invalidation: "Spread widens", missingEvidence: ["Exit liquidity"], evidenceIds: [eventKey],
        researchPlan:[{id:"exit",gap:"Exit liquidity",owner:"execution",question:"What exit liquidity is available?",nextTool:"order_book",completionCriteria:"Observe a fresh executable exit book",status:"waiting_external",result:"Awaiting a new venue liquidity observation",evidenceIds:[]}],
        legs: [{ instrumentId: sol, side: "sell", quantity: null, entryPrice: null }], economics: "Unknown exit spread",
        validUntil: new Date(Date.now() + 3600000).toISOString() };
}
function setupNews(catalyst = false) {
    const at = new Date().toISOString();
    const info: RevisionDetails = {
        material: true,
        verified: true,
        previousId: null,
        firstSeenAt: at,
        publishedAt: at,
        availableAt: at,
        digest: "material-fact",
        origins: [],
        signal: {
            eventKey,
            symbols: ["SOL"],
            category: "delisting",
            summary: "Venue confirms a settlement schedule",
            direction: "neutral",
            confidence: 1,
            materiality: 1,
            claimType: "confirmed_announcement",
            horizon: "short_term",
            corroboration: "Venue",
            contradictions: [],
            evidenceIds: ["fixture"],
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            facts: {
                subject: { name: "SOL", symbol: "SOL", venue: "Hyperliquid", contract: null, chain: null },
                factKey: "scheduled",
                impact: "operational_risk",
                change: "announcement",
                deadline: null,
                targets: [
                    {
                        relation: "venue",
                        symbol: "SOL",
                        contract: null,
                        instrumentKind: "perp",
                        mechanism: "Contract settles",
                    },
                ],
                origins: [],
            },
        },
    };
    if (catalyst) {
        info.signal.facts!.impact = "catalyst";
        info.signal.facts!.targets[0].relation = "direct";
    }
    const row = { id: 41, eventKey, detailsJson: JSON.stringify(info) };
    fixture.newsRows.mockImplementation(async (q) => (!q.where.id || q.where.id.gt < 41 ? [row] : []));
    fixture.latest.mockResolvedValue([{ eventKey, _max: { id: 41 } }]);
    fixture.exposure.mockImplementation(async (b: DeskBook) => ({
        positions: b.accountAddress === owner ? [{ coin: "SOL", quantity: "1" }] : [],
        spot: [],
        openOrders: [],
    }));
}

const pgFixture = process.env.DESK_TEST_POSTGRES_URL;
const Client = (pgFixture ? PgClient : PrismaClient) as typeof PrismaClient;
let schema: string;
let fixtureRoot: string;
beforeAll(async () => {
    if (pgFixture) {
        const address = new URL(pgFixture);
        if (address.hostname !== "127.0.0.1" || !/^\/centrypto_test_\w+$/.test(address.pathname))
            throw new Error("Use a dedicated local centrypto_test_* PostgreSQL database");
        registerAppPostgres(appClient);
        return;
    }
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "centrypto-desk-migrations-"));
    const seed = "file:" + path.join(fixtureRoot, "seed.db");
    execFileSync(
        process.execPath,
        [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", "prisma/schema.prisma"],
        {
            env: { ...process.env, DATABASE_URL: seed },
            stdio: "pipe",
            timeout: 30000,
        },
    );
}, 35000);
afterAll(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

beforeEach(async () => {
    vi.clearAllMocks();
    fixture.metadataDown = false;
    fixture.watchFailures = 0;
    fixture.exposure.mockReset().mockResolvedValue({ positions: [], openOrders: [], spot: [] });
    fixture.newsRows.mockReset().mockResolvedValue([]);
    fixture.latest.mockReset().mockResolvedValue([]);
    fixture.mids.mockReset().mockResolvedValue([]);
    fixture.preview.mockReset();
    fixture.model.mockReset();
    fixture.quote.mockImplementation(async () => ({ bid: 99, ask: 101, time: Date.now(),
        bids:[{px:"99",sz:"10"}],asks:[{px:"101",sz:"10"}] }));
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            throw new Error("Network disabled in fixture");
        }),
    );
    vi.stubEnv("NEWS_COLLECTOR_OWNER_ADDRESS", owner);
    if (pgFixture) {
        schema = "fixture_" + randomUUID().replaceAll("-", "");
        const address = new URL(pgFixture);
        address.searchParams.set("schema", schema);
        url = address.toString();
        execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", "prisma/app-postgres/schema.prisma"],
            { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe", timeout: 30000 });
    } else {
        directory = await mkdtemp(path.join(os.tmpdir(), "centrypto-desk-cycle-"));
        url = "file:" + path.join(directory, "fixture.db") + "?connection_limit=1";
        await copyFile(path.join(fixtureRoot, "seed.db"), path.join(directory, "fixture.db"));
    }
    fixture.client = db = new Client({ datasources: { db: { url } } });
    if (pgFixture) registerAppPostgres(db);
});
afterEach(async () => {
    if (pgFixture && db && /^fixture_[a-f0-9]{32}$/.test(schema)) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db?.$disconnect();
    fixture.client = null;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
});

describe("desk worker shift with local-only exchange and Codex fixtures", () => {
    async function admissionFixture() {
        const book = await newBook(), now = Date.now();
        const items = nativeInstruments(false, [{ name: "SOL", szDecimals: 2 }], { tokens: [], universe: [] });
        const tick = { symbol: "SOL", ts: new Date(now), markPrice: 105, openInterest: 100, fundingRate: 0, volume24h: 10000 };
        const scan = discoverMarket(items, [tick], [{ ...tick, markPrice: 100 }], [{ ...tick, markPrice: 100 }], [], [], now);
        const state = advanceDiscovery(null, scan, now)!;
        await db.deskRecord.create({ data: { bookId: book.id, key: `opportunity-state:${book.version}`, kind: "opportunity_state", role: "host", dataJson: JSON.stringify(state) } });
        const shift = await db.deskShift.create({ data: { bookId: book.id, version: book.version, mode: "live", status: "running",
            lease: randomUUID(), leaseUntil: new Date(now + 90000), briefJson: JSON.stringify({ triggers: [{ id: "discovery", kind: "opportunity_scan",
                payload: { comparisonBrief: { candidates: [{ instrumentId: sol, nominatedFrom: "priority_entry" }] } } }] }) } });
        return { book, shift, state };
    }
    const triageResponse = (decision: "review" | "monitor") => JSON.stringify({ candidates: [{ instrumentId: sol, decision,
        reason: decision === "review" ? "Changed entry may repair earlier payoff" : "Previous objection remains unchanged",
        nextEvidence: "Investigate whether the changed price preserves the thesis" }] });

    it("supplies portfolio capacity to triage and invalidates cached decisions after exposure changes without bypassing its budget", async () => {
        const { book, shift } = await admissionFixture();
        for (const instrumentId of ["mainnet:perp:BTC", "mainnet:perp:ETH"])
            await db.deskInventory.create({ data: { bookId: book.id, instrumentId, quantity: 1, basis: 100 } });
        fixture.model.mockImplementation(async turn => {
            expect(JSON.parse(turn.input).portfolio.capacity).toMatchObject({ occupiedOrReserved: 2, availableSlots: 0 });
            return triageResponse("review");
        });
        expect((await admitReview(book, shift, new AbortController().signal)).review).toBe(true);
        expect((await admitReview(book, shift, new AbortController().signal)).review).toBe(true);
        expect(fixture.model).toHaveBeenCalledTimes(1);
        await db.deskInventory.updateMany({ where: { bookId: book.id }, data: { quantity: 0 } });
        const result = await admitReview(book, shift, new AbortController().signal);
        expect(result.review).toBe(false);
        expect(result.opening.admission.cheapChecks).toContainEqual(expect.objectContaining({ reason: "Shared triage budget cooling down" }));
        expect(fixture.model).toHaveBeenCalledTimes(1);
        expect(fixture.exposure).not.toHaveBeenCalled();
        expect(await db.deskIntent.count({ where: { bookId: book.id } })).toBe(0);
    });

    it("calculates and journals hold/cash alternatives using owned exposure without orders or deadline changes", async () => {
        const { book, shift } = await admissionFixture(), openedAt = new Date(Date.now() - 3600000), deadline = new Date(Date.now() + 1800000).toISOString();
        await db.deskInventory.create({ data: { bookId: book.id, instrumentId: sol, quantity: 1, basis: 150, stopPrice: 90, since: openedAt } });
        await db.deskExecutionState.create({ data: { bookId: book.id, lastSync: new Date() } });
        const plan = JSON.stringify({ instrumentId: sol, openedAt: openedAt.toISOString(), maxHoldUntil: deadline, proposalKey: "owned-plan" });
        await db.deskRecord.create({ data: { bookId: book.id, key: "position-plan:" + sol, kind: "position_plan", role: "host", dataJson: plan } });
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ userCrossRate: ".001" }) })));
        const tools = deskTools(book, shift), ctx = { role: "lead" as const, shiftId: shift.id, callId: "portfolio", signal: new AbortController().signal };
        const scenario = { holdingInstrumentId: sol, candidateInstrumentId: null, candidateSide: null, candidateQuantity: null,
            horizonHours: 1, assumptions: "Conditional exit by original deadline then cash", evidenceIds: ["owned-plan"],
            scenarios: [110, 90].map(holdingExitPrice => ({ label: "Conditional scenario", basis: "Assumed executable exit by deadline", holdingExitPrice,
                holdingFundingUsd: 0, holdingOtherCostsUsd: 0, candidateExitPrice: null, candidateFundingUsd: null, candidateOtherCostsUsd: null, probability: null })) };
        const result = await tools.find(t => t.name === "assess_portfolio_choices")!.run(scenario, ctx) as any;
        expect(result).toMatchObject({ executionAuthorized: false, baseline: { currentHoldingMid: 100 }, originalDeadlineWithinHorizon: true });
        expect(result.outcomes[0].holdUsd).toBeCloseTo(9.89); // Old 150 basis must not anchor the choice.
        const quoteCalls = fixture.quote.mock.calls.length;
        const shared = (await tools.sharedObservations()).find(r => r.tool === "assess_portfolio_choices");
        expect(shared).toMatchObject({ holdingInstrumentId: sol, historical: true, executionAuthorized: false,
            quoteObservedAt: result.holdingQuoteAt, outcomes: [{ holdingExitPrice: 110 }, { holdingExitPrice: 90 }] });
        expect(fixture.quote).toHaveBeenCalledTimes(quoteCalls); // Handoff reads no new venue quote.
        await db.deskInventory.update({ where: { bookId_instrumentId: { bookId: book.id, instrumentId: sol } }, data: { stopPrice: 91 } });
        expect((await tools.sharedObservations()).some(r => r.tool === "assess_portfolio_choices")).toBe(false);
        await db.deskInventory.update({ where: { bookId_instrumentId: { bookId: book.id, instrumentId: sol } }, data: { stopPrice: 90 } });
        const alternative = { available: true, caseFor: "Specific supporting evidence", caseAgainst: "Specific contrary evidence", costs: "Current fee and spread accounted", uncertainty: "Future prices are unestimated", evidenceIds: ["owned-plan"] };
        const choice = { holdingInstrumentId: sol, candidateInstrumentId: null, horizonHours: .25, valuationBasis: "Current price with sunk entry excluded",
            priceEvidenceId: null, priceClaims: [], forwardCase: { advantageOverCash: "Conditional forward benefit after fees", evidenceWeighting: "Demand evidence outweighs uncertain downside", remainingTimeCase: "Thesis can resolve within remaining time", assumptionAtRisk: "Demand must persist to justify exposure" },
            hold: alternative, exitToCash: alternative, rotate: { ...alternative, available: false, caseAgainst: "No credible replacement on this slate" },
            livePriceReconciliation: "Live bid and completed close differ; horizon supports holding under explicit uncertainty", choice: "hold", reason: "Forward evidence favors holding after costs", changeCondition: "Changed thesis evidence would reverse choice" };
        const receipt = await tools.find(t => t.name === "record_portfolio_comparison")!.run(choice, { ...ctx, callId: "journal-choice" });
        expect(receipt).toMatchObject({ recorded: true, executionAuthorized: false, portfolioRecorded: true });
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "portfolio_comparison" } })).toBe(1);
        expect(await db.deskIntent.count({ where: { bookId: book.id } })).toBe(0);
        expect((await db.deskRecord.findUniqueOrThrow({ where: { bookId_key: { bookId: book.id, key: "position-plan:" + sol } } })).dataJson).toBe(plan);
        expect((await db.deskBook.findUniqueOrThrow({ where: { id: book.id } })).mandateJson).toBe(book.mandateJson);
    });

    it.each(["risk", "fill", "correction", "missed_fill"])("handles %s immediately and queues unrelated candidates for admission without renewing their expiry", async kind => {
        const { book, shift } = await admissionFixture();
        const event = JSON.parse(shift.briefJson).triggers[0];
        const expiresAt = new Date(Date.now() + 120000);
        const source = await db.deskWake.create({ data: { bookId: book.id, version: book.version, key: "mixed-source",
            kind: "opportunity_scan", mode: "live", priority: 6, shiftId: shift.id, dueAt: new Date(), payload: JSON.stringify(event.payload), expiresAt } });
        event.id = source.id;
        const opening = { triggers: [event, { id: "required", kind, priority: kind === "risk" ? 10 : 5, payload: {} }] };
        const current = await db.deskShift.update({ where: { id: shift.id }, data: { briefJson: JSON.stringify(opening) } });
        fixture.exposure.mockClear(); fixture.model.mockClear();
        for (let retry = 0; retry < 2; retry++) {
            const admitted = await admitReview(book, current, new AbortController().signal);
            expect(admitted.review).toBe(true);
            expect(admitted.opening.triggers.map((t: any) => t.kind)).toEqual([kind]);
            expect(admitted.opening.admission).toMatchObject({ requiredWorkOnly: true, deferredInstrumentIds: [sol], modelCalled: false });
        }
        expect(fixture.model).not.toHaveBeenCalled();
        expect(fixture.exposure).not.toHaveBeenCalled();
        const queued = await db.deskWake.findMany({ where: { bookId: book.id, key: { startsWith: "candidate-admission:" } } });
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({ shiftId: null, expiresAt });
        expect(JSON.parse(queued[0].payload).comparisonBrief.candidates).toHaveLength(1);
        // The queued candidate must pass the ordinary gate on its next review.
        await db.deskShift.update({ where: { id: shift.id }, data: { status: "completed", endedAt: new Date(), lease: null, leaseUntil: null } });
        const next = await db.deskShift.create({ data: { bookId: book.id, version: book.version, mode: "live", status: "running",
            lease: randomUUID(), leaseUntil: new Date(Date.now() + 90000), briefJson: JSON.stringify({ triggers: [{
                id: queued[0].id, kind: queued[0].kind, priority: queued[0].priority, payload: JSON.parse(queued[0].payload) }] }) } });
        fixture.model.mockResolvedValue(triageResponse("monitor"));
        expect((await admitReview(book, next, new AbortController().signal)).review).toBe(false);
        expect(fixture.model).toHaveBeenCalledTimes(1);
        expect(await db.deskIntent.count({ where: { bookId: book.id } })).toBe(0);
    });

    it.each(["review", "monitor", "failure"] as const)("combines scheduled work with discovery admission (%s) without a second wake", async decision => {
        const { book, shift } = await admissionFixture();
        const opening = JSON.parse(shift.briefJson); opening.triggers.push({ id: "scheduled", kind: "scheduled", priority: 1, payload: {} });
        const current = await db.deskShift.update({ where: { id: shift.id }, data: { briefJson: JSON.stringify(opening) } });
        if (decision === "failure") fixture.model.mockRejectedValue(new Error("Triage unavailable"));
        else fixture.model.mockResolvedValue(triageResponse(decision));
        const result = await admitReview(book, current, new AbortController().signal);
        expect(result.review).toBe(true);
        expect(result.opening.triggers.map((t: any) => t.kind)).toEqual(decision === "review" ? ["scheduled", "opportunity_scan"] : ["scheduled"]);
        expect(result.opening.admission.scheduledPortfolioReview).toBe(true);
        expect(result.opening.admission.requiredWorkOnly).toBe(decision !== "review");
        expect(await db.deskWake.count({ where: { bookId: book.id, key: { startsWith: "candidate-admission:" } } })).toBe(0);
        expect(await db.deskIntent.count({ where: { bookId: book.id } })).toBe(0);
    });

    it("combines a scheduled holding nomination with unrelated admitted discovery", async () => {
        const { book, shift } = await admissionFixture(), held = "mainnet:perp:BTC";
        await db.deskInventory.create({ data: { bookId: book.id, instrumentId: held, quantity: 1, basis: 100 } });
        const opening = JSON.parse(shift.briefJson);
        opening.triggers[0].payload.comparisonBrief.candidates.push({ instrumentId: held, nominatedFrom: "priority_entry" });
        opening.triggers.push({ id: "scheduled", kind: "scheduled", priority: 1, payload: {} });
        const current = await db.deskShift.update({ where: { id: shift.id }, data: { briefJson: JSON.stringify(opening) } });
        fixture.model.mockImplementation(async turn => {
            expect(JSON.parse(turn.input).candidates.map((c: any) => c.instrumentId)).toEqual([sol]);
            return triageResponse("review");
        });
        const admitted = await admitReview(book, current, new AbortController().signal);
        expect(admitted.review).toBe(true); expect(admitted.opening.triggers.map((t: any) => t.kind)).toEqual(["scheduled", "opportunity_scan"]);
        expect(await db.deskWake.count({ where: { bookId: book.id, key: { startsWith: "candidate-admission:" } } })).toBe(0);
    });

    it("separates flat reconciliation issues from holdings and refuses redundant exit journals", async () => {
        const {book,shift}=await admissionFixture();
        await db.deskInventory.create({data:{bookId:book.id,instrumentId:sol,quantity:0,basis:0,suspended:true,reason:"Exchange inventory differs from desk ledger"}});
        const context=await portfolioContext(db,book);
        expect(context.holdings).toEqual([]);expect(context.reconciliationIssues).toHaveLength(1);
        expect(context.reconciledRecently).toBe(false);
        expect(context.capacity.occupiedOrReserved).toBe(1);
        const receipt=await deskTools(book,shift).find(t=>t.name==="record_portfolio_comparison")!.run({holdingInstrumentId:sol},
            {role:"lead",shiftId:shift.id,callId:"closed",signal:new AbortController().signal});
        expect(receipt).toMatchObject({recorded:false,portfolioRecorded:false,status:"no_owned_holding"});
        expect(await db.deskRecord.count({where:{kind:"portfolio_comparison"}})).toBe(0);
    });
    it("keeps both holding journals, checks quote claims, and persists only complete unchanged coverage", async () => {
        const { book, shift } = await admissionFixture(), other = "mainnet:perp:BTC";
        for (const instrumentId of [sol, other]) await db.deskInventory.create({ data: { bookId: book.id, instrumentId, quantity: 1, basis: 100, stopPrice: 90, targetPrice: 110 } });
        await db.deskExecutionState.create({ data: { bookId: book.id, lastSync: new Date() } });
        const tools = deskTools(book, shift), ctx = { role: "lead" as const, shiftId: shift.id, callId: "quote", signal: new AbortController().signal };
        const q = await tools.find(t => t.name === "order_book")!.run({ instrumentId: sol }, ctx) as any;
        const alternative = { available: true, caseFor: "Observed current support", caseAgainst: "Uncertain remaining demand", costs: "Spread and future fees", uncertainty: "No calibrated probabilities", evidenceIds: ["snapshot"] };
        const choice = { holdingInstrumentId: sol, candidateInstrumentId: null, horizonHours: .25, valuationBasis: "Forward prices exclude entry cost",
            hold: alternative, exitToCash: alternative, rotate: { ...alternative, available: false }, livePriceReconciliation: "Live is below the cited level",
            choice: "hold", reason: "Conditional demand advantage after costs", changeCondition: "Loss of demand changes the choice", priceEvidenceId: q.priceEvidenceId,
            priceClaims: [{ referencePrice: 105, liveRelation: "above" }], forwardCase: { advantageOverCash: "Demand may outweigh future fees", evidenceWeighting: "Demand support outweighs adverse payoff under stated uncertainty", remainingTimeCase: "Mechanism may resolve within original horizon", assumptionAtRisk: "Observed demand must persist" } };
        const journal = tools.find(t => t.name === "record_portfolio_comparison")!;
        await expect(journal.run(choice, { ...ctx, callId: "bad-claim" })).rejects.toThrow("live is below");
        choice.priceClaims[0].liveRelation = "below";
        await journal.run(choice, { ...ctx, callId: "sol" });
        const embedded = { ...choice, holdingInstrumentId: other, priceEvidenceId: null, priceClaims: [] };
        await tools.find(t => t.name === "record_candidate_comparison")!.run({ candidates: [], preferredInstrumentId: null,
            relativeReason: "No credible new candidate", coverageReason: "Portfolio comparison has priority", portfolioChoice: embedded }, { ...ctx, callId: "other" });
        await journal.run({ ...choice, reason: "Updated forward reason for same holding" }, { ...ctx, callId: "sol-update" });
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "portfolio_comparison" } })).toBe(2);
        expect((await portfolioContext(db, book)).recentChoices).toHaveLength(2);
        expect(await savePortfolioCoverage(db, book, shift.id, new Date())).toBe(false); // Running is never coverage.
        await db.deskShift.update({ where: { id: shift.id }, data: { status: "completed", endedAt: new Date() } });
        expect(await savePortfolioCoverage(db, book, shift.id, new Date())).toBe(false); // No final lead note.
        await db.deskRecord.create({ data: { bookId: book.id, shiftId: shift.id, key: "lead-note", kind: "note", role: "lead", dataJson: "{}" } });
        const endedAt = new Date();
        expect(await savePortfolioCoverage(db, book, shift.id, endedAt)).toBe(true);
        const context = await portfolioContext(db, book);
        expect(await recentPortfolioCoverage(db, book, context)).toMatchObject({ shiftId: shift.id });
        const dueBook = { ...book, nextReviewAt: new Date(0) };
        expect(+(await reviewSchedule(db, dueBook, new Date())).dueAt).toBe(+endedAt + book.frequencySeconds * 1000);
        expect(await recentPortfolioCoverage(db, { ...book, version: book.version + 1 }, context)).toBeNull();
        expect(await recentPortfolioCoverage(db, book, { ...context, reconciledRecently: false })).toBeNull();
        expect(await recentPortfolioCoverage(db, book, { ...context, capacity: { ...context.capacity, pendingCommitments: 1 } })).toBeNull();
        for (const change of [{ quantity: 2 }, { stopPrice: 91 }, { targetPrice: 111 }, { originalExitDeadline: new Date().toISOString() }, { openedAt: new Date().toISOString() }])
            expect(await recentPortfolioCoverage(db, book, { ...context, holdings: context.holdings.map((h, i) => i ? h : { ...h, ...change }) })).toBeNull();
        expect(await recentPortfolioCoverage(db, book, context, +endedAt + book.frequencySeconds * 1000)).toBeNull();
        await db.deskRecord.deleteMany({ where: { bookId: book.id, kind: "portfolio_comparison", key: { endsWith: other } } });
        expect(await savePortfolioCoverage(db, book, shift.id, new Date())).toBe(false);
        expect(await db.deskIntent.count({ where: { bookId: book.id } })).toBe(0);
    });

    it("scopes a held-position bypass to that position, leaving unrelated nominees gated", async () => {
        const { book, shift } = await admissionFixture();
        const held = "mainnet:perp:BTC";
        await db.deskInventory.create({ data: { bookId: book.id, instrumentId: held, quantity: 1, basis: 100 } });
        const opening = JSON.parse(shift.briefJson);
        opening.triggers[0].payload.comparisonBrief.candidates.push({ instrumentId: held, nominatedFrom: "priority_entry" });
        const source = await db.deskWake.create({ data: { bookId: book.id, version: book.version, key: "held-mixed", kind: "opportunity_scan",
            mode: "live", priority: 6, shiftId: shift.id, dueAt: new Date(), expiresAt: new Date(Date.now() + 120000), payload: JSON.stringify(opening.triggers[0].payload) } });
        opening.triggers[0].id = source.id;
        const current = await db.deskShift.update({ where: { id: shift.id }, data: { briefJson: JSON.stringify(opening) } });
        const result = await admitReview(book, current, new AbortController().signal);
        expect(result.opening.triggers[0].payload.comparisonBrief.candidates.map((c: any) => c.instrumentId)).toEqual([held]);
        expect(result.opening.admission).toMatchObject({ requiredWorkOnly: true, requiredInstrumentIds: [held], deferredInstrumentIds: [sol] });
        expect(fixture.model).not.toHaveBeenCalled();
        const queued = await db.deskWake.findFirstOrThrow({ where: { bookId: book.id, key: { startsWith: "candidate-admission:" } } });
        expect(JSON.parse(queued.payload).comparisonBrief.candidates.map((c: any) => c.instrumentId)).toEqual([sol]);
    });

    it("defers a triage rejection without loading the full desk or creating orders", async () => {
        const { book, shift } = await admissionFixture();
        fixture.model.mockImplementation(async turn => {
            expect(turn.meter?.kind).toBe("triage"); expect(turn.tools).toEqual([]); expect(turn.effort).toBe("low");
            expect(turn.input.length + turn.instructions.length).toBeLessThan(14000);
            return triageResponse("monitor");
        });
        await runShift(book, shift, new AbortController().signal);
        expect((await db.deskShift.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe("deferred");
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "note" } })).toBe(0);
        expect(await db.deskIntent.count({ where: { bookId: book.id } })).toBe(0);
        expect(fixture.model).toHaveBeenCalledTimes(1);
        expect((await db.deskBook.findUniqueOrThrow({ where: { id: book.id } })).mandateJson).toBe(book.mandateJson);
    });

    it("persists approval across a restart and invalidates it when a new investigation arrives", async () => {
        const { book, shift } = await admissionFixture();
        fixture.model.mockResolvedValue(triageResponse("review"));
        expect((await admitReview(book, shift, new AbortController().signal)).review).toBe(true);
        await db.$disconnect(); fixture.client = db = new Client({ datasources: { db: { url } } });
        expect((await admitReview(book, shift, new AbortController().signal)).review).toBe(true);
        expect(fixture.model).toHaveBeenCalledTimes(1);
        await db.deskRecord.create({ data: { bookId: book.id, shiftId: shift.id, key: "comparison", kind: "candidate_comparison", role: "derivatives",
            dataJson: JSON.stringify({ candidates: [{ instrumentId: sol, stage: "investigated", mechanism: "Range recovery", objection: "Unchanged supply",
                nextStep: "Wait for changed economics", evidenceIds: ["fresh-investigation"] }] }) } });
        expect((await admitReview(book, shift, new AbortController().signal)).review).toBe(false);
        expect(fixture.model).toHaveBeenCalledTimes(1);
    });

    it("records investigations without collector evidence and does not treat recovery as a new opportunity", async () => {
        const { book, shift, state } = await admissionFixture();
        await db.deskRecord.create({ data: { bookId: book.id, shiftId: shift.id, key: "other-trigger-comparison", kind: "candidate_comparison", role: "lead",
            dataJson: JSON.stringify({ candidates: [{ instrumentId: sol, stage: "investigated", mechanism: "Recovery long", objection: "Liquidity unavailable",
                nextStep: "Wait for changed evidence", evidenceIds: ["market_history:" + sol] }] }) } });
        await db.$transaction(tx => syncDiscoveryReviews(tx, book));
        const record = await db.deskRecord.findUniqueOrThrow({ where: { bookId_key: { bookId: book.id, key: `opportunity-state:${book.version}` } } });
        const updated = JSON.parse(record.dataJson);
        expect(updated.reviews[sol]).toMatchObject({ observed: null, sourceShiftId: shift.id });
        const row = state.candidates[sol].observation;
        const recovered = advanceDiscovery(updated, { asOf: new Date().toISOString(), eligible: 1, scanned: 1, unavailable: 0,
            coverage: [{ ...row, observedAt: Date.now() + 1 }], priorityIds: [sol], rotationIds: [], shortlist: [], researchLanes: [], policy: "test" }, Date.now() + 1)!;
        expect(recovered.candidates[sol].reason).toBeNull();
        expect(recovered.reviews[sol].observed).not.toBeNull();
    });

    it("records a focused watch investigation even without a comparison journal", async () => {
        const { book, shift } = await admissionFixture();
        await db.deskShift.update({ where: { id: shift.id }, data: { briefJson: JSON.stringify({ triggers: [{ kind: "watch", payload: { instrumentId: sol } }] }) } });
        await db.deskRecord.create({ data: { bookId: book.id, shiftId: shift.id, key: "focused-note", kind: "note", role: "lead",
            dataJson: JSON.stringify({ thesis: "Recovery still blocked", dissent: "Depth not recovered", invalidation: "Changed depth",
                evidenceIds: ["order_book:" + sol + ":fresh"] }) } });
        await db.$transaction(tx => syncDiscoveryReviews(tx, book));
        const row = await db.deskRecord.findUniqueOrThrow({ where: { bookId_key: { bookId: book.id, key: `opportunity-state:${book.version}` } } });
        expect(JSON.parse(row.dataJson).reviews[sol].mechanism).toBe("Recovery still blocked");
    });

    it("backfills old numerical checkpoints with the latest written objection without resetting their cooldown", async () => {
        const { book, shift, state } = await admissionFixture();
        const reviewedAt = Date.now() + 1000, observed = state.candidates[sol].observation;
        state.reviews[sol] = { reviewedAt, observed };
        state.reviewCursor = 999999; // An earlier producer already advanced its cursor without summaries.
        await db.deskRecord.update({ where: { bookId_key: { bookId: book.id, key: `opportunity-state:${book.version}` } }, data: { dataJson: JSON.stringify(state) } });
        for (const objection of ["Older range objection", "Latest entry economics objection"]) {
            await db.deskRecord.create({ data: { bookId: book.id, shiftId: shift.id, key: objection, kind: "candidate_comparison", role: "lead",
                dataJson: JSON.stringify({ candidates: [{ instrumentId: sol, stage: "investigated", mechanism: "Recovery long", objection,
                    nextStep: "Reconsider changed payoff", evidenceIds: [objection] }] }) } });
            await new Promise(resolve => setTimeout(resolve, 2));
        }
        await db.$transaction(tx => syncDiscoveryReviews(tx, book));
        const saved = JSON.parse((await db.deskRecord.findUniqueOrThrow({ where: { bookId_key: { bookId: book.id, key: `opportunity-state:${book.version}` } } })).dataJson);
        expect(saved.reviews[sol]).toMatchObject({ reviewedAt, observed, objection: "Latest entry economics objection" });
        expect(saved.reviewMemoryVersion).toBe(1);
    });

    it("blocks a one-sided recovery before inference and rearms its existing watch without extending the deadline", async () => {
        const { book, shift } = await admissionFixture();
        const deadline = new Date(Date.now() + 600000);
        const watch = await db.deskWatch.create({ data: { bookId: book.id, key: `routine:lead:${book.version}:live:depth`, mode: "live", kind: "pass",
            instrumentId: sol, side: "sell", thesis: "Wait for recovered bids", deadline, outcomeJson: JSON.stringify({ revisitWhen: "bid_depth", depthReopenedAt: new Date().toISOString() }) } });
        const wake = { id: "watch", kind: "watch", payload: { instrumentId: sol, watchId: watch.id, condition: "depth_recovery" } };
        shift.briefJson = JSON.stringify({ triggers: [wake] });
        await db.deskShift.update({ where: { id: shift.id }, data: { briefJson: shift.briefJson } });
        fixture.quote.mockImplementation(async () => ({ time: Date.now(), bid: 99.99, ask: 100.01,
            bids: [{ px: "99.99", sz: "100" }], asks: [{ px: "100.01", sz: ".1" }, { px: "101", sz: "100" }] }));
        expect((await admitReview(book, shift, new AbortController().signal)).review).toBe(false);
        expect(fixture.model).not.toHaveBeenCalled();
        const after = await db.deskWatch.findUniqueOrThrow({ where: { id: watch.id } });
        expect(after.deadline).toEqual(deadline);
        expect(JSON.parse(after.outcomeJson!).depthReopenedAt).toBeUndefined();
        expect(JSON.parse(after.outcomeJson!).admissionRetryAt).toBeGreaterThan(Date.now());
    });

    it("does not interpret incomplete liquidity as a reason to suppress discovery", async () => {
        const { book, shift } = await admissionFixture();
        await db.deskWatch.create({ data: { bookId: book.id, key: `routine:lead:${book.version}:live:depth`, mode: "live", kind: "pass",
            instrumentId: sol, thesis: "Wait for depth", deadline: new Date(Date.now() + 600000), outcomeJson: JSON.stringify({ revisitWhen: "both_depth" }) } });
        fixture.quote.mockImplementation(async () => ({ time: Date.now(), bid: 99.99, ask: 100.01,
            bids: [{ px: "99.99", sz: ".1" }], asks: [{ px: "100.01", sz: ".1" }] }));
        fixture.model.mockImplementation(async turn => {
            expect(JSON.parse(turn.input).candidates[0].liquidity.status).toBe("unavailable"); return triageResponse("review");
        });
        expect((await admitReview(book, shift, new AbortController().signal)).review).toBe(true);
    });

    it("backs off malformed triage and allows urgent and actual-fill reviews without invoking triage", async () => {
        const { book, shift } = await admissionFixture();
        fixture.model.mockResolvedValue("not json");
        expect((await admitReview(book, shift, new AbortController().signal)).review).toBe(false);
        const row = await db.deskRecord.findUniqueOrThrow({ where: { bookId_key: { bookId: book.id, key: `review-triage-state:${book.version}` } } });
        expect(JSON.parse(row.dataJson).nextAt - Date.now()).toBeGreaterThan(590000);
        for (const kind of ["risk", "correction", "fill", "scheduled", "operator"]) {
            const urgent = { ...shift, briefJson: JSON.stringify({ triggers: [{ id: "urgent", kind, payload: { kind: "fill" } }] }) };
            expect((await admitReview(book, urgent, new AbortController().signal)).review).toBe(true);
        }
        expect(fixture.model).toHaveBeenCalledTimes(1);
    });

    it("keeps funding in the ledger while actual fills still wake the desk exactly once", async () => {
        const book = await newBook();
        for (const kind of ["funding", "fill"]) await db.deskCashFlow.create({ data: { bookId: book.id, venueKey: kind, instrumentId: sol,
            kind, quantity: kind === "fill" ? 2 : 0, price: kind === "fill" ? 100 : 0, feeUsd: 0, pnlUsd: .003378, shortfallUsd: 0, occurredAt: new Date() } });
        await wakeOnFills(book); await wakeOnFills(book);
        const wakes = await db.deskWake.findMany({ where: { bookId: book.id } });
        expect(wakes).toHaveLength(1); expect(JSON.parse(wakes[0].payload).kind).toBe("fill");
        expect(await db.deskCashFlow.count({ where: { bookId: book.id } })).toBe(2);
    });

    it("checks depth again after triage so a transient recovery cannot launch the full review", async () => {
        const { book, shift } = await admissionFixture();
        const watch = await db.deskWatch.create({ data: { bookId: book.id, key: `routine:lead:${book.version}:live:depth`, mode: "live", kind: "pass",
            instrumentId: sol, thesis: "Depth recovered", deadline: new Date(Date.now() + 600000), outcomeJson: JSON.stringify({ revisitWhen: "both_depth" }) } });
        shift.briefJson = JSON.stringify({ triggers: [{ id: "watch", kind: "watch", payload: { condition: "depth_recovery", instrumentId: sol, watchId: watch.id } }] });
        fixture.quote.mockResolvedValueOnce({ time: Date.now(), bid: 99.99, ask: 100.01,
            bids: [{ px: "99.99", sz: "100" }], asks: [{ px: "100.01", sz: "100" }] });
        fixture.model.mockResolvedValue(triageResponse("review"));
        expect((await admitReview(book, shift, new AbortController().signal)).review).toBe(false);
        expect(fixture.quote).toHaveBeenCalledTimes(2);
        expect(fixture.model).toHaveBeenCalledTimes(1);
    });

    it("drops unavailable discovery evidence from a coalesced market review after triage", async () => {
        const { book, shift, state } = await admissionFixture();
        const opening = JSON.parse(shift.briefJson);
        opening.triggers.push({ id: "move", kind: "market_move", payload: { moves: [{ instrumentId: sol, mid: 105, previous: 100, move: .05 }] } });
        shift.briefJson = JSON.stringify(opening);
        fixture.model.mockImplementation(async turn => {
            expect(JSON.parse(turn.input).candidates).toHaveLength(1);
            await db.deskRecord.update({ where: { bookId_key: { bookId: book.id, key: `opportunity-state:${book.version}` } },
                data: { dataJson: JSON.stringify({ ...state, candidates: {} }) } });
            return triageResponse("review");
        });
        const result = await admitReview(book, shift, new AbortController().signal);
        expect(result.review).toBe(true);
        expect(result.opening.triggers.map((t: { kind: string }) => t.kind)).toEqual(["market_move"]);
    });

    it("coalesces a completed flat portfolio review with the fallback but never treats triage as portfolio coverage", async () => {
        const { book, shift } = await admissionFixture();
        const now = new Date();
        book.nextReviewAt = new Date(+now - 1);
        await db.deskShift.update({ where: { id: shift.id }, data: { status: "deferred", endedAt: now,
            briefJson: JSON.stringify({ verifiedFlat: true, triggers: [{ kind: "opportunity_scan" }] }) } });
        expect((await reviewSchedule(db, book, now)).dueAt).toEqual(book.nextReviewAt);
        await db.deskShift.update({ where: { id: shift.id }, data: { status: "completed" } });
        await db.deskRecord.create({ data: { bookId: book.id, shiftId: shift.id, key: "lead-note", kind: "note", role: "lead", dataJson: "{}" } });
        expect(+(await reviewSchedule(db, book, now)).dueAt).toBe(+now + 1800000);
        fixture.exposure.mockRejectedValueOnce(Error("Exposure unavailable"));
        const unknown = await reviewSchedule(db, book, new Date(+now + 31000));
        expect(unknown.flat).toBe(false); expect(unknown.dueAt).toEqual(book.nextReviewAt);
    });

    it("claims durable discovery only after urgent work and records the investigated baseline", async () => {
        vi.stubEnv("DESK_DISCOVERY_MODE", "live");
        const created = await newBook();
        const now = Date.now();
        const book = await db.deskBook.update({ where: { id: created.id }, data: { nextReviewAt: new Date(now + 1800000) } });
        const items = nativeInstruments(false, [{ name: "SOL", szDecimals: 2 }], { tokens: [], universe: [] });
        const scan = (at: number) => {
            const tick = { symbol: "SOL", ts: new Date(at), markPrice: 105, openInterest: 10, volume24h: 1000, fundingRate: 0 };
            const older = { ...tick, markPrice: 100 };
            return discoverMarket(items, [tick], [older], [older], [], [], at);
        };
        const scanAt = now - 500;
        const state = advanceDiscovery(advanceDiscovery(null, scan(scanAt - 60000), scanAt - 60000), scan(scanAt), scanAt)!;
        const key = `opportunity-state:${book.version}`;
        await db.deskRecord.create({ data: { bookId: book.id, key, kind: "opportunity_state", role: "host", dataJson: JSON.stringify(state) } });
        await db.deskRecord.create({ data: { bookId: book.id, key: `opportunity-scan:${book.version}:${scanAt}`,
            kind: "opportunity_scan", role: "host", dataJson: JSON.stringify({ observations: [[sol, scanAt, 500, 500, null, null, 0, 0]] }) } });
        await queueWake(db, book, "urgent-discovery-test", "risk", "live", {}, 10, new Date(now));
        const urgent = (await claimShift(book, new Date(now)))!;
        expect(JSON.parse(urgent.briefJson).triggers.map((t: { kind: string }) => t.kind)).toEqual(["risk"]);
        await db.deskShift.update({ where: { id: urgent.id }, data: { status: "completed", endedAt: new Date(now) } });
        await db.$disconnect();
        fixture.client = db = new Client({ datasources: { db: { url } } });
        const shift = (await claimShift(book, new Date(now + 1)))!;
        expect(JSON.parse(shift.briefJson).triggers.map((t: { kind: string }) => t.kind)).toEqual(["opportunity_scan"]);
        fixture.model.mockImplementation(async turn => {
            expect(turn.role).toBe("lead");
            if (turn.meter?.kind === "triage") {
                expect(turn.tools).toEqual([]);
                expect(turn.budget?.wallMs).toBe(30000);
                return JSON.stringify({ candidates: [{ instrumentId: sol, decision: "review", reason: "New recovery warrants investigation", nextEvidence: "Inspect the surviving recovery and payoff" }] });
            }
            expect(JSON.parse(turn.input).opportunityScan.comparisonBrief.candidates[0]).toMatchObject({ instrumentId: sol, queueDelayMs: 501 });
            await tool(turn, "record_candidate_comparison", { candidates: [{ instrumentId: sol, mechanism: "Candidate recovery hypothesis", stage: "investigated",
                evidenceIds: ["test-evidence"], support: "Observed price returned to range", objection: "Current liquidity is insufficient", disposition: "pass", nextStep: "Wait for material new evidence" }],
                preferredInstrumentId: null, relativeReason: "Cash remains preferable after review", coverageReason: "Only one qualifying candidate in fixture" });
            return JSON.stringify(note("lead"));
        });
        await runShift(book, shift, new AbortController().signal);
        expect(fixture.model).toHaveBeenCalledTimes(2);
        const saved = await db.deskRecord.findUniqueOrThrow({ where: { bookId_key: { bookId: book.id, key } } });
        expect(JSON.parse(saved.dataJson).reviews[sol].observed.observedAt).toBe(scanAt);
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "opportunity_review" } })).toBe(1);
        expect(await claimShift(book, new Date(now + 60000))).toBeNull();
        expect(await db.deskIntent.count({ where: { bookId: book.id } })).toBe(0);
    });

    it("keeps incomplete liquidity actionable and wakes independently when sufficient depth appears", async () => {
        const book = await newBook();
        await db.deskWatch.create({ data: { bookId: book.id, key: `routine:lead:${book.version}:live:ask-depth`, mode: "live",
            kind: "pass", status: "open", deadline: new Date(Date.now() + 600000), instrumentId: sol, side: "buy",
            thesis: "Wait for compliant ask depth", outcomeJson: JSON.stringify({ revisitWhen: "ask_depth" }) } });
        let size = 1;
        fixture.quote.mockImplementation(async () => ({ time: Date.now(), bid: 99.99, ask: 100.01,
            bids: [{ px: "99.99", sz: String(size) }], asks: [{ px: "100.01", sz: String(size) }] }));
        const lastChecked = new Map<string, number>(), signal = new AbortController().signal;
        await monitorLiquidityWatches(book, lastChecked, signal);
        expect(await db.deskWake.count({ where: { bookId: book.id } })).toBe(0);
        const pass = await db.deskWatch.findFirstOrThrow({ where: { bookId: book.id } });
        expect(JSON.parse(pass.outcomeJson ?? "{}").depthBlockedAt).toBeUndefined();
        size = 50;
        await monitorLiquidityWatches(book, lastChecked, signal);
        await monitorLiquidityWatches(book, lastChecked, signal);
        expect(await db.deskWake.count({ where: { bookId: book.id, kind: "watch" } })).toBe(1);
    });

    it("delivers an HTTP-compatible chat request once and returns its matching lead reply", async () => {
        const created = await newBook();
        const book = await db.deskBook.update({ where: { id: created.id }, data: { enabled: false } });
        vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
        const data = { message: "Why did we pass on the last trade?", kind: "research", requestId: chatRequestId() };
        await operatorMessage(book, data);
        await operatorMessage(book, data);
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "message" } })).toBe(1);
        expect(await db.deskWake.count({ where: { bookId: book.id, kind: "operator" } })).toBe(1);
        expect((await deskChat(book.id, book.version))[0].status).toBe("queued");
        const shift = await claimShift(book);
        expect(shift?.mode).toBe("research");
        expect((await deskChat(book.id, book.version))[0].status).toBe("running");
        fixture.model.mockImplementation(async turn => JSON.stringify(note(turn.role)));
        await runShift(book, shift!, new AbortController().signal);
        const [conversation] = await deskChat(book.id, book.version);
        expect(conversation.status).toBe("answered");
        expect(conversation.reply?.shiftId).toBe(shift!.id);
        expect(JSON.parse(conversation.message.dataJson).message).toBe(data.message);
        expect(conversation.reply?.role).toBe("lead");
    });

    it("slows flat scheduled reviews to 30 minutes, preserves urgent events and restores cadence when exposure is unknown", async () => {
        fixture.exposure.mockResolvedValue({ positions: [], openOrders: [], spot: [{ token: 0, quantity: "500", locked: "0" }] });
        let book = await newBook();
        book = await db.deskBook.update({ where: { id: book.id }, data: { nextReviewAt: new Date(Date.now() - 1000) } });
        const first = await claimShift(book);
        expect(JSON.parse(first!.briefJson)).toMatchObject({ verifiedFlat: true, reviewIntervalSeconds: 1800 });
        await db.deskShift.update({ where: { id: first!.id }, data: { status: "completed" } });
        book = await db.deskBook.findUniqueOrThrow({ where: { id: book.id } });
        expect(+book.nextReviewAt - Date.now()).toBeGreaterThan(29 * 60000);
        expect(await claimShift(book, new Date(Date.now() + 11 * 60000))).toBeNull();
        await queueWake(db, book, "urgent-now", "risk", "live", { reason: "Venue incident" }, 10);
        const urgent = await claimShift(book);
        expect(JSON.parse(urgent!.briefJson).triggers.map((t: { kind: string }) => t.kind)).toEqual(["risk"]);
        fixture.exposure.mockRejectedValueOnce(Error("offline"));
        const restored = await reviewSchedule(db, book, new Date(Date.now() + 12 * 60000));
        expect(restored.flat).toBe(false);
        expect(restored.intervalSeconds).toBe(book.frequencySeconds);
        expect(+restored.dueAt).toBeLessThan(+book.nextReviewAt);
    });

    it("does not slow held, ordered, non-cash, reserved, suspended or quoting books", async () => {
        const exposures = [
            { positions: [{ quantity: "1" }], openOrders: [], spot: [] },
            { positions: [], openOrders: [{ coin: "SOL" }], spot: [] },
            { positions: [], openOrders: [], spot: [{ token: 641, quantity: "1", locked: "0" }] },
            { positions: [], openOrders: [], spot: [{ token: 0, quantity: "500", locked: "5" }] },
        ];
        for (const exposure of exposures) {
            const book = await newBook(randomUUID());
            fixture.exposure.mockResolvedValue(exposure);
            expect(await verifiedFlatBook(db, book)).toBe(false);
        }
        const book = await newBook(randomUUID());
        fixture.exposure.mockResolvedValue({ positions: [], openOrders: [], spot: [] });
        await db.deskInventory.create({ data: { bookId: book.id, instrumentId: sol, quantity: 0, basis: 0, suspended: true } });
        expect(await verifiedFlatBook(db, book)).toBe(false);
        expect(await verifiedFlatBook(db, { ...book, kind: "quoting" })).toBe(false);
        await db.deskInventory.deleteMany({ where: { bookId: book.id } });
        await db.deskIntent.create({ data: { bookId: book.id, intentKey: "pending", cloid: randomUUID(), instrumentId: sol,
            asset: 0, coin: "SOL", requestJson: "{}", fingerprint: "fixture", state: "unknown", policyVersion: 1,
            arrivalPrice: 100, quantity: 1, limitPrice: 100, reservedUsd: 50, side: "buy" } });
        expect(await verifiedFlatBook(db, book)).toBe(false);
    });

    it("reuses a prior full catalyst investigation and selectively refreshes it on a corrected story", async () => {
        vi.stubEnv("DESK_REVIEW_TRIAGE", "off"); // Exercise full-review reuse after admission.
        fixture.exposure.mockResolvedValue({ positions: [], openOrders: [], spot: [] });
        fixture.model.mockImplementation(async turn => {
            if (turn.role === "lead" && !JSON.parse(turn.input).roundtable.catalyst)
                await tool(turn, "consult_colleague", { role: "catalyst", question: "Check the changed announcement" });
            return JSON.stringify(note(turn.role));
        });
        const book = await newBook();
        const run = async (seedFullInvestigation = false) => {
            await queueWake(db, book, randomUUID(), "market_move", "live", { moves: [{ instrumentId: sol, move: .1 }] });
            const shift = await claimShift(book);
            if (seedFullInvestigation) {
                await checkpointRoleNote(db, book, shift!, "catalyst", note("catalyst"), new AbortController().signal);
                await (await catalystInvestigation(db, book, shift!))!.remember(note("catalyst"));
            }
            await runShift(book, shift!, new AbortController().signal);
            return shift!;
        };
        const first = await run(true);
        expect(fixture.model.mock.calls.filter(([t]) => t.role === "catalyst")).toHaveLength(0);
        const second = await run();
        expect(fixture.model.mock.calls.filter(([t]) => t.role === "catalyst")).toHaveLength(0);
        expect(fixture.model.mock.calls.filter(([t]) => t.role === "lead")).toHaveLength(2);
        const reused = await db.deskRecord.findFirstOrThrow({ where: { shiftId: second.id, kind: "note", role: "catalyst" } });
        expect(JSON.parse(reused.dataJson)).toMatchObject({ summary: expect.stringContaining("Prior catalyst assessment"),
            thesis: expect.stringContaining("not refreshed"), followUpAt: null });
        await db.deskWake.create({ data: { bookId: book.id, version: 1, key: "news:99", kind: "research", mode: "live",
            priority: 5, dueAt: new Date(), shiftId: first.id,
            payload: JSON.stringify({ eventKey: "correction", revisionId: 99, instrumentIds: [sol] }) } });
        await run();
        expect(fixture.model.mock.calls.filter(([t]) => t.role === "catalyst")).toHaveLength(1);
        const candidates = await db.deskRecord.findMany({ where: { kind: "catalyst_investigation" } });
        expect(candidates).toHaveLength(1);
    });

    it("expires investigations without extending their age on reuse and bypasses them for deadlines, operator work and new authority", async () => {
        fixture.exposure.mockResolvedValue({ positions: [], openOrders: [], spot: [] });
        const book = await newBook();
        await queueWake(db, book, "move", "market_move", "live", { moves: [{ instrumentId: sol }] });
        const shift = (await claimShift(book))!;
        let now = Date.now();
        const memo = await catalystInvestigation(db, book, shift, () => now);
        const original = { ...note("catalyst"), followUpAt: new Date(now + 5 * 60000).toISOString() };
        await memo!.remember(original);
        expect(await memo!.reuse()).not.toBeNull();
        now += 5 * 60000;
        expect(await memo!.reuse()).toBeNull();
        for (const kind of ["watch", "risk", "operator", "research", "fill"]) {
            expect(await catalystInvestigation(db, book, { ...shift,
                briefJson: JSON.stringify({ triggers: [{ kind }] }) })).toBeNull();
        }
        expect(await catalystInvestigation(db, book, { ...shift, mode: "research" })).toBeNull();
        const changed = await catalystInvestigation(db, { ...book, version: 2 }, { ...shift, version: 2 });
        expect(await changed!.reuse()).toBeNull();
    });

    it("links a priced pass to the matching live lead preview, including a venue error", async () => {
        const book = await newBook();
        const shift = await db.deskShift.create({ data: { bookId: book.id, version: book.version, mode: "live",
            status: "running", lease: "preview", leaseUntil: new Date(Date.now() + 60000), briefJson: '{"triggers":[]}' } });
        const tools = deskTools(book, shift);
        const ctx = { role: "lead" as const, shiftId: shift.id, signal: new AbortController().signal };
        const call = (name: string, callId: string, args: Record<string, unknown>) =>
            tools.find(t => t.name === name)!.run(args, { ...ctx, callId });
        const order = { instrumentId: sol, side: "buy", quantity: 1, limitPrice: 99, stopPrice: 95, thesis: "Defined catalyst" };
        const pass = { kind: "pass", instrumentId: sol, side: "buy", deadline: new Date(Date.now() + 3600000).toISOString(),
            thesis: "Net upside too small at the refreshed entry" };
        await expect(call("set_watch", "unexplained", pass)).rejects.toThrow("passBasis");
        fixture.preview.mockResolvedValueOnce({ limitPrice: 99, quantity: 1, depthTime: Date.now() });
        expect(await call("preview_order", "checked", order)).toMatchObject({ previewReceipt: "checked" });
        await expect(call("set_watch", "wrong-side", { ...pass, side: "sell", passBasis: "after_preview",
            previewReceipt: "checked" })).rejects.toThrow("instrument and side");
        const decision = await call("set_watch", "decision", { ...pass, passBasis: "after_preview", previewReceipt: "checked" });
        expect(decision).toMatchObject({ preview: { limitPrice: 99 }, decisionReason: pass.thesis });
        fixture.preview.mockRejectedValueOnce(new Error("Fresh depth unavailable"));
        await expect(call("preview_order", "unavailable", order)).rejects.toThrow("previewReceipt=unavailable");
        fixture.quote.mockRejectedValueOnce(new Error("No quote"));
        expect(await call("set_watch", "failed-check", { ...pass, thesis: "Venue did not return a fresh book",
            previewReceipt: "unavailable", passBasis: "after_preview" })).toMatchObject({ previewError: "Fresh depth unavailable" });
        expect(await db.deskIntent.count()).toBe(0);
    });

    it("keeps explicit ready historical work visible after the live ticket closes", async () => {
        const {researchBacklog}=await import("@/lib/desk/research-backlog");
        const book=await newBook();
        for(const [key,plan] of [["ready",[{status:"ready",nextTool:"backtest_strategy",evidenceIds:[]}]],["finished",[]]] as const)
            await db.deskRecord.create({data:{bookId:book.id,role:"lead",kind:"trade_proposal",key:`proposal:${book.version}:live:${key}`,
                dataJson:JSON.stringify({key,status:"closed",revision:1,legs:[],researchPlan:plan,validUntil:new Date(0).toISOString(),updatedAt:new Date().toISOString()})}});
        const backlog=await researchBacklog(db,book);
        expect(backlog.map(p=>p.proposalKey)).toEqual(["ready"]);
    });

    it("retrieves expired entry plans without treating them as permission", async () => {
        const book=await newBook();
        await queueWake(db,book,"plan-fixture","operator","research",{});
        const shift=(await claimShift(book))!;
        const ctx={role:"lead" as const,shiftId:shift.id,callId:"plan",signal:new AbortController().signal};
        const tool=deskTools(book,shift).find(t=>t.name==="trade_plan")!;
        expect(await tool.run({proposalKey:"missing"},ctx)).toMatchObject({status:"not_found"});
        await db.deskRecord.create({data:{bookId:book.id,role:"lead",kind:"trade_proposal",key:`proposal:${book.version}:live:expired`,
            dataJson:JSON.stringify({key:"expired",setup:{entryExpiresAt:new Date(0).toISOString()}})}});
        expect(await tool.run({proposalKey:"expired"},ctx)).toMatchObject({status:"found",entryExpired:true});
        expect(await db.deskIntent.count()).toBe(0);
    });

    it("finds instrument proposals older than unrelated desk traffic", async () => {
        const book = await newBook();
        const shift = await db.deskShift.create({ data: { bookId: book.id, version: book.version, mode: "live",
            status: "running", lease: "diagnostics", leaseUntil: new Date(Date.now() + 60000), briefJson: '{"triggers":[]}' } });
        await db.deskRecord.create({ data: { bookId: book.id, key: "old-proposal", kind: "trade_proposal", role: "lead",
            dataJson: JSON.stringify({ instrumentId: sol, thesis: "Preserve old relevant evidence" }) } });
        for (let i = 0; i < 101; i++) await db.deskRecord.create({ data: {
            bookId: book.id, key: "noise-" + i, kind: "tool_result", role: "lead", dataJson: '{"instrumentId":"mainnet:perp:OTHER"}'
        } });
        const diagnostics = deskTools(book, shift).find(t => t.name === "opportunity_diagnostics")!;
        const result = await diagnostics.run({ instrumentId: sol },
            { role: "lead", shiftId: shift.id, callId: "diagnostics", signal: new AbortController().signal });
        expect(result).toMatchObject({ status: "historical", observations: [
            { kind: "trade_proposal", evidence: { thesis: "Preserve old relevant evidence" } }
        ] });
    });

    it("durably queues one targeted research follow-up and rejects revoked writers", async () => {
        const { queueEvidenceFollowup } = await import("@/lib/desk/evidence-followup");
        const book = await newBook();
        const shift = await db.deskShift.create({ data: { bookId: book.id, version: book.version, mode: "live",
            status: "running", lease: "evidence", leaseUntil: new Date(Date.now() + 60000), briefJson: '{"triggers":[]}' } });
        const context = { role: "lead" as const, shiftId: shift.id, callId: "study", signal: new AbortController().signal };
        const question = { instrumentId: sol, direction: "down", horizonMinutes: 240 };
        const first = await queueEvidenceFollowup(db, book, context, question, { status: "insufficient_sample", samples: 4 });
        const again = await queueEvidenceFollowup(db, book, context, question, { status: "insufficient_sample", samples: 5 });
        expect(first?.wakeId).toBe(again?.wakeId);
        const wake = await db.deskWake.findUniqueOrThrow({ where: { id: first!.wakeId } });
        expect(wake).toMatchObject({ mode: "research", kind: "hypothesis_research", shiftId: null });
        expect(JSON.parse(wake.payload)).toMatchObject({ question, sourceShiftId: shift.id });
        expect(await db.deskIntent.count()).toBe(0);
        await db.deskShift.update({ where: { id: shift.id }, data: { status: "completed" } });
        await expect(queueEvidenceFollowup(db, book, context, question, {})).rejects.toThrow("revoked");
        expect(await db.deskWake.count({ where: { key: wake.key } })).toBe(1);
    });

    it("defers only a flat passed instrument, then wakes the lead once when exit depth recovers without a price move", async () => {
        const book = await newBook();
        const shift = await db.deskShift.create({ data: { bookId: book.id, version: book.version, mode: "live",
            status: "running", lease: "live", leaseUntil: new Date(Date.now() + 60000), briefJson: '{"triggers":[]}' } });
        fixture.exposure.mockResolvedValue({ positions: [], openOrders: [], spot: [], equity: "0" });
        let bids = 1;
        fixture.quote.mockImplementation(async () => ({ bid: 99.99, ask: 100.01, time: Date.now(),
            bids: [{ px: "99.99", sz: String(bids) }, { px: "90", sz: "500" }],
            asks: [{ px: "100.01", sz: "80" }] }));
        const setWatch = deskTools(book, shift).find(t => t.name === "set_watch")!;
        await setWatch.run({ kind: "pass", passBasis: "independent_reason", side: "buy", instrumentId: sol, thesis: "Exit depth is too thin",
            deadline: new Date(Date.now() + 3600000).toISOString(), revisitWhen: "bid_depth" },
            { role: "lead", shiftId: shift.id, callId: "pass", signal: new AbortController().signal });
        await db.deskShift.update({ where: { id: shift.id }, data: { status: "completed" } });
        const now = Date.now();
        const scan = (n: number) => sampleMarket(book, new Date(now - (3 - n) * 300000));
        fixture.mids.mockResolvedValue([{ instrumentId: sol, mid: 80 }, { instrumentId: "other", mid: 80 }]);
        await scan(0);
        fixture.mids.mockResolvedValue([{ instrumentId: sol, mid: 100 }, { instrumentId: "other", mid: 100 }]);
        await scan(1);
        const audit = await db.deskRecord.findFirstOrThrow({ where: { kind: "pass_review" } });
        expect(JSON.parse(audit.dataJson)).toMatchObject([{ instrumentId: sol, disposition: "deferred" }]);
        const move = await db.deskWake.findFirstOrThrow({ where: { kind: "market_move" } });
        expect(JSON.parse(move.payload).moves.map((m: { instrumentId: string }) => m.instrumentId)).toEqual(["other"]);
        await db.deskWake.update({ where: { id: move.id }, data: { expiresAt: new Date(0) } });
        bids = 50;
        await scan(2);
        await scan(3);
        const wakes = await db.deskWake.findMany({ where: { kind: "watch" } });
        expect(wakes).toHaveLength(1);
        expect(JSON.parse(wakes[0].payload)).toMatchObject({ role: "lead", condition: "depth_recovery", revisitWhen: "bid_depth" });
        const claimed = await claimShift(book);
        expect(JSON.parse(claimed!.briefJson).activeRoles).toEqual(["lead"]);
    });

    it("preserves market alerts for held or unknown exposure even when both sides of a legacy pass are thin", async () => {
        const book = await newBook(), now = Date.now();
        await db.deskWatch.create({ data: { bookId: book.id, mode: "live", kind: "pass", instrumentId: sol,
            key: `routine:lead:${book.version}:live:legacy`, thesis: "pass", deadline: new Date(now + 3600000) } });
        fixture.quote.mockImplementation(async () => ({ bid: 99.99, ask: 100.01, time: Date.now(),
            bids: [{ px: "99.99", sz: "1" }], asks: [{ px: "100.01", sz: "1" }] }));
        for (let i = 0; i < 3; i++) {
            if (i === 1) fixture.exposure.mockResolvedValue({ positions: [{ coin: "SOL" }], openOrders: [], spot: [], equity: "0" });
            else fixture.exposure.mockRejectedValue(new Error("wallet unavailable"));
            fixture.mids.mockResolvedValue([{ instrumentId: sol, mid: 100 * (i + 1) }]);
            await sampleMarket(book, new Date(now - (2 - i) * 300000));
        }
        expect(await db.deskWake.count({ where: { kind: "market_move" } })).toBe(2);
    });

    it("reopens a news-dependent pass on a mapped discovery and keeps held-asset delistings at the full desk", async () => {
        const flat = await newBook(sub), held = await newBook(owner);
        for (const book of [flat, held]) {
            await db.deskWatch.create({ data: { bookId: book.id, mode: "live", kind: "pass", instrumentId: sol,
                key: `routine:lead:${book.version}:live:news`, thesis: "Await confirmation", deadline: new Date(Date.now() + 3600000),
                outcomeJson: JSON.stringify({ revisitWhen: "material_news" }) } });
        }
        setupNews(true);
        fixture.mids.mockResolvedValue([{ instrumentId: sol, mid: 100 }]);
        await sampleMarket(flat, new Date(Date.now() - 300000));
        fixture.mids.mockResolvedValue([{ instrumentId: sol, mid: 110 }]);
        await sampleMarket(flat);
        expect(await db.deskWake.count({where:{bookId:flat.id,kind:"market_move"}})).toBe(1);
        await db.deskWake.updateMany({where:{bookId:flat.id,kind:"market_move"},data:{expiresAt:new Date(Date.now()-1)}});
        await ingestNews(flat);
        const discovery = await claimShift(flat);
        expect(JSON.parse(discovery!.briefJson)).toMatchObject({ activeRoles: ["lead"], triggers: [{ kind: "discovery" }] });
        setupNews();
        await ingestNews(held);
        const urgent = await claimShift(held);
        expect(JSON.parse(urgent!.briefJson)).toMatchObject({ activeRoles: ["risk", "lead"], triggers: [{ kind: "risk" }] });
    });

    it("pauses enabled books and stops polling on a SQLite corruption error", async () => {
        const book = await newBook();
        const worker = new TradingDeskWorker();
        await worker.checkStorage();
        expect(await worker.stopOnCorruption(new Error("network timeout"))).toBe(false);
        const error = new Error("prisma query " + "x".repeat(500) + ": database disk image is malformed");
        expect(await worker.stopOnCorruption(error)).toBe(true);
        expect(await db.deskBook.findUniqueOrThrow({ where: { id: book.id } })).toMatchObject({
            enabled: false, version: book.version + 1,
        });
        await worker.poll();
        expect(await db.deskShift.count()).toBe(0);
        expect(fixture.model).not.toHaveBeenCalled();
        await worker.close();
    });

    it("shares timestamped depth across roles and cost tools and includes compact observations for the next speaker", async () => {
        const book = await newBook();
        const shift = await db.deskShift.create({
            data: {
                bookId: book.id,
                version: 1,
                mode: "research",
                status: "running",
                lease: "test",
                leaseUntil: new Date(Date.now() + 60000),
                briefJson: '{"triggers":[]}',
            },
        });
        const tools = deskTools(book, shift);
        fixture.quote.mockImplementation(async () => ({
            bid: 99,
            ask: 101,
            spreadBps: 200,
            time: Date.now(),
            asks: [{ px: "101", sz: "10" }],
            bids: [{ px: "99", sz: "10" }],
        }));
        const fees = vi.fn(async () => ({ ok: true, json: async () => ({ userCrossRate: "0.0004" }) }));
        vi.stubGlobal("fetch", fees);
        const ctx = {
            role: "catalyst" as const,
            shiftId: shift.id,
            callId: "quote",
            signal: new AbortController().signal,
        };
        const read = tools.find((t) => t.name === "order_book")!,
            cost = tools.find((t) => t.name === "transaction_cost")!;
        await Promise.all([
            read.run({ instrumentId: sol }, ctx),
            cost.run({ instrumentId: sol, side: "buy", quantity: 2 }, { ...ctx, role: "execution", callId: "cost" }),
        ]);
        await cost.run(
            { instrumentId: sol, side: "sell", quantity: 1 },
            { ...ctx, role: "derivatives", callId: "cost2" },
        );
        expect(fixture.quote).toHaveBeenCalledTimes(1);
        expect(fees).toHaveBeenCalledTimes(1);
        expect(await tools.sharedObservations()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ tool: "order_book", instrumentId: sol, bid: 99, ask: 101 }),
                expect.objectContaining({ tool: "transaction_cost", side: "buy", priced: 2 }),
            ]),
        );
        expect(await deskTools(book, shift).sharedObservations()).toEqual([]);
    });
    it("coalesces a role's repeated thesis, timer and journal follow-up across shifts, then wakes only that role once", async () => {
        const book = await newBook();
        const deadline = new Date(Date.now() + 120_000).toISOString();
        const thesis = "Verify the settlement notice";
        let routine = false;
        fixture.model.mockImplementation(async (turn) => {
            const answer = note(turn.role);
            if (turn.role === "catalyst") {
                answer.thesis = thesis;
                answer.followUpAt = deadline;
                const result = await tool(turn, "write_thesis", {
                    thesis,
                    invalidation: "Venue retracts",
                    eventKey,
                    reviewAt: deadline,
                });
                const watch = await tool(turn, "set_watch", { kind: "review", thesis, eventKey, deadline });
                expect(result).toHaveProperty(
                    "status",
                    routine ? "not_scheduled" : expect.stringMatching(/open|coalesced/),
                );
                expect(watch).toHaveProperty("status", routine ? "not_scheduled" : "coalesced");
                if (routine) expect(turn.tools.some((t) => t.name === "consult_colleague")).toBe(false);
            }
            return JSON.stringify(answer);
        });
        for (const key of ["external:1", "external:2"]) {
            await queueWake(db, book, key, "discovery", "live", {});
            const shift = await claimShift(book);
            await runShift(book, shift!, new AbortController().signal);
        }
        expect(await db.deskWatch.count({ where: { bookId: book.id, status: "open" } })).toBe(1);
        await db.deskWatch.updateMany({ where: { bookId: book.id }, data: { deadline: new Date(Date.now() - 1000) } });
        await processWatches(book);
        await processWatches(book);
        routine = true;
        const callback = await claimShift(book);
        const brief = JSON.parse(callback!.briefJson);
        expect(brief.activeRoles).toEqual(["catalyst"]);
        expect(brief.triggers[0].payload.role).toBe("catalyst");
        await runShift(book, callback!, new AbortController().signal);
        expect(
            await db.deskRecord.findMany({ where: { shiftId: callback!.id, kind: "note" }, select: { role: true } }),
        ).toEqual([{ role: "catalyst" }]);
        expect(await db.deskWatch.count({ where: { bookId: book.id, status: "open" } })).toBe(0);
        expect(await claimShift(book)).toBeNull();
    });

    it("restores legacy watch ownership and delivers only each role’s own outstanding reminder", async () => {
        const book = await newBook();
        const priorId = randomUUID();
        const watch = await db.deskWatch.create({
            data: {
                bookId: book.id,
                mode: "research",
                kind: "review",
                key: priorId + ":watch:old-key",
                deadline: new Date(Date.now() - 1000),
                thesis: "Assess passive fill probability",
            },
        });
        await db.deskRecord.create({
            data: {
                bookId: book.id,
                shiftId: priorId,
                key: randomUUID(),
                role: "execution",
                kind: "tool_result",
                dataJson: JSON.stringify({ name: "set_watch", result: JSON.stringify({ watchId: watch.id }) }),
            },
        });
        await processWatches(book);
        await queueWake(db, book, randomUUID(), "follow_up", "research", {
            role: "derivatives",
            thesis: "Check basis compression",
        });
        const shift = await claimShift(book);
        expect(JSON.parse(shift!.briefJson).activeRoles).toEqual(["derivatives", "execution"]);
        fixture.model.mockImplementation(async (turn) => {
            const payload = JSON.parse(turn.input);
            expect(payload.openingBrief.triggers.map((t: { payload: { role: string } }) => t.payload.role)).toEqual([
                turn.role,
            ]);
            expect(payload.roundtable).toEqual({});
            return JSON.stringify(note(turn.role));
        });
        await runShift(book, shift!, new AbortController().signal);
        expect(fixture.model.mock.calls.map(([t]) => t.role).sort()).toEqual(["derivatives", "execution"]);
        expect(await claimShift(book)).toBeNull();
    });
    it("absorbs a backlog of duplicate legacy role reminders into a coincident risk review", async () => {
        const book = await newBook();
        await db.deskWake.createMany({
            data: Array.from({ length: 64 }, (_, i) => ({
                bookId: book.id,
                key: "legacy:" + i,
                kind: "follow_up",
                mode: "live",
                priority: 6,
                version: book.version,
                payload: JSON.stringify({ role: "risk", thesis: "Validate book depth" }),
                dueAt: new Date(Date.now() - 5000),
            })),
        });
        await queueWake(db, book, "event:halt", "risk", "live", { eventKey: "halt" }, 10);
        const shift = await claimShift(book);
        const brief = JSON.parse(shift!.briefJson);
        expect(brief.routineOnly).toBe(false);
        expect(brief.triggers).toHaveLength(2);
        expect(brief.coalescedWakes).toBe(63);
        expect(await db.deskWake.count({ where: { shiftId: shift!.id } })).toBe(65);
        fixture.model.mockImplementation(async (turn) => JSON.stringify(note(turn.role)));
        await runShift(book, shift!, new AbortController().signal);
        expect(fixture.model.mock.calls.map(([t]) => t.role).sort()).toEqual(["lead", "risk"]);
        expect(await claimShift(book)).toBeNull();
    });

    it("coalesces a periodic sweep overlapping completion and preserves isolated research mode", async () => {
        let book = await newBook();
        book = await db.deskBook.update({
            where: { id: book.id },
            data: { nextReviewAt: new Date(Date.now() - 5000) },
        });
        await queueWake(db, book, "routine:legacy-risk", "follow_up", "live", {
            role: "risk",
            thesis: "Check equity",
        });
        await queueWake(db, book, "routine:legacy-lead", "follow_up", "research", {
            role: "lead",
            thesis: "Research only",
        });
        const shift = await claimShift(book);
        expect(JSON.parse(shift!.briefJson)).toMatchObject({ routineOnly: false, mode: "live" });
        expect(
            JSON.parse(shift!.briefJson)
                .triggers.map((t: { kind: string }) => t.kind)
                .sort(),
        ).toEqual(["follow_up", "scheduled"]);
        // Simulate a sweep becoming due while this roundtable was running.
        await db.deskBook.update({ where: { id: book.id }, data: { nextReviewAt: new Date(Date.now() - 1000) } });
        fixture.model.mockImplementation(async (turn) => JSON.stringify(note(turn.role)));
        await runShift(book, shift!, new AbortController().signal);
        book = await db.deskBook.findUniqueOrThrow({ where: { id: book.id } });
        expect(+book.nextReviewAt).toBeGreaterThan(Date.now());
        const research = await claimShift(book);
        expect(JSON.parse(research!.briefJson)).toMatchObject({
            activeRoles: ["lead"],
            mode: "research",
            routineOnly: true,
        });
        await runShift(book, research!, new AbortController().signal);
        expect(await claimShift(book)).toBeNull();
    });

    it("fences news consumption to the exposed book, coalesces duplicate delivery, and keeps operator research out of a live shift", async () => {
        const held = await newBook(),
            flat = await newBook(sub);
        setupNews();
        // Both attempts see the same old cursor (e.g. when another poll wins the race).
        await ingestNews(held);
        fixture.quote.mockImplementation(async () => ({ bid: 102, ask: 104, time: Date.now(),
            bids:[{px:"102",sz:"10"}],asks:[{px:"104",sz:"10"}] }));
        await ingestNews(held);
        await ingestNews(flat);
        expect(await db.deskWake.count({ where: { bookId: held.id, kind: "risk" } })).toBe(1);
        expect(await db.deskWake.count({ where: { bookId: flat.id } })).toBe(0);
        expect((await db.deskBook.findUniqueOrThrow({ where: { id: flat.id } })).newsCursor).toBe(41);
        await operatorMessage(held, {
            message: "Research only: inspect the incident",
            kind: "research",
            requestId: randomUUID(),
        });
        fixture.model.mockImplementation(async (turn) => {
            const brief = JSON.parse(turn.input);
            expect(brief.openingBrief.mode).toBe(brief.mode);
            expect(brief.openingBrief.allocationContext).toMatchObject({ source: "owned_fill_ledger", patternOutcomes: [],
                evidenceId: expect.stringMatching(/^allocation-context:/) });
            expect(turn.tools.some(t => t.name === "allocation_context")).toBe(true);
            expect(turn.instructions).toContain("allocation-1");
            if (brief.mode === "research")
                expect(turn.tools.some((t) => t.access === "lead" || t.access === "execution")).toBe(false);
            if (turn.role === "catalyst") {
                const result = await tool(turn, "news_history", { eventKey });
                expect(result).toMatchObject([{ revisionId: 41, verified: true }]);
            }
            if (turn.role === "lead") {
                if (brief.mode === "live") expect(brief.roundtable.risk.dissent).toBe("Do not increase exposure");
                if (brief.mode === "live") expect(turn.tools.some((t) => t.name === "work_order")).toBe(true);
            }
            return JSON.stringify(note(turn.role));
        });
        const live = await claimShift(held);
        expect(live?.mode).toBe("live");
        expect(JSON.parse(live!.briefJson).triggers[0].payload.arrivalQuotes[sol]).toMatchObject({
            bid: 99,
            ask: 101,
            at: expect.any(String),
            observedAt: expect.any(String),
        });
        expect(JSON.parse(live!.briefJson).triggers.map((t: { kind: string }) => t.kind)).toEqual(["risk"]);
        const callback = {
            role: "lead" as const,
            shiftId: live!.id,
            callId: "wrong-book",
            signal: new AbortController().signal,
        };
        const misplaced = deskTools(flat, live!).find((t) => t.name === "find_instruments")!;
        await expect(misplaced.run({ query: "SOL" }, callback)).rejects.toThrow();
        expect(await db.deskRecord.count({ where: { bookId: flat.id, kind: "tool" } })).toBe(0);
        await runShift(held, live!, new AbortController().signal);
        const research = await claimShift(held);
        expect(research?.mode).toBe("research");
        const forbidden = deskTools(held, research!).find((t) => t.name === "work_order")!;
        await expect(
            forbidden.run({}, { ...callback, shiftId: research!.id, callId: "forged-order" }),
        ).rejects.toThrow();
        await runShift(held, research!, new AbortController().signal);
        expect(await db.deskRecord.count({ where: { bookId: held.id, kind: "note" } })).toBe(3);
        expect(await db.deskIntent.count()).toBe(0);
        expect(await db.deskShift.count({ where: { status: "completed" } })).toBe(2);
        expect(fetch).not.toHaveBeenCalled();
    });
    it("keeps a time-bounded risk wake and advances the cursor when the venue supplies no arrival quote", async () => {
        const book = await newBook();
        setupNews();
        fixture.quote.mockImplementation(() => new Promise<never>(() => {}));
        await ingestNews(book);
        const wake = await db.deskWake.findFirstOrThrow({ where: { bookId: book.id, kind: "risk" } });
        expect(JSON.parse(wake.payload)).toMatchObject({
            arrivalQuotes: {},
            arrivalQuoteGaps: { [sol]: "quote_timeout" },
        });
        expect((await db.deskBook.findUniqueOrThrow({ where: { id: book.id } })).newsCursor).toBe(41);
    }, 3000);
    it("uses dated last-known holdings during a venue outage and replays the range once live scope recovers", async () => {
        const book = await newBook();
        setupNews();
        const rows = fixture.newsRows.getMockImplementation()!;
        fixture.newsRows.mockResolvedValue([]);
        await ingestNews(book); // Collect last-known scope on a quiet cycle.
        fixture.newsRows.mockImplementation(rows);
        fixture.exposure.mockRejectedValue(new Error("venue unavailable"));
        fixture.metadataDown = true;
        await ingestNews(book);
        const first = await db.deskWake.findFirstOrThrow({ where: { bookId: book.id, kind: "risk" } });
        expect(JSON.parse(first.payload)).toMatchObject({
            instrumentIds: [sol],
            coverage: {
                exposure: "last_known",
                exposureAsOf: expect.any(String),
                directory: "held_instruments_only",
                needsReconciliation: true,
            },
        });
        expect((await db.deskBook.findUniqueOrThrow({ where: { id: book.id } })).newsCursor).toBe(0);
        await ingestNews(book);
        fixture.metadataDown = false;
        setupNews();
        await ingestNews(book);
        expect((await db.deskBook.findUniqueOrThrow({ where: { id: book.id } })).newsCursor).toBe(41);
        expect(await db.deskWake.count({ where: { bookId: book.id } })).toBe(1);
    });
    it("delivers an unmapped verified venue risk when there is no exposure history or metadata", async () => {
        const book = await newBook();
        setupNews();
        fixture.exposure.mockRejectedValue(new Error("offline"));
        fixture.metadataDown = true;
        await ingestNews(book);
        const wake = await db.deskWake.findFirstOrThrow({ where: { bookId: book.id, kind: "risk" } });
        expect(JSON.parse(wake.payload)).toMatchObject({
            instrumentIds: [],
            coverage: { exposure: "unknown", exposureAsOf: null, directory: "unknown", needsReconciliation: true },
        });
        expect((await db.deskBook.findUniqueOrThrow({ where: { id: book.id } })).newsCursor).toBe(0);
    });
    it("uses reconciled inventory for scope when live exposure is unavailable on a first run", async () => {
        const book = await newBook();
        setupNews();
        await db.deskInventory.create({ data: { bookId: book.id, instrumentId: sol, quantity: 1, basis: 98 } });
        fixture.exposure.mockRejectedValue(new Error("offline"));
        await ingestNews(book);
        const wake = await db.deskWake.findFirstOrThrow({ where: { bookId: book.id, kind: "risk" } });
        expect(JSON.parse(wake.payload)).toMatchObject({
            instrumentIds: [sol],
            coverage: { exposure: "inventory_only", directory: "observed", needsReconciliation: true },
        });
    });
    it("revisits a resolved thesis after its watch closed, without notifying a different flat book", async () => {
        const followed = await newBook(),
            other = await newBook(sub);
        setupNews();
        fixture.exposure.mockResolvedValue({ positions: [], spot: [], openOrders: [] });
        const [original] = await fixture.newsRows({ where: { id: { gt: 0 } } });
        const details = JSON.parse(original.detailsJson) as RevisionDetails;
        details.signal.facts!.change = "retraction";
        details.signal.facts!.targets = [];
        const update = { ...original, id: 42, detailsJson: JSON.stringify(details) };
        fixture.newsRows.mockResolvedValue([update]);
        fixture.latest.mockResolvedValue([{ eventKey, _max: { id: 42 } }]);
        await db.deskWatch.create({
            data: {
                bookId: followed.id,
                key: "closed",
                mode: "live",
                kind: "review",
                eventKey,
                thesis: "Review settlement",
                status: "elapsed",
                deadline: new Date(0),
            },
        });
        await ingestNews(followed);
        await ingestNews(other);
        expect(await db.deskWake.findMany({ select: { bookId: true, kind: true } })).toEqual([
            { bookId: followed.id, kind: "correction" },
        ]);
    });
    it.each([
        ["Invalid `prisma.deskShift.updateMany()` invocation: Operations timed o", null],
        ["Codex App Server disconnected", null],
        ["Codex desk turn timed out", null],
        ["Codex desk turn exceeded its wall-time limit", null],
        ["Invalid tx.deskWatch.upsert(): Transaction API error: Transaction already", null],
        ["Exchange reconciliation unavailable", "Exchange reconciliation unavailable"],
    ])("clears recovered desk warnings without clearing other failures (%s)", async (lastError, expected) => {
        const book = await db.deskBook.update({ where: { id: (await newBook()).id }, data: { lastError } });
        await queueWake(db, book, "recovery", "scheduled", "live", {});
        const shift = await claimShift(book);
        await db.deskShift.update({ where: { id: shift!.id }, data: { error: "Previous attempt failed" } });
        fixture.model.mockImplementation(async turn => JSON.stringify(note(turn.role)));
        await runShift(book, shift!, new AbortController().signal);
        expect(await db.deskShift.findUniqueOrThrow({ where: { id: shift!.id } })).toMatchObject({ status: "completed", error: null });
        expect(await db.deskBook.findUniqueOrThrow({ where: { id: book.id } })).toHaveProperty("lastError", expected);
    });

    it("preserves a newer failure reported during a successful storage recovery", async () => {
        const book = await db.deskBook.update({ where: { id: (await newBook()).id },
            data: { lastError: "Desk database is busy. The worker will retry after the lock clears." } });
        await queueWake(db, book, "recovery", "scheduled", "live", {});
        const shift = await claimShift(book);
        fixture.model.mockImplementation(async turn => {
            if (turn.role === "lead") await db.deskBook.update({ where: { id: book.id }, data: { lastError: "Exchange disconnected" } });
            return JSON.stringify(note(turn.role));
        });
        await runShift(book, shift!, new AbortController().signal);
        expect(await db.deskBook.findUniqueOrThrow({ where: { id: book.id } })).toHaveProperty("lastError", "Exchange disconnected");
    });

    it("preserves the original failure when writing the failure status also times out", async () => {
        const book = await newBook();
        await queueWake(db, book, "failure", "scheduled", "live", {});
        const shift = await claimShift(book);
        const original = new Error("Original model failure");
        fixture.model.mockRejectedValue(original);
        const update = vi.spyOn(db.deskShift, "updateMany").mockRejectedValueOnce(
            Object.assign(new Error("Operations timed out after N/A"), { code: "P1008" }),
        );
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            await expect(runShift(book, shift!, new AbortController().signal)).rejects.toBe(original);
            expect(warning).toHaveBeenCalledWith("[Trading desk] Could not save shift failure:", expect.stringContaining("database is busy"));
        } finally {
            update.mockRestore();
            warning.mockRestore();
        }
        expect(await db.deskShift.findUniqueOrThrow({ where: { id: shift!.id } })).toMatchObject({ status: "running", lease: shift!.lease });
    });

    it("does not rearm a consumed follow-up when the committed note is replayed", async () => {
        const book = await newBook();
        await queueWake(db, book, "outbox", "scheduled", "live", {});
        const shift = (await claimShift(book))!;
        const answer = { ...note("lead"), followUpAt: new Date(Date.now() + 3600000).toISOString() };
        const signal = new AbortController().signal;
        await checkpointRoleNote(db, book, shift, "lead", answer, signal);
        await scheduleRoleFollowUp(db, book, shift, "lead", answer, signal);
        await db.deskWatch.updateMany({ where: { bookId: book.id }, data: { status: "elapsed" } });
        await scheduleRoleFollowUp(db, book, shift, "lead", answer, signal);
        expect(await db.deskWatch.count({ where: { bookId: book.id } })).toBe(1);
        expect(await db.deskWatch.count({ where: { bookId: book.id, status: "open" } })).toBe(0);
    });

    it("refuses journal writes after cancellation or lease revocation", async () => {
        const book = await newBook();
        await queueWake(db, book, "outbox", "scheduled", "live", {});
        const shift = (await claimShift(book))!;
        const stopped = new AbortController(); stopped.abort();
        await expect(checkpointRoleNote(db, book, shift, "lead", note("lead"), stopped.signal)).rejects.toThrow(/cancelled/);
        await db.deskShift.update({ where: { id: shift.id }, data: { lease: "another-worker" } });
        await expect(checkpointRoleNote(db, book, shift, "lead", note("lead"), new AbortController().signal)).rejects.toThrow(/revoked/);
        expect(await db.deskRecord.count({ where: { shiftId: shift.id, kind: "note" } })).toBe(0);
    });

    it.each([1, 3])("retains completed analysis through %s reminder timeouts and schedules once", async failures => {
        const book = await newBook();
        await queueWake(db, book, "journal-timeout", "scheduled", "live", {});
        const shift = (await claimShift(book))!;
        fixture.model.mockImplementation(async turn => {
            const answer = note(turn.role);
            if (turn.role === "lead") {
                await tool(turn, "record_candidate_comparison", {
                    candidates: [], preferredInstrumentId: null,
                    relativeReason: "No fresh market observations are available in this reminder fixture",
                    coverageReason: "Reminder delivery test has no market dataset; no investigation claimed",
                });
                answer.followUpAt = new Date(Date.now() + 3600000).toISOString();
                fixture.watchFailures = failures;
            }
            return JSON.stringify(answer);
        });
        if (failures === 1) {
            await runShift(book, shift, new AbortController().signal);
        } else {
            await expect(runShift(book, shift, new AbortController().signal)).rejects.toThrow("expired transaction");
            expect(await db.deskRecord.count({ where: { shiftId: shift.id, kind: "note", role: "lead" } })).toBe(1);
            expect(await db.deskWatch.count({ where: { bookId: book.id } })).toBe(0);
            await db.$disconnect();
            fixture.client = db = new Client({ datasources: { db: { url } } });
            const resumed = (await claimShift(book, new Date(Date.now() + 20000)))!;
            await runShift(book, resumed, new AbortController().signal);
        }
        expect(fixture.model.mock.calls.map(([t]) => t.role)).toEqual(["lead"]);
        expect(await db.deskWatch.count({ where: { bookId: book.id } })).toBe(1);
        expect(await db.deskRecord.count({ where: { shiftId: shift.id, kind: "follow_up_scheduled" } })).toBe(1);
        expect(await db.deskShift.findUniqueOrThrow({ where: { id: shift.id } })).toMatchObject({ status: "completed", error: null });
        expect(await db.deskIntent.count()).toBe(0);
        expect(await db.deskRecord.count({ where: { shiftId: shift.id, kind: "candidate_comparison" } })).toBe(1);
    });

    it("resumes the same shift after a failed lead turn and process restart without replaying specialists or losing their watches", async () => {
        const book = await newBook();
        await queueWake(db, book, "fixture-alert", "discovery", "live", { instrumentId: sol, price: 100 });
        let interrupt = true;
        fixture.model.mockImplementation(async (turn) => {
            if (turn.role === "catalyst") {
                await tool(turn, "write_thesis", {
                    thesis: "Compare settlement basis",
                    invalidation: "Venue retracts notice",
                    eventKey,
                    reviewAt: new Date(Date.now() + 3600000).toISOString(),
                });
            }
            if (turn.role === "lead") {
                if (interrupt) {
                    interrupt = false;
                    throw new Error("simulated process termination");
                }
                const b = JSON.parse(turn.input);
                expect(b.openingBrief.resuming).toBe(true);
                expect(b.openingBrief.watches).toContainEqual(
                    expect.objectContaining({ thesis: "Compare settlement basis" }),
                );
                expect(Object.keys(b.roundtable)).toEqual(["catalyst"]);
            }
            return JSON.stringify(note(turn.role));
        });
        const shift = await claimShift(book);
        await expect(runShift(book, shift!, new AbortController().signal)).rejects.toThrow(
            "simulated process termination",
        );
        await db.$disconnect();
        fixture.client = db = new Client({ datasources: { db: { url } } });
        const resumed = await claimShift(book, new Date(Date.now() + 20000));
        expect(resumed?.id).toBe(shift?.id);
        expect(resumed?.lease).not.toBe(shift?.lease);
        await runShift(book, resumed!, new AbortController().signal);
        expect(await db.deskRecord.count({ where: { shiftId: shift!.id, kind: "note" } })).toBe(2);
        expect(await db.deskWatch.count()).toBe(1);
        expect(await db.deskShift.findUniqueOrThrow({ where: { id: resumed!.id } })).toMatchObject({ status: "completed", error: null });
        expect(fixture.model.mock.calls.filter(([s]) => s.role === "catalyst")).toHaveLength(1);
        expect(fetch).not.toHaveBeenCalled();
    });
    it("persists proposal revisions and specialist dissent across a failed lead turn and process restart", async () => {
        vi.stubEnv("DESK_REVIEW_TRIAGE", "off"); // Exercise recovery of an admitted full review.
        const book = await newBook();
        await queueWake(db, book, "proposal-event", "market_move", "live", { moves: [{ instrumentId: sol, move: .1 }] });
        let interrupted = false;
        fixture.model.mockImplementation(async turn => {
            const input = JSON.parse(turn.input);
            if (input.researchQuestion) {
                expect(input.assignedProposal).toMatchObject({ key: "sol-dislocation", revision: 1 });
                expect(turn.tools.every(t => t.access === "read")).toBe(true);
            } else if (turn.role === "derivatives") {
                await tool(turn, "update_trade_proposal", proposalDraft());
            } else if (turn.role === "lead") {
                const response = await tool(turn, "consult_colleague", { role: "risk", proposalKey: "sol-dislocation", question: "Bound liquidation and exit losses" });
                if (!interrupted) { interrupted = true; throw new Error("lead process lost"); }
                expect(response).toMatchObject({ reused: true, proposalRevision: 1, note: { dissent: "Do not increase exposure" } });
                await tool(turn, "update_trade_proposal", { ...proposalDraft(), expectedRevision: 1, status: "parked", economics: "Exit loss remains unresolved" });
            }
            return JSON.stringify(note(turn.role));
        });
        const shift = (await claimShift(book))!;
        await expect(runShift(book, shift, new AbortController().signal)).rejects.toThrow("lead process lost");
        await db.$disconnect();
        fixture.client = db = new Client({ datasources: { db: { url } } });
        const resumed = (await claimShift(book, new Date(Date.now() + 20000)))!;
        await runShift(book, resumed, new AbortController().signal);
        expect(fixture.model.mock.calls.map(([t]) => t.role)).toEqual(["derivatives", "lead", "risk", "lead"]);
        expect(await loadTradeProposals(db, book, resumed)).toMatchObject([{ status: "parked", revision: 2 }]);
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "proposal_revision" } })).toBe(2);
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "consult" } })).toBe(1);
        const proposals = await loadTradeProposals(db, book, resumed);
        expect(await loadTradeProposalReviews(db, book, resumed, proposals)).toEqual([]); // Already in this shift's receipts.
        const next = { ...resumed, id: "next-shift" };
        expect(await loadTradeProposalReviews(db, book, next, proposals)).toMatchObject([
            { proposalRevision: 1, sourceShiftId: resumed.id, note: { dissent: "Do not increase exposure" } },
        ]);
        expect(await loadTradeProposalReviews(db, book, { ...next, mode: "research" }, proposals)).toEqual([]);
        expect(await loadTradeProposalReviews(db, { ...book, version: 2 }, next, proposals)).toEqual([]);
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "catalyst_investigation" } })).toBe(0);
        expect(await db.deskIntent.count()).toBe(0);
    });

    it("retains the two-run research budget across concurrent requests and restart",async()=>{
        const book=await newBook();await queueWake(db,book,"budget","operator","research",{});
        const shift=(await claimShift(book))!,signal=new AbortController().signal;
        await Promise.all([reserveBacktestRun(db,book,shift,"lead","first",signal),reserveBacktestRun(db,book,shift,"derivatives","second",signal)]);
        await db.$disconnect();fixture.client=db=new Client({datasources:{db:{url}}});
        await expect(reserveBacktestRun(db,book,shift,"risk","third",signal)).rejects.toThrow("budget exhausted");
        expect(await db.deskRecord.count({where:{bookId:book.id,shiftId:shift.id,kind:"research_budget"}})).toBe(2);
        expect(await db.deskIntent.count()).toBe(0);
    });

    it("recovers automatic research findings after the lead synthesis is interrupted", async()=>{
        const book=await newBook();
        await queueWake(db,book,"auto-research","operator","research",{message:"Evaluate one candidate"});
        let interrupted=false;
        fixture.model.mockImplementation(async turn=>{
            const input=JSON.parse(turn.input);
            if(input.researchQuestion){await tool(turn,"order_book",{instrumentId:sol});return JSON.stringify(note("execution"));}
            if(!input.sharedProposals.length){const p=proposalDraft();p.researchPlan[0]={...p.researchPlan[0],status:"ready",result:""};await tool(turn,"update_trade_proposal",p);}
            else if(!interrupted){interrupted=true;throw new Error("lead synthesis interrupted");}
            else expect(input.sharedProposals[0].researchPlan[0]).toMatchObject({status:"review",methodUsed:true,assessedRevision:1});
            return JSON.stringify(note(turn.role));
        });
        const shift=(await claimShift(book))!;
        await expect(runShift(book,shift,new AbortController().signal)).rejects.toThrow("lead synthesis interrupted");
        await db.$disconnect();fixture.client=db=new Client({datasources:{db:{url}}});
        const resumed=(await claimShift(book,new Date(Date.now()+20000)))!;
        await runShift(book,resumed,new AbortController().signal);
        expect(fixture.model.mock.calls.map(([t])=>t.role)).toEqual(["lead","execution","lead","lead"]);
        expect(await loadTradeProposals(db,book,resumed)).toMatchObject([{revision:2,researchPlan:[{status:"review",methodUsed:true}]}]);
        expect(await db.deskRecord.count({where:{bookId:book.id,kind:"consult"}})).toBe(1);
        expect(await db.deskIntent.count()).toBe(0);
    });

    it("fences proposal writes by revision, instrument, lease, book, mandate and research mode", async () => {
        const book = await newBook();
        await queueWake(db, book, "draft", "scheduled", "live", {});
        const shift = (await claimShift(book))!;
        const signal = new AbortController().signal;
        const d = proposalDraft();
        const first = await saveTradeProposal(db, book, shift, "derivatives", d, signal);
        expect(await saveTradeProposal(db, book, shift, "derivatives", d, signal)).toEqual(first);
        await expect(saveTradeProposal(db, book, shift, "lead", { ...d, economics: "Conflicting stale change" }, signal)).rejects.toThrow("revision changed");
        await expect(saveTradeProposal(db, book, shift, "lead", { ...d, key: "wrong-venue", legs: [{ ...d.legs[0], instrumentId: "testnet:perp:SOL" }] }, signal)).rejects.toThrow("network");
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "proposal_revision" } })).toBe(1);
        expect(await loadTradeProposals(db, { ...book, version: 2 }, shift)).toEqual([]);
        expect(await loadTradeProposals(db, book, { ...shift, mode: "research" })).toEqual([]);
        expect(await loadTradeProposals(db, await newBook(sub), shift)).toEqual([]);
        await db.deskShift.update({ where: { id: shift.id }, data: { lease: "new-owner" } });
        await expect(saveTradeProposal(db, book, shift, "lead", { ...d, expectedRevision: 1, status: "closed" }, signal)).rejects.toThrow("revoked");
        expect(await loadTradeProposals(db, book, shift)).toMatchObject([{ revision: 1, status: "researching" }]);
    });

    it("finishes a recovered dispatch without letting the model mint another order ticket", async () => {
        const book = await newBook();
        await queueWake(db, book, "operator:live", "operator", "live", { message: "work the order" });
        const shift = await claimShift(book);
        await db.deskRecord.create({
            data: {
                bookId: book.id,
                shiftId: shift!.id,
                role: "lead",
                key: "prior-attempt",
                kind: "dispatch",
                dataJson: '{"name":"work_order"}',
            },
        });
        fixture.model.mockImplementation(async (turn) => {
            expect(
                turn.tools.some((t) =>
                    ["work_order", "work_pair", "work_delegated_ticket", "authorize_quotes"].includes(t.name),
                ),
            ).toBe(false);
            return JSON.stringify(note(turn.role));
        });
        await runShift(book, shift!, new AbortController().signal);
        expect(await db.deskShift.findUnique({ where: { id: shift!.id } })).toMatchObject({ status: "completed" });
    });
});

describe("durable desk research and execution ownership",()=>{
    it("schedules one hourly hypothesis review only for enabled books",async()=>{
        const book=await newBook(); await db.deskBook.update({where:{id:book.id},data:{enabled:false}});
        const worker=new TradingDeskWorker(); await worker.poll();
        expect(await db.deskWake.count({where:{bookId:book.id,kind:"hypothesis_research"}})).toBe(0);
        await db.deskBook.update({where:{id:book.id},data:{enabled:true}});
        await worker.poll();await worker.poll();await worker.close();
        expect(await db.deskWake.count({where:{bookId:book.id,kind:"hypothesis_research",mode:"research"}})).toBe(1);
    });
    it("settles a terminal partial fill in the application database without changing either protection",async()=>{
        const {syncLedger}=await import("@/lib/desk/execution-ledger");
        const {nativeInstruments}=await import("@/lib/desk/instruments");
        const book=await newBook(),instrument=nativeInstruments(false,[{name:"SOL",szDecimals:2}],{tokens:[],universe:[]})[0];
        const base={bookId:book.id,instrumentId:sol,coin:"SOL",asset:0,policyVersion:book.version,side:"buy",quantity:2,filledQty:1,limitPrice:100,arrivalPrice:100,fingerprint:"fixture"};
        const entry=await db.deskIntent.create({data:{...base,intentKey:"partial",cloid:"0xpartial",oid:"1",state:"settling",reservedUsd:200,requestJson:JSON.stringify({stopPrice:98,takeProfitPrice:104})}});
        const guards:import("@prisma/client").DeskIntent[]=[];for(const [kind,price,oid] of [["sl",98,"2"],["tp",104,"3"]] as const)guards.push(await db.deskIntent.create({data:{...base,quantity:1,filledQty:0,side:"sell",intentKey:kind,cloid:"0x"+kind,oid,groupKey:"guard/"+kind,state:"working",reservedUsd:0,limitPrice:price,requestJson:JSON.stringify({reduceOnly:true})}}));
        await db.deskInventory.create({data:{bookId:book.id,instrumentId:sol,quantity:1,basis:100,stopPrice:98,targetPrice:104}});
        await db.deskCashFlow.create({data:{bookId:book.id,intentId:entry.id,instrumentId:sol,venueKey:"one-fill",kind:"fill",quantity:1,price:100,feeUsd:0,pnlUsd:0,shortfallUsd:0,occurredAt:new Date()}});
        const write=vi.fn(async()=>{throw Error("Reconciliation must not write to venue");});
        const venue:import("@/lib/desk/execution-types").DeskVenue={instruments:async()=>[instrument],book:async()=>({time:Date.now(),levels:[[],[]]}),fills:async()=>[],funding:async()=>[],write,
            status:async(_,cloid)=>cloid===entry.cloid?{oid:"1",cloid,status:"filled",originalQuantity:2,remainingQuantity:1,statusTimestamp:Date.now()-1000}:({oid:cloid==="0xsl"?"2":"3",cloid:String(cloid),status:"open"}),
            account:async()=>({positions:new Map([["perp:SOL",1]]),freeSpot:new Map(),marks:new Map([[sol,100]]),tokenUsd:new Map(),equity:1245,grossUsd:100,rollingPnl:0,openOrders:guards.map(g=>({coin:"SOL",oid:Number(g.oid),cloid:g.cloid,side:"A" as const,sz:"1",limitPx:String(g.limitPrice),reduceOnly:true}))})};
        await syncLedger(db,venue,book,[instrument]);await syncLedger(db,venue,book,[instrument]);
        expect(await db.deskIntent.findUniqueOrThrow({where:{id:entry.id}})).toMatchObject({state:"filled",filledQty:1,quantity:2,reservedUsd:0});
        for(const g of guards)expect(await db.deskIntent.findUniqueOrThrow({where:{id:g.id}})).toMatchObject({state:"working",oid:g.oid,limitPrice:g.limitPrice,quantity:1});
        expect(await db.deskRecord.count({where:{bookId:book.id,kind:"order_reconciliation"}})).toBe(1);
        expect(await db.deskCashFlow.count({where:{bookId:book.id}})).toBe(1);expect(write).not.toHaveBeenCalled();
    });
    it("shows agents pending stop risk separately from reserved notional",async()=>{
        let book=await newBook();book=await db.deskBook.update({where:{id:book.id},data:{mandateJson:JSON.stringify(SWING_DESK_MANDATE)}});
        await db.deskInventory.create({data:{bookId:book.id,instrumentId:sol,quantity:1,basis:100,stopPrice:98}});
        await db.deskIntent.create({data:{bookId:book.id,intentKey:"pending-other",cloid:"0xpendingother",instrumentId:"mainnet:perp:OTHER",coin:"OTHER",asset:999,policyVersion:book.version,side:"buy",quantity:1,filledQty:0,limitPrice:100,arrivalPrice:100,fingerprint:"pending",state:"working",reservedUsd:100,requestJson:JSON.stringify({stopPrice:98})}});
        fixture.exposure.mockResolvedValue({positions:[{coin:"SOL",quantity:"1",value:"100"}],openOrders:[],spot:[],collateral:{accountMode:"unifiedAccount",spotUsdcAvailable:1245,status:"unified_usdc_collateral_present"}});
        fixture.quote.mockImplementation(async()=>({bid:99.99,ask:100,time:Date.now(),bids:[{px:"99.99",sz:"10000"}],asks:[{px:"100",sz:"10000"}]}));
        await queueWake(db,book,"size-test","operator","research",{});const shift=(await claimShift(book))!;
        const size=deskTools(book,shift).find(t=>t.name==="size_swing_trade")!;
        const result=await size.run({instrumentId:sol,side:"buy",stopPrice:98},{role:"lead",shiftId:shift.id,callId:"size",signal:new AbortController().signal});
        expect(result).toMatchObject({riskBudgetUsd:6.225*.98,policyRiskPerTradeUsd:6.225,sizingHeadroomBps:200,riskBreakdown:{positionRiskUsd:2.5,pendingRiskUsd:2.5,pendingNotionalUsd:100,aggregateRiskLimitUsd:12.45}});
        expect((result as {quantity:number}).quantity).toBeGreaterThan(0);
    });
    it("retries a busy read-only preview without submitting an order",async()=>{
        const book=await newBook();await queueWake(db,book,"preview-retry","operator","research",{});
        const shift=(await claimShift(book))!;
        fixture.preview.mockRejectedValueOnce(new Error("Desk execution busy; retry with the same intent key")).mockResolvedValueOnce({quantity:1,limitPrice:99});
        const tool=deskTools(book,shift).find(t=>t.name==="preview_order")!;
        expect(await tool.run({instrumentId:sol,side:"buy",quantity:1,limitPrice:99,stopPrice:95,thesis:"Test retry"},{role:"lead",shiftId:shift.id,callId:"retry",signal:new AbortController().signal})).toMatchObject({previewReceipt:"retry"});
        expect(fixture.preview).toHaveBeenCalledTimes(2);expect(await db.deskIntent.count()).toBe(0);
    });
    it("preserves separate tool evidence when later invocations reuse a provider call ID", async()=>{
        const book=await newBook();await queueWake(db,book,"evidence","operator","research",{});
        const shift=(await claimShift(book))!;
        const tool=deskTools(book,shift).find(t=>t.name==="find_instruments")!;
        const context={role:"lead" as const,shiftId:shift.id,signal:new AbortController().signal,callId:"call_1"};
        const first=await tool.run({query:"SOL"},{...context,invocationId:"first"});
        const second=await tool.run({query:"MISSING"},{...context,invocationId:"second"});
        expect(first).not.toEqual(second);
        const rows=await db.deskRecord.findMany({where:{bookId:book.id,shiftId:shift.id,kind:"tool_result"},orderBy:{id:"asc"}});
        expect(rows).toHaveLength(2);
        expect(rows.map(r=>JSON.parse(JSON.parse(r.dataJson).result))).toEqual([first,second]);
        expect(rows.map(r=>JSON.parse(r.dataJson).callId)).toEqual(["first:call_1","second:call_1"]);
    });
    it("operator strategy activation never enables a stopped paper book",async()=>{
        const {setStrategyState}=await import("@/lib/desk/books");
        let book=await newBook();
        book=await db.deskBook.update({where:{id:book.id},data:{enabled:false,isTestnet:true,mandateJson:JSON.stringify(SWING_DESK_MANDATE)}});
        await setStrategyState(book,{version:book.version,strategyVersion:"continuation-1",state:"active"});
        expect((await db.deskBook.findUniqueOrThrow({where:{id:book.id}})).enabled).toBe(false);
        const rollout=await db.deskRecord.findUniqueOrThrow({where:{bookId_key:{bookId:book.id,key:"strategy-rollout:continuation-1"}}});
        expect(JSON.parse(rollout.dataJson).state).toBe("active");
        await setStrategyState(book,{version:book.version,strategyVersion:"continuation-1",state:"research_only"});
        expect(await db.deskIntent.count({where:{bookId:book.id}})).toBe(0);
    });
    it("refreshes the actual profile tool for every role after a mandate edit, scoped by book", async () => {
        const { currentDecisionPolicy } = await import("@/lib/desk/decision-policy");
        const book = await newBook();
        await queueWake(db, book, "mandate-read", "operator", "research", {});
        let shift = (await claimShift(book))!;
        let profile = deskTools(book, shift).find(t => t.name === "strategy_profile")!;
        const mandate = { ...SWING_DESK_MANDATE, capitalUsd: 900, maxOrderUsd: 350, maxInstrumentUsd: 450, maxGrossLeverage: .8,
            maxDailyLossUsd: 18, maxRiskPerTradeUsd: 8, maxSlippageBps: 12, minDepthUsd: 4000, maxOpenRiskUsd: 40, maxConcurrentPositions: 7, costAllowanceBps: 35 };
        await db.deskRecord.create({ data: { bookId: book.id, key: "strategy-rollout:desk-discretionary-1", kind: "strategy_rollout", role: "operator",
            dataJson: JSON.stringify({ version: "desk-discretionary-1", state: "active", bookVersion: book.version, capitalCeilingUsd: 1245 }) } });
        const changed = await db.deskBook.update({ where: { id: book.id }, data: { version: { increment: 1 }, mandateJson: JSON.stringify(mandate) } });
        await expect(profile.run({}, { role: "lead", shiftId: shift.id, callId: "obsolete", signal: new AbortController().signal })).rejects.toThrow("lost its mandate");
        await db.deskShift.update({ where: { id: shift.id }, data: { status: "paused", lease: null, leaseUntil: null } });
        await queueWake(db, changed, "mandate-refreshed", "operator", "research", {});
        shift = (await claimShift(changed))!;
        profile = deskTools(changed, shift).find(t => t.name === "strategy_profile")!;
        fixture.quote.mockClear();
        for (const role of ["lead", "risk", "execution", "derivatives", "catalyst"] as const) {
            const result: any = await profile.run({}, { role, shiftId: shift.id, callId: role, signal: new AbortController().signal });
            expect(result).toMatchObject({ bookVersion: changed.version, mandate, capitalCeilingUsd: 900, riskPerTradeUsd: 8,
                aggregateOpenRiskUsd: 40, dailyLossUsd: 18, maxConcurrentPositions: 7, maxOrderUsd: 350, maxInstrumentUsd: 450,
                maxGrossLeverage: .8, maxSlippageBps: 12, minDepthUsd: 4000, costAllowanceBps: 35,
                rollout: { state: "active", activationSnapshot: { bookVersion: book.version } }, newsStrategy: { activationSupported: false } });
            expect(result.rollout).not.toHaveProperty("bookVersion");
            expect(result.newsStrategy).not.toHaveProperty("aggregateOpenRiskUsd");
        }
        const lower = { ...mandate, maxOpenRiskUsd: 9, maxRiskPerTradeUsd: 3, maxConcurrentPositions: 3 };
        await db.deskBook.update({ where: { id: book.id }, data: { version: { increment: 1 }, mandateJson: JSON.stringify(lower) } });
        expect(await currentDecisionPolicy(db, book))
            .toMatchObject({ profile: { bookVersion: changed.version + 1, riskPerTradeUsd: 3, aggregateOpenRiskUsd: 9, maxConcurrentPositions: 3 } });
        let other = await newBook(sub);
        other = await db.deskBook.update({ where: { id: other.id }, data: { isTestnet: true, enabled: false, mandateJson: JSON.stringify({ ...mandate, maxOpenRiskUsd: 22 }) } });
        expect(await currentDecisionPolicy(db, other)).toMatchObject({ profile: { aggregateOpenRiskUsd: 22 }, rollout: { state: "research_only" } });
        expect(await db.deskBook.findUniqueOrThrow({ where: { id: book.id } })).toMatchObject({ version: changed.version + 1, mandateJson: JSON.stringify(lower) });
        expect(fixture.quote).not.toHaveBeenCalled();
        expect(await db.deskIntent.count()).toBe(0);
    });
    it("validates saved proposal risk against the book instead of a fixed schema budget", async () => {
        const { saveTradeProposal } = await import("@/lib/desk/proposals");
        let book = await newBook();
        book = await db.deskBook.update({ where: { id: book.id }, data: { mandateJson: JSON.stringify({ ...SWING_DESK_MANDATE, maxRiskPerTradeUsd: 8 }) } });
        await queueWake(db, book, "proposal-mandate", "operator", "research", {});
        const shift = (await claimShift(book))!, signal = new AbortController().signal;
        const draft = { ...proposalDraft(), setup: { strategyVersion: "desk-discretionary-1" as const, entryCondition: "Research setup with explicit current-book risk",
            stopPrice: 101, targetPrice: 95, holdHours: 3, riskBudgetUsd: 7, entryExpiresAt: new Date(Date.now() + 600000).toISOString(), backtestRunIds: [] } };
        const saved = await saveTradeProposal(db, book, shift, "lead", draft, signal);
        expect(saved.setup?.riskBudgetUsd).toBe(7);
        await expect(saveTradeProposal(db, book, shift, "lead", { ...draft, expectedRevision: 1, setup: { ...draft.setup, riskBudgetUsd: 9 } }, signal)).rejects.toThrow("current book mandate");
        expect(await db.deskIntent.count()).toBe(0);
        expect((await db.deskBook.findUniqueOrThrow({ where: { id: book.id } })).mandateJson).toBe(book.mandateJson);
    });
    it("switches decision authority atomically while preserving controls and stopped paper",async()=>{
        const {setStrategyState}=await import("@/lib/desk/books");
        const {currentDecisionPolicy}=await import("@/lib/desk/decision-policy");
        let book=await newBook();
        book=await db.deskBook.update({where:{id:book.id},data:{enabled:false,isTestnet:true,mandateJson:JSON.stringify(SWING_DESK_MANDATE)}});
        await setStrategyState(book,{version:book.version,strategyVersion:"continuation-1",state:"active"});
        await setStrategyState(book,{version:book.version,strategyVersion:"desk-discretionary-1",state:"active"});
        const old=await db.deskRecord.findUniqueOrThrow({where:{bookId_key:{bookId:book.id,key:"strategy-rollout:continuation-1"}}});
        expect(JSON.parse(old.dataJson)).toMatchObject({state:"research_only",supersededBy:"desk-discretionary-1"});
        expect(await currentDecisionPolicy(db,book)).toMatchObject({profile:{version:"desk-discretionary-1",mandatoryEntryPattern:null},rollout:{state:"active"}});
        expect(await db.deskBook.findUniqueOrThrow({where:{id:book.id}})).toMatchObject({enabled:false,isTestnet:true,mandateJson:book.mandateJson,version:book.version});
        await setStrategyState(book,{version:book.version,strategyVersion:"continuation-1",state:"active"});
        expect(await currentDecisionPolicy(db,book)).toMatchObject({profile:{version:"continuation-1"},rollout:{state:"active"}});
        expect(await db.deskIntent.count({where:{bookId:book.id}})).toBe(0);
    });
    const researchInput=()=>({
        hypothesis:"Explicit no-trade control for the desk replay",
        source:"collector",start:"2026-11-01T00:00:00Z",end:"2026-11-01T01:00:00Z",instrumentIds:[sol],
        intervalSeconds:60,feeBpsPerSide:3.5,extraSlippageBps:1,orders:[],
    });
    it("does not charge invalid proposal links against the two successful research slots",async()=>{
        const book=await newBook();await queueWake(db,book,"admission-budget","operator","research",{});
        const shift=(await claimShift(book))!,test=deskTools(book,shift).find(t=>t.name==="backtest_strategy")!;
        const run=(args:Record<string,unknown>,callId:string)=>test.run(args,{role:"lead",shiftId:shift.id,callId,signal:new AbortController().signal});
        await expect(run({...researchInput(),proposalKey:"missing-draft"},"invalid")).rejects.toThrow("current backlog");
        expect(await db.deskRecord.count({where:{bookId:book.id,kind:"research_budget"}})).toBe(0);
        await run(researchInput(),"valid-one");await run(researchInput(),"valid-two");
        await expect(run(researchInput(),"over-budget")).rejects.toThrow("budget exhausted");
        expect(await db.deskResearchRun.count({where:{bookId:book.id}})).toBe(2);
    });
    it("requires an explicit mean reference before fetching metadata and preserves old retry semantics",async()=>{
        const {enqueueResearch,retryFailedResearch}=await import("@/lib/desk/backtest/jobs");
        const book=await newBook();
        const rule={name:"fade",signal:"mean_reversion",side:"both",lookbackBars:20,thresholdBps:200,orderUsd:100,stopBps:300,targetBps:200,maxHoldBars:6,cooldownBars:6};
        const req={engine:"candles",source:"venue_candles",hypothesis:"Explicit prior-SMA deviation",instrumentIds:[sol],start:"2026-09-01T00:00:00Z",end:"2026-11-01T00:00:00Z",intervalSeconds:3600,feeBpsPerSide:4.5,extraSlippageBps:5,variants:[rule]};
        fixture.metadataDown=true;
        await expect(enqueueResearch(db,book,req)).rejects.toThrow("Declare meanReference");
        fixture.metadataDown=false;
        const fresh=await enqueueResearch(db,book,{...req,variants:[{...rule,meanReference:"prior_sma"}]});
        const stored=await db.deskResearchRun.findUniqueOrThrow({where:{id:fresh.runId}}),frozen=JSON.parse(stored.requestJson);
        expect(frozen.request.variants[0].meanReference).toBe("prior_sma");
        delete frozen.request.variants[0].meanReference;
        await db.deskResearchRun.update({where:{id:fresh.runId},data:{status:"failed",requestJson:JSON.stringify(frozen)}});
        fixture.metadataDown=true;
        const retried=await retryFailedResearch(db,book,fresh.runId);
        const saved=await db.deskResearchRun.findUniqueOrThrow({where:{id:retried.runId}});
        expect(JSON.parse(saved.requestJson).request.variants[0].meanReference).toBeUndefined();
        fixture.metadataDown=false;
    });
    it("reuses only an owner-scoped immutable candle dataset without metadata reads",async()=>{
        const {enqueueResearch}=await import("@/lib/desk/backtest/jobs");
        const {saveDeskArtifact}=await import("@/lib/desk/artifacts");
        const book=await newBook();const rule={name:"comparison",signal:"mean_reversion",meanReference:"lookback_price",side:"both",lookbackBars:20,thresholdBps:200,orderUsd:100,stopBps:300,targetBps:200,maxHoldBars:6,cooldownBars:6};
        const req={engine:"candles",source:"venue_candles",hypothesis:"Matched frozen dataset comparison",instrumentIds:[sol],start:"2026-09-01T00:00:00Z",end:"2026-11-01T00:00:00Z",intervalSeconds:3600,feeBpsPerSide:4.5,extraSlippageBps:5,variants:[rule]};
        const source=await enqueueResearch(db,book,req),artifact=await saveDeskArtifact(db,book.id,"research_candle_dataset",[]);
        await db.deskResearchRun.update({where:{id:source.runId},data:{status:"completed",datasetArtifactId:artifact.artifactId}});
        fixture.metadataDown=true;
        const reused=await enqueueResearch(db,book,{...req,reuseDatasetRunId:source.runId,variants:[{...rule,meanReference:"prior_sma"}]});
        const stored=await db.deskResearchRun.findUniqueOrThrow({where:{id:reused.runId}});
        expect(JSON.parse(stored.requestJson)).toMatchObject({datasetReference:{runId:source.runId,artifactId:artifact.artifactId,sha256:artifact.sha256}});
        await expect(enqueueResearch(db,book,{...req,reuseDatasetRunId:source.runId,intervalSeconds:900})).rejects.toThrow("preserve dates");
        const other=await newBook(sub);await expect(enqueueResearch(db,other,{...req,reuseDatasetRunId:source.runId})).rejects.toThrow("current-book");
        await db.deskArtifact.update({where:{id:artifact.artifactId},data:{sha256:"corrupt"}});
        await expect(enqueueResearch(db,book,{...req,reuseDatasetRunId:source.runId})).rejects.toThrow("checksum mismatch");
        fixture.metadataDown=false;
    });
    it("registers an actual five-minute technical watch without reading depth",async()=>{
        const book=await newBook();await queueWake(db,book,"entry-watch","operator","research",{});
        const shift=(await claimShift(book))!,set=deskTools(book,shift).find(t=>t.name==="set_watch")!;
        fixture.quote.mockClear();
        const result:any=await set.run({kind:"technical",instrumentId:sol,side:"sell",technical:{intervalSeconds:300,condition:"resumption",minTrendBps:0},thesis:"Reassess on missing five-minute entry confirmation",deadline:new Date(Date.now()+3600000).toISOString()},{role:"lead",shiftId:shift.id,callId:"five-minute",signal:new AbortController().signal});
        expect(result.watchId).toBeTruthy();expect(fixture.quote).not.toHaveBeenCalled();
        const w=await db.deskWatch.findUniqueOrThrow({where:{id:result.watchId}});expect(JSON.parse(w.outcomeJson!).technical.intervalSeconds).toBe(300);
    });
    it("freezes prospective rules, scopes enrollment, limits concurrent studies and leaves all execution stopped",async()=>{
        const {enqueueResearch}=await import("@/lib/desk/backtest/jobs");
        const {saveDeskArtifact}=await import("@/lib/desk/artifacts");
        const {prospectiveTools}=await import("@/lib/desk/prospective");
        const book=await newBook();await queueWake(db,book,"forward-fixture","operator","research",{});
        const shift=(await claimShift(book))!;
        const ctx={role:"lead" as const,shiftId:shift.id,callId:"register",signal:new AbortController().signal};
        const rule={name:"short-breakout",signal:"breakout",side:"short",lookbackBars:20,thresholdBps:30,orderUsd:100,stopBps:200,targetBps:400,maxHoldBars:12,cooldownBars:12};
        const req={engine:"candles",source:"venue_candles",hypothesis:"Predeclared short breakout mechanism",instrumentIds:[sol],start:"2026-09-01T00:00:00Z",end:"2026-11-01T00:00:00Z",intervalSeconds:3600,feeBpsPerSide:4.5,extraSlippageBps:3,variants:[rule]};
        const artifact=await saveDeskArtifact(db,book.id,"research_result",{engine:"desk-candle-1"});
        const complete=async()=>{const run=await enqueueResearch(db,book,req);await db.deskResearchRun.update({where:{id:run.runId},data:{status:"completed",resultArtifactId:artifact.artifactId}});return run.runId;};
        const tool=prospectiveTools(db,book)[0],id=await complete();
        const first:any=await tool.run({runId:id,variantName:rule.name,days:2},ctx);
        const reused:any=await tool.run({runId:id,variantName:rule.name,days:30},ctx);
        expect(reused).toMatchObject({studyId:first.studyId,endAt:first.endAt,reused:true,rule});
        await scheduleRoleFollowUp(db,book,shift,"lead",{...note("lead"),evidenceIds:[first.studyId],followUpAt:first.endAt},ctx.signal);
        expect(await db.deskWatch.count({where:{bookId:book.id,kind:"review"}})).toBe(0);
        await expect(tool.run({runId:id,variantName:"changed",days:2},ctx)).rejects.toThrow("saved variant");
        const other=await newBook(sub);await expect(prospectiveTools(db,other)[0].run({runId:id,variantName:rule.name,days:2},ctx)).rejects.toThrow("current-book");
        for(let i=0;i<2;i++)await tool.run({runId:await complete(),variantName:rule.name,days:2},ctx);
        const fourth=await complete();const queued:any=await tool.run({runId:fourth,variantName:rule.name,days:2},ctx);
        expect(queued).toMatchObject({status:"queued",recordedDecisions:0});
        const {admitQueuedStudies}=await import("@/lib/desk/prospective");
        await admitQueuedStudies(db,book);
        const records=await db.deskRecord.findMany({where:{bookId:book.id,kind:"prospective_study"}});
        expect(records.filter(r=>JSON.parse(r.dataJson).status==="observing")).toHaveLength(3);
        const active=records.find(r=>JSON.parse(r.dataJson).status==="observing")!;
        await db.deskRecord.update({where:{id:active.id},data:{dataJson:JSON.stringify({...JSON.parse(active.dataJson),status:"completed"})}});
        const admission=Date.now()+86400000;
        await admitQueuedStudies(db,book,admission);
        const admitted=await db.deskRecord.findFirstOrThrow({where:{bookId:book.id,key:{endsWith:queued.studyId}}});
        expect(JSON.parse(admitted.dataJson)).toMatchObject({status:"observing",registeredAt:admission,decisions:[]});
        expect(JSON.parse(admitted.dataJson).endAt).toBeGreaterThan(admission+47*3600000);
        const fifth=await complete();
        await db.deskBook.update({where:{id:book.id},data:{enabled:false}});
        await expect(tool.run({runId:fifth,variantName:rule.name,days:2},ctx)).rejects.toThrow("Stopped books");
        expect(await db.deskIntent.count()).toBe(0);
        const stored=await db.deskRecord.findMany({where:{bookId:book.id,kind:"prospective_study"}});
        expect(stored).toHaveLength(4);expect(stored.every(r=>JSON.parse(r.dataJson).decisions.length===0)).toBe(true);
    });
    it("preserves entry criteria through legacy updates and freezes a paired comparison without trading", async () => {
        const book = await newBook();
        await queueWake(db, book, "entry-comparison", "operator", "live", {});
        const shift = (await claimShift(book))!;
        const signal = new AbortController().signal;
        const decisionPlan = {
            mechanism: "Selling may persist after the recorded demand failure",
            horizonHours: 6,
            sufficientEvidence: "Two completed five-minute closes below 100",
            thesisInvalidation: "Recovery above the original selling range",
            action: "wait" as const,
            reason: "Compare whether waiting improves the entry economics",
            confirmation: { condition: "Two completed five-minute closes below 100", observationMinutes: 10, horizonRelevance: "Test persistence of the selling impulse at the six-hour horizon" },
            uncertainty: "The incremental benefit of confirmation is unmeasured",
            nextAction: "Freeze a forward comparison of immediate and confirmed entry",
            changeReason: null,
            assessment: {
                observations: [{ fact: "The latest completed candle closed below the failed recovery", evidenceId: "history-sol" }],
                competingExplanation: "A temporary inventory adjustment could reverse this decline",
                discriminatingEvidence: "Persistence after the failed recovery favors the selling hypothesis, without identifying trader intent",
                horizonRationale: "The observed recovery and failure developed over several hours",
                decisionBoundary: "Recovery above the recorded range would invalidate the selling explanation",
                alternativeExpression: null,
            },
        };
        const draft = { ...proposalDraft(), decisionPlan, validUntil: new Date(Date.now() + 8 * 3600000).toISOString() };
        const saved = await saveTradeProposal(db, book, shift, "lead", draft, signal);
        const tools = deskTools(book, shift);
        const compare = tools.find(t => t.name === "compare_entry_timing")!;
        const args = { proposalKey: draft.key, proposalRevision: saved.revision, intervalSeconds: 300, relation: "below", price: 100, closedBars: 2, maxWaitHours: 1, orderUsd: 100, stopBps: 200, targetBps: 400, feeBpsPerSide: 4.5, extraSlippageBps: 20.5, costAssumptions: "Estimated 4.5bps fee each side and 20.5bps slippage reserve each side" };
        const ctx = { role: "lead" as const, shiftId: shift.id, signal, callId: "compare" };
        const first: any = await compare.run(args, ctx);
        const reused: any = await compare.run({ ...args, price: 99 }, { ...ctx, callId: "retry" });
        expect(first).toMatchObject({ scope: "paired_entry_timing_simulation", comparison: { proposalRevision: 1, confirmation: { price: 100 }, comparable: false } });
        expect(reused).toMatchObject({ studyId: first.studyId, reused: true, comparison: { confirmation: { price: 100 } } });
        await expect(saveTradeProposal(db, book, shift, "lead", { ...draft, expectedRevision: 1, decisionPlan: { ...decisionPlan, sufficientEvidence: "Wait for a new lower threshold" } }, signal)).rejects.toThrow("Entry criteria changed");
        const legacyUpdate = { ...proposalDraft(), expectedRevision: 1, economics: "Rechecked costs with the original entry criterion" };
        const updated = await saveTradeProposal(db, book, shift, "lead", legacyUpdate, signal);
        expect(updated.decisionPlan).toEqual(decisionPlan);
        const read: any = await tools.find(t => t.name === "trade_plan")!.run({ proposalKey: draft.key }, { ...ctx, callId: "read" });
        expect(read.decisionHistory.map((p: any) => p.revision)).toEqual([2, 1]);
        const ledger = await import("@/lib/desk/work-ledger");
        expect((await ledger.deskWorkSnapshot(db, book)).items).toContainEqual(expect.objectContaining({ kind: "study", state: "waiting", proposalKey: draft.key }));
        await scheduleRoleFollowUp(db, book, shift, "lead", { ...note("lead"), evidenceIds: [first.studyId], followUpAt: first.endAt }, signal);
        expect(await db.deskWatch.count({ where: { bookId: book.id, kind: "review" } })).toBe(0);
        await saveTradeProposal(db, book, shift, "lead", { ...legacyUpdate, expectedRevision: 2, status: "closed" }, signal);
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "entry_comparison" } })).toBe(1);
        expect(await db.deskIntent.count()).toBe(0);
    });
    it("research can see live parked ideas, link runs and persist a bounded disposition without changing live proposals",async()=>{
        const {researchBacklog,researchBacklogTools}=await import("@/lib/desk/research-backlog");
        const {enqueueResearch}=await import("@/lib/desk/backtest/jobs");
        const book=await newBook();
        const key="old-sol-idea", proposal={key,revision:1,status:"parked",thesis:"Test an explicit SOL mechanism",legs:[{instrumentId:sol,side:"buy"}],missingEvidence:["historical edge"],researchPlan:[],updatedAt:new Date(Date.now()-86400000).toISOString(),validUntil:new Date(Date.now()+86400000).toISOString()};
        const record=await db.deskRecord.create({data:{bookId:book.id,key:`proposal:${book.version}:live:${key}`,kind:"trade_proposal",role:"lead",dataJson:JSON.stringify(proposal)}});
        await db.deskRecord.create({data:{bookId:book.id,key:`proposal:${book.version}:research:${key}`,kind:"trade_proposal",role:"lead",dataJson:JSON.stringify({...proposal,status:"closed"})}});
        expect((await researchBacklog(db,book))[0]).toMatchObject({proposalKey:key,mode:"live",due:true});
        const first=await enqueueResearch(db,book,{...researchInput(),proposalKey:key});
        await expect(enqueueResearch(db,book,{...researchInput(),proposalKey:key})).rejects.toThrow(/active research/);
        await db.deskResearchRun.update({where:{id:first.runId},data:{status:"completed"}});
        const second=await enqueueResearch(db,book,{...researchInput(),proposalKey:key});
        await db.deskResearchRun.update({where:{id:second.runId},data:{status:"completed"}});
        await expect(enqueueResearch(db,book,{...researchInput(),proposalKey:key})).rejects.toThrow(/two completed/);
        await queueWake(db,book,"review-backlog","operator","research",{});
        const shift=(await claimShift(book))!;
        const resolve=researchBacklogTools(db,book).find(t=>t.name==="resolve_research_idea")!;
        const args={proposalKey:key,status:"waiting_external",reason:"Historical execution coverage is missing for this instrument. Revisit after new recorded books are available.",runIds:[first.runId,second.runId],nextReviewAt:new Date(Date.now()+86400000).toISOString()};
        const ctx={role:"lead" as const,shiftId:shift.id,callId:"resolve",signal:new AbortController().signal};
        await expect(resolve.run(args,{...ctx,role:"derivatives"})).rejects.toThrow(/Only the lead/);
        await expect(resolve.run(args,ctx)).rejects.toThrow(/Check actual/);
        await db.deskRecord.create({data:{bookId:book.id,shiftId:shift.id,key:"coverage-check",kind:"tool_result",role:"lead",dataJson:JSON.stringify({tool:"backtest_catalog",result:{collector:{status:"unavailable"}}})}});
        await resolve.run(args,ctx);
        expect((await researchBacklog(db,book))[0]).toMatchObject({due:false,disposition:{status:"waiting_external"}});
        // Superseded failed infrastructure evidence can be cited beside a real result.
        await db.deskResearchRun.update({where:{id:first.runId},data:{status:"failed"}});
        await resolve.run(args,ctx);
        expect(await db.deskWake.count({where:{bookId:book.id,kind:"research_disposition",mode:"live"}})).toBe(1);
        await resolve.run(args,ctx);
        expect(await db.deskWake.count({where:{bookId:book.id,kind:"research_disposition"}})).toBe(1);
        await db.deskBook.update({where:{id:book.id},data:{enabled:false}});
        await resolve.run({...args,status:"rejected",nextReviewAt:null},ctx);
        expect(await db.deskWake.count({where:{bookId:book.id,kind:"research_disposition"}})).toBe(1);
        expect((await db.deskRecord.findUniqueOrThrow({where:{id:record.id}})).dataJson).toBe(JSON.stringify(proposal));
        expect(await db.deskIntent.count()).toBe(0);
    });
    it("delivers new research by event, freezes pending reads across recovery, and consumes only assessed result notices",async()=>{
        const {enqueueResearch}=await import("@/lib/desk/backtest/jobs");
        const {agentResearchStatus,consumeResearchReviews}=await import("@/lib/desk/backtest/delivery");
        const {saveDeskArtifact}=await import("@/lib/desk/artifacts");
        const book=await newBook();await queueWake(db,book,"origin","operator","research",{});
        const origin=(await claimShift(book))!;
        const queued=await enqueueResearch(db,book,researchInput(),undefined,origin.id);
        expect(await agentResearchStatus(db,book,origin.id,queued.runId)).toMatchObject({status:"awaiting_completion_review"});
        const artifact=await saveDeskArtifact(db,book.id,"research_result",{selection:{status:"insufficient_sample"},holdout:null});
        await db.deskResearchRun.update({where:{id:queued.runId},data:{status:"completed",resultArtifactId:artifact.artifactId,finishedAt:new Date()}});
        await queueWake(db,book,"research:"+queued.runId,"research_complete","research",{runId:queued.runId});
        // Even after completion/crash recovery, an originating turn cannot poll the result.
        expect(await agentResearchStatus(db,book,origin.id,queued.runId)).toMatchObject({status:"awaiting_completion_review",reused:true});
        await consumeResearchReviews(db,book,origin,[queued.runId]);
        expect((await db.deskWake.findFirstOrThrow({where:{key:"research:"+queued.runId}})).shiftId).toBeNull();
        // A prior experiment can finish during an independent review. Consuming it
        // must leave the other result and all failed/pending work untouched.
        const prior=await enqueueResearch(db,book,researchInput());
        await db.deskResearchRun.update({where:{id:prior.runId},data:{status:"completed",resultArtifactId:artifact.artifactId,finishedAt:new Date()}});
        await queueWake(db,book,"research:"+prior.runId,"research_complete","research",{runId:prior.runId});
        expect(await agentResearchStatus(db,book,origin.id,prior.runId)).toMatchObject({status:"completed",resultArtifactId:artifact.artifactId});
        await db.$transaction(tx=>consumeResearchReviews(tx,book,origin,[prior.runId,queued.runId]));
        expect((await db.deskWake.findFirstOrThrow({where:{key:"research:"+prior.runId}})).shiftId).toBe(origin.id);
        expect(await db.deskRecord.count({where:{kind:"research_reviewed"}})).toBe(1);
        await db.deskShift.update({where:{id:origin.id},data:{status:"completed",leaseUntil:null}});
        const completion=(await claimShift(book))!;
        expect(JSON.parse(completion.briefJson).triggers.map((t:any)=>t.payload.runId)).toEqual([queued.runId]);
        expect(await agentResearchStatus(db,book,completion.id,queued.runId)).toMatchObject({status:"completed"});
        await expect(agentResearchStatus(db,{...book,id:"another-book"},completion.id,queued.runId)).rejects.toThrow(/not found/);
        expect(await db.deskIntent.count()).toBe(0);
    });
    it("accepts a bounded SOL watch and journals actionable schema failures without creating a watch",async()=>{
        const {default:Ajv}=await import("ajv");const {toolSchemaError}=await import("@/lib/desk/runtime");
        const book=await newBook();await queueWake(db,book,"watch-repair","operator","research",{});
        const shift=(await claimShift(book))!;const tool=deskTools(book,shift).find(t=>t.name==="set_watch")!;
        const validate=new Ajv({strict:false}).compile(tool.inputSchema);
        const args={kind:"pass",instrumentId:sol,side:"buy",deadline:new Date(Date.now()+3600000).toISOString(),thesis:"Known event; wait for measurable adoption. "+"x".repeat(750)};
        const context={role:"lead" as const,shiftId:shift.id,callId:"watch",signal:new AbortController().signal};
        expect(validate(args)).toBe(true);expect(await tool.run(args,context)).toMatchObject({watchId:expect.any(String)});
        const invalid={...args,thesis:"x".repeat(1001)};expect(validate(invalid)).toBe(false);
        const error=toolSchemaError(validate.errors);expect(error).toMatch(/thesis.*1000/);
        await tool.onValidationError!(invalid,{...context,callId:"invalid"},error);
        expect(await db.deskWatch.count()).toBe(1);
        const failure=await db.deskRecord.findFirstOrThrow({where:{kind:"tool_validation_error"}});
        expect(JSON.parse(failure.dataJson)).toMatchObject({name:"set_watch",error});
    });
    it("queues unique immutable experiments and isolates their results by book",async()=>{
        const {enqueueResearch,researchStatus}=await import("@/lib/desk/backtest/jobs");
        const book=await newBook(),a=await enqueueResearch(db,book,researchInput()),b=await enqueueResearch(db,book,researchInput());
        expect(a.runId).not.toBe(b.runId);
        const row=await db.deskResearchRun.findUniqueOrThrow({where:{id:a.runId}});
        expect(JSON.parse(row.requestJson).context.mandate).toEqual(DEFAULT_DESK_MANDATE);
        expect(JSON.parse(row.manifestJson).sourceHashes["lib/desk/backtest/engine.ts"]).toMatch(/^[a-f0-9]{64}$/);
        await expect(researchStatus(db,"another-book",a.runId)).rejects.toThrow(/not found/);
    });
    it("finishes research with artifacts and wakes only a read-only review",async()=>{
        const {enqueueResearch}=await import("@/lib/desk/backtest/jobs");
        const {DeskResearchWorker}=await import("@/services/DeskResearchWorker");
        const book=await newBook(),run=await enqueueResearch(db,book,researchInput());
        const execute=vi.fn(async()=>({datasetArtifactId:"dataset",resultArtifactId:"result"}));
        expect(await new DeskResearchWorker(db,execute).tick(new AbortController().signal)).toBe(true);
        expect(await db.deskResearchRun.findUnique({where:{id:run.runId}})).toMatchObject({status:"completed",resultArtifactId:"result",lease:null});
        expect(await db.deskWake.findFirst({where:{key:"research:"+run.runId}})).toMatchObject({mode:"research",kind:"research_complete"});
    });
    it("recovers failed research once with frozen parameters and no stopped-paper wake",async()=>{
        const {enqueueResearch,retryFailedResearch}=await import("@/lib/desk/backtest/jobs");
        const {publishResearchHealth}=await import("@/lib/desk/backtest/recovery");
        const book=await newBook(),paper=await newBook("0x"+"2".repeat(40));
        await db.deskBook.update({where:{id:paper.id},data:{isTestnet:true,enabled:false}});
        const initial=await enqueueResearch(db,book,researchInput());
        await db.deskResearchRun.update({where:{id:initial.runId},data:{status:"failed",error:"Transform failed: Unexpected NUL byte"}});
        fixture.metadataDown=true; // Retrying the frozen metadata needs no registry request.
        const retried=await retryFailedResearch(db,book,initial.runId);
        expect((await retryFailedResearch(db,book,initial.runId)).runId).toBe(retried.runId);
        const old=await db.deskResearchRun.findUniqueOrThrow({where:{id:initial.runId}}),fresh=await db.deskResearchRun.findUniqueOrThrow({where:{id:retried.runId}});
        expect(JSON.parse(fresh.requestJson).request).toEqual(JSON.parse(old.requestJson).request);
        expect(JSON.parse(fresh.requestJson).instruments).toEqual(JSON.parse(old.requestJson).instruments);
        expect(JSON.parse(fresh.manifestJson).retryOf).toBe(initial.runId);
        expect(old.status).toBe("failed");
        const {researchBacklog}=await import("@/lib/desk/research-backlog");
        await db.deskRecord.create({data:{bookId:book.id,key:`proposal:${book.version}:live:late-linked`,kind:"trade_proposal",role:"lead",dataJson:JSON.stringify({key:"late-linked",revision:1,status:"parked",thesis:"Research was submitted before proposal creation",legs:[],missingEvidence:[],researchPlan:[{evidenceIds:[initial.runId]}],updatedAt:new Date().toISOString(),validUntil:new Date(Date.now()+3600000).toISOString()})}});
        expect((await researchBacklog(db,book))[0].attempts.map(r=>r.runId).sort()).toEqual([initial.runId,retried.runId].sort());
        await publishResearchHealth(db,{status:"ready",sourceHashes:{fixture:"repaired"}});
        await publishResearchHealth(db,{status:"ready",sourceHashes:{fixture:"repaired"}});
        expect(await db.deskWake.count({where:{bookId:book.id,kind:"research_runtime_ready",mode:"research"}})).toBe(0);
        await db.deskResearchRun.update({where:{id:retried.runId},data:{status:"failed",error:"Research source changed since submission"}});
        const secondRetry=await retryFailedResearch(db,book,retried.runId);
        await db.deskResearchRun.update({where:{id:secondRetry.runId},data:{status:"completed"}});
        expect(await retryFailedResearch(db,book,initial.runId)).toMatchObject({status:"completed",runId:secondRetry.runId,reused:true});
        await publishResearchHealth(db,{status:"ready",sourceHashes:{fixture:"new-prompt"}});
        expect(await db.deskWake.count({where:{bookId:book.id,kind:"research_runtime_ready"}})).toBe(0);
        // An exact fresh submission can recover a failure without a retryOf link.
        fixture.metadataDown=false;
        const sibling=await enqueueResearch(db,book,researchInput());
        await db.deskResearchRun.update({where:{id:sibling.runId},data:{status:"failed",error:"Research source changed since submission"}});
        const siblingRecovery=await enqueueResearch(db,book,researchInput());
        await db.deskResearchRun.update({where:{id:siblingRecovery.runId},data:{status:"completed"}});
        await publishResearchHealth(db,{status:"ready",sourceHashes:{fixture:"exact-resubmission-recovered"}});
        expect(await db.deskWake.count({where:{bookId:book.id,kind:"research_runtime_ready"}})).toBe(0);
        // A genuinely unrecovered new failure still gets one repair notification.
        const unrecovered=await enqueueResearch(db,book,researchInput());
        await db.deskResearchRun.update({where:{id:unrecovered.runId},data:{status:"failed",error:"Transform failed: Unexpected NUL byte"}});
        await publishResearchHealth(db,{status:"ready",sourceHashes:{fixture:"next-repair"}});
        await publishResearchHealth(db,{status:"ready",sourceHashes:{fixture:"next-repair"}});
        expect(await db.deskWake.count({where:{bookId:book.id,kind:"research_runtime_ready"}})).toBe(1);
        expect(await db.deskWake.count({where:{bookId:paper.id,kind:"research_runtime_ready"}})).toBe(0);
        expect(await db.deskIntent.count()).toBe(0);
        expect((await db.deskBook.findUniqueOrThrow({where:{id:paper.id}})).enabled).toBe(false);
    });
    it("cancels queued work without executing it",async()=>{
        const {enqueueResearch,cancelResearch}=await import("@/lib/desk/backtest/jobs");
        const {DeskResearchWorker}=await import("@/services/DeskResearchWorker");
        const book=await newBook(),run=await enqueueResearch(db,book,researchInput());
        await cancelResearch(db,book.id,run.runId);
        const execute=vi.fn();expect(await new DeskResearchWorker(db,execute).tick(new AbortController().signal)).toBe(false);
        expect(execute).not.toHaveBeenCalled();
    });
    it("marks expired leases failed rather than leaving an eternal running job",async()=>{
        const {enqueueResearch}=await import("@/lib/desk/backtest/jobs");
        const {DeskResearchWorker}=await import("@/services/DeskResearchWorker");
        const book=await newBook(),run=await enqueueResearch(db,book,researchInput());
        await db.deskResearchRun.update({where:{id:run.runId},data:{status:"running",lease:"expired",leaseUntil:new Date(0)}});
        await new DeskResearchWorker(db,vi.fn()).tick(new AbortController().signal);
        expect(await db.deskResearchRun.findUnique({where:{id:run.runId}})).toMatchObject({status:"failed",lease:null});
        expect(await db.deskWake.findFirst({where:{key:"research:"+run.runId}})).toMatchObject({mode:"research",kind:"research_failed"});
    });
    it("records subprocess failures with a finite terminal state",async()=>{
        const {enqueueResearch}=await import("@/lib/desk/backtest/jobs");
        const {DeskResearchWorker}=await import("@/services/DeskResearchWorker");
        const book=await newBook(),run=await enqueueResearch(db,book,researchInput());
        await new DeskResearchWorker(db,async()=>{throw new Error("Research exceeded budget");}).tick(new AbortController().signal);
        expect(await db.deskResearchRun.findUnique({where:{id:run.runId}})).toMatchObject({status:"failed",error:"Research exceeded budget",lease:null});
        expect(await db.deskWake.findFirst({where:{key:"research:"+run.runId}})).toMatchObject({mode:"research",kind:"research_failed"});
    });
    it("cancels a running process and wakes a read-only review",async()=>{
        const {enqueueResearch,cancelResearch}=await import("@/lib/desk/backtest/jobs");
        const {DeskResearchWorker}=await import("@/services/DeskResearchWorker");
        const book=await newBook(),run=await enqueueResearch(db,book,researchInput());
        let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
        const worker=new DeskResearchWorker(db,async(_input,signal)=>{
            started();return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("Research cancelled.")),{once:true}));
        });
        const running=worker.tick(new AbortController().signal);
        await ready;await cancelResearch(db,book.id,run.runId);await running;
        expect(await db.deskResearchRun.findUnique({where:{id:run.runId}})).toMatchObject({status:"cancelled",lease:null});
        expect(await db.deskWake.findFirst({where:{key:"research:"+run.runId}})).toMatchObject({mode:"research",kind:"research_cancelled"});
    });
    it("blocks manual entries while a desk owns the account",async()=>{
        const {withManualExecution}=await import("@/lib/desk/execution-lease");
        const book=await newBook(),send=vi.fn();
        await db.deskBook.update({where:{id:book.id},data:{enabled:true}});
        await expect(withManualExecution(db,owner,false,false,send)).rejects.toThrow(/managed by the desk/);
        expect(send).not.toHaveBeenCalled();
    });
    it("serializes manual and autonomous operations using the same lease",async()=>{
        const {withAccountExecutionLease,withManualExecution}=await import("@/lib/desk/execution-lease");
        await withAccountExecutionLease(db,owner,false,async()=>{
            await expect(withManualExecution(db,owner,false,true,vi.fn())).rejects.toThrow(/busy/);
        });
    });
    it("pauses desk authority for emergency reductions without touching the other network",async()=>{
        const {withManualExecution}=await import("@/lib/desk/execution-lease");
        const book=await newBook();await db.deskBook.update({where:{id:book.id},data:{enabled:true}});
        const paper=await db.deskBook.create({data:{ownerAddress:owner,accountAddress:owner,isTestnet:true,kind:"directional",enabled:true,mandateJson:book.mandateJson}});
        const sent=vi.fn(async(check:()=>Promise<void>)=>{await check();return "reduced";});
        const result=await withManualExecution(db,owner,false,true,sent);
        expect(result).toEqual({value:"reduced",deskPaused:true});
        expect(await db.deskBook.findUnique({where:{id:book.id}})).toMatchObject({enabled:false,version:book.version+1});
        expect(await db.deskBook.findUnique({where:{id:paper.id}})).toMatchObject({enabled:true});
    });
});


describe("persistent desk work ledger",()=>{
    async function session(mode="live") {
        const book=await newBook();await queueWake(db,book,randomUUID(),"operator",mode as "live"|"research",{});
        const shift=(await claimShift(book))!;
        const context={role:"lead" as const,shiftId:shift.id,callId:randomUUID(),signal:new AbortController().signal};
        const {workLedgerTools}=await import("@/lib/desk/work-ledger");
        return {book,shift,context,call:async(name:string,args:Record<string,unknown>,role="lead")=>workLedgerTools(db,book,shift).find(t=>t.name===name)!.run(args,{...context,callId:randomUUID(),role:role as any})};
    }
    it("coalesces paraphrased price alerts, retains subjects and preserves distinct thresholds",async()=>{
        const {requestWatch}=await import("@/lib/desk/routine-work"),{book,shift}=await session();
        const input={kind:"above",instrumentId:sol,side:"buy",threshold:100,thesis:"Reclaim price",deadline:new Date(Date.now()+3600000)};
        const a=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",input));
        const b=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",{...input,thesis:"Reworded same reclaim"}));
        const c=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",{...input,threshold:101}));
        expect(a.watchId).toBe(b.watchId);expect(c.watchId).not.toBe(a.watchId);
        const row=await db.deskWatch.findUniqueOrThrow({where:{id:a.watchId!}});
        expect(JSON.parse(row.outcomeJson!).ledger.subjects).toHaveLength(2);
        expect(await db.deskWatch.count({where:{bookId:book.id}})).toBe(2);
    });
    it("groups same-time review obligations without losing subjects and delivers them after downtime",async()=>{
        const {requestWatch}=await import("@/lib/desk/routine-work"),{book,shift}=await session();
        const due=new Date(Date.now()+60000);
        const a=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",{kind:"review",thesis:"Check CPI release",eventKey:"cpi",deadline:due}));
        const b=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",{kind:"review",thesis:"Check distinct protocol announcement",eventKey:"protocol",deadline:due}));
        expect(a.watchId).toBe(b.watchId);
        await db.deskWatch.update({where:{id:a.watchId!},data:{deadline:new Date(Date.now()-86400000)}});
        await processWatches(book);await processWatches(book);
        const wakes=await db.deskWake.findMany({where:{bookId:book.id,kind:"watch"}});
        expect(wakes).toHaveLength(1);expect(wakes[0].expiresAt).toBeNull();
        expect(JSON.parse(wakes[0].payload).subjects.map((s:any)=>s.eventKey)).toEqual(["cpi","protocol"]);
        expect(JSON.parse(wakes[0].payload).overdueMs).toBeGreaterThan(3600000);
        expect(await db.deskIntent.count({where:{bookId:book.id}})).toBe(0);
    });
    it("paginates every obligation including expired drafts beyond former briefing limits",async()=>{
        const {deskWorkSnapshot,workPage,workBrief}=await import("@/lib/desk/work-ledger"),{book}=await session();
        for(let i=0;i<41;i++)await db.deskRecord.create({data:{bookId:book.id,key:`proposal:${book.version}:live:idea-${i}`,kind:"trade_proposal",role:"lead",dataJson:JSON.stringify({...proposalDraft(),key:`idea-${i}`,status:"parked",revision:1,updatedAt:new Date().toISOString(),validUntil:new Date(Date.now()-3600000).toISOString()})}});
        for(let i=0;i<35;i++)await db.deskWatch.create({data:{bookId:book.id,key:`routine:lead:${book.version}:research:${i}`,mode:"research",kind:"above",instrumentId:sol,side:"buy",threshold:100+i,thesis:"Distinct price obligation",deadline:new Date(Date.now()+3600000)}});
        const snapshot=await deskWorkSnapshot(db,book),seen=new Set<string>();let cursor:string|null=null;
        do{const page=workPage(snapshot,{limit:7,...(cursor?{cursor}:{})});for(const i of page.items)seen.add(i.id);cursor=page.nextCursor;}while(cursor);
        expect(seen.size).toBe(76);expect(snapshot.items.filter(i=>i.issues.includes("expired_entry"))).toHaveLength(41);
        const brief=await workBrief(db,book,"live");expect(brief.total).toBe(41);expect(brief.items).toHaveLength(12);expect(brief.items.every(i=>i.mode==="live")).toBe(true);
        const researchBrief=await workBrief(db,book,"research");
        expect(researchBrief.total).toBe(0);expect(researchBrief.items).toEqual([]);
        expect(researchBrief.bookCounts.waiting).toBe(35);
        expect(workPage(snapshot,{mode:"research",state:"waiting",limit:50}).items).toHaveLength(35);
        const page=workPage(snapshot,{limit:7});snapshot.items[0].fingerprint="changed";
        expect(()=>workPage(snapshot,{cursor:page.nextCursor})).toThrow(/changed/);
        expect(fixture.quote).not.toHaveBeenCalled();expect(fixture.exposure).toHaveBeenCalledTimes(1); // claimShift only
    });
    it("allows explicit amendments and cancellation, fences stale revisions and research-to-live access",async()=>{
        const {requestWatch}=await import("@/lib/desk/routine-work"),{watchView}=await import("@/lib/desk/watch-state");
        const {book,shift,call}=await session("research");
        const receipt=await db.$transaction(tx=>requestWatch(tx,book,shift,"derivatives",{kind:"above",instrumentId:sol,side:"buy",threshold:100,thesis:"Watch price",deadline:new Date(Date.now()+3600000)}));
        const row=await db.deskWatch.findUniqueOrThrow({where:{id:receipt.watchId!}}),args={watchId:row.id,revision:watchView(row).revision,action:"update",threshold:101,reason:"Observed pivot changed; update the exact condition."};
        await expect(call("manage_watch",args,"risk")).rejects.toThrow(/owner/);
        const updated=await call("manage_watch",args,"derivatives") as any;expect(updated.threshold).toBe(101);
        await expect(call("manage_watch",args,"derivatives")).rejects.toThrow(/changed/);
        const live=await db.deskWatch.create({data:{bookId:book.id,key:`routine:lead:${book.version}:live:one`,mode:"live",kind:"above",instrumentId:sol,threshold:105,thesis:"Live condition",deadline:new Date(Date.now()+3600000)}});
        await expect(call("manage_watch",{...args,watchId:live.id,revision:watchView(live).revision})).rejects.toThrow(/missing/);
        expect((await call("manage_watch",{watchId:row.id,revision:updated.revision,action:"cancel",reason:"Thesis resolved; retire the monitor with its history."}) as any).status).toBe("cancelled");
        const retired=await db.deskWatch.findUniqueOrThrow({where:{id:row.id}});
        const cancel={watchId:row.id,revision:updated.revision,action:"cancel",reason:"Thesis resolved; retire the monitor with its history."};
        expect(await call("manage_watch",cancel)).toMatchObject({status:"cancelled",recorded:false,alreadyRetired:true});
        expect(await db.deskWatch.findUniqueOrThrow({where:{id:row.id}})).toEqual(retired);
        await expect(call("manage_watch",cancel,"risk")).rejects.toThrow(/owner/);
    });
    it("keeps pass outcomes observational when their reopening is cancelled",async()=>{
        const {requestWatch}=await import("@/lib/desk/routine-work"),{watchView}=await import("@/lib/desk/watch-state"),{book,shift,call}=await session();
        const receipt=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",{kind:"pass",instrumentId:sol,side:"buy",thesis:"Measured liquidity blocker",deadline:new Date(Date.now()+3600000),referencePrice:100,outcomeJson:JSON.stringify({revisitWhen:"both_depth",referenceAt:new Date().toISOString()})}));
        const before=await db.deskWatch.findUniqueOrThrow({where:{id:receipt.watchId!}});
        const after=await call("manage_watch",{watchId:before.id,revision:watchView(before).revision,action:"cancel",reason:"Reopening thesis invalidated; preserve the original outcome observation."}) as any;
        expect(after).toMatchObject({status:"open",observational:true,monitoringDisabled:true});
        expect((await db.deskWatch.findUniqueOrThrow({where:{id:before.id}})).referencePrice).toBe(100);
    });
    it("persists assigned tasks with durable deadlines and forbids waiting without a next trigger",async()=>{
        const {book,call}=await session();
        const args={key:"verify-event",expectedRevision:0,owner:"catalyst",status:"waiting",title:"Verify source announcement",nextAction:"Check the dated official release and report exact changes.",reason:"Pending official release needs a durable owner and deadline.",evidenceIds:[],watchIds:[],reviewAt:null};
        await expect(call("save_desk_task",args)).rejects.toThrow(/watch or review/);
        const result=await call("save_desk_task",{...args,reviewAt:new Date(Date.now()+3600000).toISOString()}) as any;
        expect(result.revision).toBe(1);expect(result.reminder.watchId).toBeTruthy();
        await expect(call("save_desk_task",{...args,reviewAt:new Date(Date.now()+3600000).toISOString()})).rejects.toThrow(/revision/);
        const page=await call("read_desk_work",{ids:[result.itemId],state:"all"}) as any;
        expect(page.items[0]).toMatchObject({owner:"catalyst",state:"waiting"});
        expect(await db.deskRecord.count({where:{bookId:book.id,kind:"desk_task_revision"}})).toBe(1);
    });
    it("returns an actionable missing-proposal receipt and keeps closed passes observation-only",async()=>{
        const {requestWatch}=await import("@/lib/desk/routine-work"),{book,shift}=await session();
        const draft=proposalDraft(),input={kind:"pass",instrumentId:sol,side:"buy",thesis:"Observe rejected idea",proposalKey:draft.key,
            deadline:new Date(Date.now()+3600000),outcomeJson:JSON.stringify({revisitWhen:"both_depth"})};
        expect(await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",input))).toMatchObject({watchId:null,status:"not_scheduled",purpose:"proposal_required"});
        expect(await db.deskWatch.count()).toBe(0);
        const p=await saveTradeProposal(db,book,shift,"lead",draft,new AbortController().signal);
        await saveTradeProposal(db,book,shift,"lead",{...draft,expectedRevision:p.revision,status:"closed"},new AbortController().signal);
        const observed=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",input));
        expect(observed).toMatchObject({followUpEligible:false,purpose:"outcome_observation_only"});
        expect(await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",{...input,kind:"above",threshold:100}))).toMatchObject({watchId:null,status:"not_scheduled",purpose:"closed_proposal"});
    });
    it("retire linked entry alerts atomically with closure, preserving explicitly distinct reassessments",async()=>{
        const {requestWatch}=await import("@/lib/desk/routine-work"),{book,shift}=await session();
        const draft=proposalDraft(),p=await saveTradeProposal(db,book,shift,"lead",draft,new AbortController().signal);
        const input={kind:"above",instrumentId:sol,side:"buy",threshold:100,thesis:"Original entry condition",proposalKey:p.key,deadline:new Date(Date.now()+3600000)};
        const a=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",input));
        const b=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",{...input,threshold:110,keepAfterClosure:true,thesis:"Distinct future reassessment; no old entry authority"}));
        await saveTradeProposal(db,book,shift,"lead",{...draft,expectedRevision:p.revision,status:"closed"},new AbortController().signal);
        expect((await db.deskWatch.findUniqueOrThrow({where:{id:a.watchId!}})).status).toBe("cancelled");
        expect((await db.deskWatch.findUniqueOrThrow({where:{id:b.watchId!}})).status).toBe("open");
        expect((await db.deskBook.findUniqueOrThrow({where:{id:book.id}})).mandateJson).toBe(book.mandateJson);
    });
    it("repairs legacy duplicates idempotently while preserving every subject and original pass price",async()=>{
        const {reconcileDeskWatches}=await import("@/lib/desk/watch-recovery"),{book}=await session();const due=new Date(Date.now()+3600000);
        for(const [i,kind] of ["above","above","review","review","pass","pass"].entries())await db.deskWatch.create({data:{bookId:book.id,key:`routine:lead:${book.version}:live:legacy-${i}`,mode:"live",kind,instrumentId:kind==="review"?null:sol,side:kind==="review"?null:"buy",threshold:kind==="above"?100:null,thesis:`Distinct wording ${i}`,deadline:due,referencePrice:kind==="pass"?100+i:null,outcomeJson:kind==="pass"?'{"revisitWhen":"both_depth"}':null}});
        const dry=await reconcileDeskWatches(db,book);expect(dry.changes).toHaveLength(3);
        await reconcileDeskWatches(db,book,false);expect((await reconcileDeskWatches(db,book,false)).changes).toHaveLength(0);
        const rows=await db.deskWatch.findMany({where:{bookId:book.id}});expect(rows).toHaveLength(6);
        expect(rows.filter(w=>w.kind==="pass").map(w=>w.referencePrice).sort()).toEqual([104,105]);
        expect(rows.filter(w=>w.status==="superseded")).toHaveLength(2);
        expect(rows.filter(w=>w.status==="open"&&JSON.parse(w.outcomeJson??"{}").ledger?.subjects.length===2)).toHaveLength(3);
    });
    it("evaluates price conditions beyond 250 earlier observational records",async()=>{
        const {book}=await session();const due=new Date(Date.now()+3600000);
        for(let i=0;i<251;i++)await db.deskWatch.create({data:{bookId:book.id,key:`observation-${i}`,mode:"research",kind:"pass",thesis:"Historical outcome only",deadline:due}});
        const late=await db.deskWatch.create({data:{bookId:book.id,key:`routine:lead:${book.version}:live:last`,mode:"live",kind:"above",instrumentId:sol,threshold:100,thesis:"A real price alert beyond the old cap",deadline:new Date(+due+10000)}});
        fixture.mids.mockResolvedValue([{instrumentId:sol,mid:101}]);await processWatches(book);
        expect((await db.deskWatch.findUniqueOrThrow({where:{id:late.id}})).status).toBe("triggered");
        expect(await db.deskWake.count({where:{bookId:book.id,key:`watch:${late.id}`}})).toBe(1);
    });
    it("keeps lost callbacks visible until explicit resolution and includes grouped subjects in routine briefings",async()=>{
        const {deskWorkSnapshot}=await import("@/lib/desk/work-ledger"),{routineOpening}=await import("@/lib/desk/routine-work"),{book}=await session();
        const w=await db.deskWatch.create({data:{bookId:book.id,key:`routine:lead:${book.version}:live:lost`,mode:"live",kind:"review",thesis:"Missed external deadline",status:"elapsed",deadline:new Date(Date.now()-86400000)}});
        const snapshot=await deskWorkSnapshot(db,book);expect(snapshot.items.find(i=>i.id===`watch:${w.id}`)).toMatchObject({state:"attention",issues:["missed_callback"]});
        const view=routineOpening({triggers:[{kind:"watch",payload:{role:"lead",subjects:[{id:"one"},{id:"two"}]}}],workLedger:{total:76},watches:[{owner:"lead",id:w.id}]},"lead") as any;
        expect(view.workLedger.total).toBe(76);expect(view.triggers[0].payload.subjects).toHaveLength(2);expect(view.watches[0].id).toBe(w.id);
    });
    it("resolves a completed task inside a shared review and withdraws the last obsolete callback",async()=>{
        const {book,call}=await session(),due=new Date(Date.now()+3600000).toISOString();
        const args={key:"first-task",expectedRevision:0,owner:"lead",status:"waiting",title:"First durable review topic",nextAction:"Inspect the specific official announcement.",reason:"A genuine external release is due at the review time.",evidenceIds:[],watchIds:[],reviewAt:due};
        const first=await call("save_desk_task",args) as any;
        const second=await call("save_desk_task",{...args,key:"second-task",title:"Second distinct review topic"}) as any;
        expect(first.reminder.watchId).toBe(second.reminder.watchId);
        await call("save_desk_task",{...args,expectedRevision:1,status:"completed",reviewAt:null,reason:"Official source already resolved the first obligation."});
        let w=await db.deskWatch.findUniqueOrThrow({where:{id:first.reminder.watchId}});
        expect(w.status).toBe("open");expect(JSON.parse(w.outcomeJson!).ledger.subjects.filter((s:any)=>!s.resolvedAt).map((s:any)=>s.id)).toEqual([second.itemId]);
        await db.deskWatch.update({where:{id:w.id},data:{deadline:new Date(Date.now()-1000)}});
        await processWatches(book);
        const wake=await db.deskWake.findUniqueOrThrow({where:{bookId_key:{bookId:book.id,key:`watch:${w.id}`}}});
        expect(JSON.parse(wake.payload).subjects.map((s:any)=>s.id)).toEqual([second.itemId]);
        await call("save_desk_task",{...args,key:"second-task",expectedRevision:1,status:"completed",reviewAt:null,reason:"The second official source has now resolved its obligation."});
        w=await db.deskWatch.findUniqueOrThrow({where:{id:w.id}});expect(w.status).toBe("cancelled");
        expect((await db.deskWake.findUniqueOrThrow({where:{id:wake.id}})).expiresAt?.getTime()).toBe(0);
        const page=await call("read_desk_work",{ids:[first.itemId]}) as any;expect(page.items[0].state).toBe("closed");
    });
    it("amending only a price-watch deadline invalidates stale revision and collision requires explicit supersession",async()=>{
        const {requestWatch}=await import("@/lib/desk/routine-work"),{book,shift,call}=await session();
        const input={kind:"above",instrumentId:sol,side:"buy",threshold:100,thesis:"Original setup monitor",deadline:new Date(Date.now()+3600000)};
        const a=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",input));
        const b=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",{...input,threshold:101,thesis:"Distinct revised setup monitor"}));
        const updated=await call("manage_watch",{watchId:a.watchId,revision:a.revision,action:"update",deadline:new Date(Date.now()+7200000).toISOString(),reason:"Changed event timing requires a later review horizon."}) as any;
        expect(updated.revision).not.toBe(a.revision);
        const renamed=await call("manage_watch",{watchId:a.watchId,revision:updated.revision,action:"update",thesis:"Amended assessment for the same price",reason:"Changed evidence requires a clarified description."}) as any;
        expect(renamed.revision).not.toBe(updated.revision);updated.revision=renamed.revision;
        await expect(call("manage_watch",{watchId:a.watchId,revision:updated.revision,action:"update",threshold:101,reason:"Price moved to the already observed second condition."})).rejects.toThrow(/already monitored/);
        await call("manage_watch",{watchId:a.watchId,revision:updated.revision,action:"supersede",replacementWatchId:b.watchId,reason:"Both topics now belong to the updated price condition."});
        expect(JSON.parse((await db.deskWatch.findUniqueOrThrow({where:{id:b.watchId!}})).outcomeJson!).ledger.subjects).toHaveLength(2);
    });
    it("recovery never drops unclaimed non-expiring callback obligations",async()=>{
        const {reconcileDeskWatches}=await import("@/lib/desk/watch-recovery"),{book}=await session();
        const due=new Date(Date.now()+3600000),rows=[];
        for(let i=0;i<2;i++)rows.push(await db.deskWatch.create({data:{bookId:book.id,key:`routine:lead:${book.version}:live:pending-${i}`,mode:"live",kind:"review",thesis:`Review subject ${i}`,deadline:due}}));
        await queueWake(db,book,`watch:${rows[1].id}`,"watch","live",{watchId:rows[1].id},6,new Date(),null);
        const result=await reconcileDeskWatches(db,book,false);expect(result.changes[0]).toHaveProperty("skipped");
        expect(await db.deskWatch.count({where:{bookId:book.id,status:"open"}})).toBe(2);
    });
    it("retains superseded-version reminders as inspectable history rather than current callbacks",async()=>{
        const {deskWorkSnapshot,workPage}=await import("@/lib/desk/work-ledger"),{book}=await session();
        const old=await db.deskWatch.create({data:{bookId:book.id,key:`routine:lead:${book.version-1}:live:old`,mode:"live",kind:"review",status:"elapsed",thesis:"Obsolete book reminder",deadline:new Date(0)}});
        const snapshot=await deskWorkSnapshot(db,book),row=snapshot.items.find(i=>i.id===`watch:${old.id}`)!;
        expect(row.state).toBe("closed");expect(row.nextAction).toMatch(/superseded book version/);
        expect(workPage(snapshot,{ids:[row.id]}).items).toHaveLength(1);
        const future=await db.deskWatch.create({data:{bookId:book.id,key:`routine:lead:${book.version-1}:live:future`,mode:"live",kind:"review",thesis:"Future event still deserves reassessment",deadline:new Date(Date.now()+86400000)}});
        expect((await deskWorkSnapshot(db,book)).items.find(i=>i.id===`watch:${future.id}`)?.state).toBe("waiting");
    });

    it("returns actionable review state without pretending to close a source or overwriting revisions",async()=>{
        const {book,shift,call}=await session();const draft=proposalDraft();
        const p=await saveTradeProposal(db,book,shift,"lead",draft,new AbortController().signal);
        const page=await call("read_desk_work",{ids:[`proposal:${book.version}:live:${p.key}`]}) as any;
        const item=page.items[0],args={itemId:item.id,fingerprint:item.fingerprint,decision:"Review the existing unresolved proposal without new evidence.",nextAction:"Close the expired source if its thesis is exhausted.",evidenceIds:[],watchIds:[],reviewAt:null};
        const result=await call("review_desk_work",args) as any;
        expect(result).toMatchObject({status:"source_action_required",recorded:false});
        expect(await db.deskRecord.count({where:{bookId:book.id,kind:"work_review"}})).toBe(0);
        await saveTradeProposal(db,book,shift,"lead",{...draft,expectedRevision:p.revision,status:"closed"},new AbortController().signal);
        expect(await call("review_desk_work",args)).toMatchObject({status:"already_resolved",recorded:false});
        expect(await db.deskRecord.count({where:{bookId:book.id,kind:"work_review"}})).toBe(0);
    });
    it("labels observational receipts so they cannot masquerade as follow-up monitors",async()=>{
        const {requestWatch}=await import("@/lib/desk/routine-work"),{book,shift}=await session();
        const base={instrumentId:sol,side:"buy",thesis:"Observe a passed idea",deadline:new Date(Date.now()+3600000)};
        const observation=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",{...base,kind:"pass"}));
        const monitor=await db.$transaction(tx=>requestWatch(tx,book,shift,"lead",{...base,kind:"above",threshold:100}));
        expect(observation).toMatchObject({followUpEligible:false,purpose:"outcome_observation_only"});
        expect(monitor).toMatchObject({followUpEligible:true,purpose:"condition_review"});
    });

});
