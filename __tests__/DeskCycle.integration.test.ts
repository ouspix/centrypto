// @vitest-environment node
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
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
}));
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
import { ingestNews, processWatches, sampleMarket } from "@/lib/desk/triggers";
import { DEFAULT_DESK_MANDATE } from "@/lib/desk/mandate";
import { deskRoles, type RoleNote } from "@/lib/desk/roles";

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

let fixtureRoot: string;
beforeAll(async () => {
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
    fixture.quote.mockImplementation(async () => ({ bid: 99, ask: 101, time: Date.now() }));
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            throw new Error("Network disabled in fixture");
        }),
    );
    vi.stubEnv("NEWS_COLLECTOR_OWNER_ADDRESS", owner);
    directory = await mkdtemp(path.join(os.tmpdir(), "centrypto-desk-cycle-"));
    url = "file:" + path.join(directory, "fixture.db") + "?connection_limit=1";
    await copyFile(path.join(fixtureRoot, "seed.db"), path.join(directory, "fixture.db"));
    fixture.client = db = new PrismaClient({ datasources: { db: { url } } });
});
afterEach(async () => {
    await db?.$disconnect();
    fixture.client = null;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
});

describe("desk worker shift with local-only exchange and Codex fixtures", () => {
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
        expect(await db.deskWake.count()).toBe(0);
        await ingestNews(flat);
        const discovery = await claimShift(flat);
        expect(JSON.parse(discovery!.briefJson)).toMatchObject({ activeRoles: ["lead"], triggers: [{ kind: "discovery" }] });
        setupNews();
        await ingestNews(held);
        const urgent = await claimShift(held);
        expect(JSON.parse(urgent!.briefJson)).toMatchObject({ activeRoles: [...deskRoles], triggers: [{ kind: "risk" }] });
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
            await queueWake(db, book, key, "fill", "live", {});
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
        expect(fixture.model.mock.calls.map(([t]) => t.role).sort()).toEqual([...deskRoles].sort());
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
        fixture.quote.mockImplementation(async () => ({ bid: 102, ask: 104, time: Date.now() }));
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
            if (brief.mode === "research")
                expect(turn.tools.some((t) => t.access === "lead" || t.access === "execution")).toBe(false);
            if (turn.role === "catalyst") {
                const result = await tool(turn, "news_history", { eventKey });
                expect(result).toMatchObject([{ revisionId: 41, verified: true }]);
            }
            if (turn.role === "lead") {
                expect(brief.roundtable.risk.dissent).toBe("Do not increase exposure");
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
        expect(await db.deskRecord.count({ where: { bookId: held.id, kind: "note" } })).toBe(10);
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
        ["Exchange reconciliation unavailable", "Exchange reconciliation unavailable"],
    ])("clears recovered storage warnings without clearing other failures (%s)", async (lastError, expected) => {
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

    it("resumes the same shift after a failed lead turn and process restart without replaying specialists or losing their watches", async () => {
        const book = await newBook();
        await queueWake(db, book, "fixture-alert", "price_alert", "live", { instrumentId: sol, price: 100 });
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
                expect(Object.keys(b.roundtable).sort()).toEqual(deskRoles.filter((r) => r !== "lead").sort());
            }
            return JSON.stringify(note(turn.role));
        });
        const shift = await claimShift(book);
        await expect(runShift(book, shift!, new AbortController().signal)).rejects.toThrow(
            "simulated process termination",
        );
        await db.$disconnect();
        fixture.client = db = new PrismaClient({ datasources: { db: { url } } });
        const resumed = await claimShift(book, new Date(Date.now() + 20000));
        expect(resumed?.id).toBe(shift?.id);
        expect(resumed?.lease).not.toBe(shift?.lease);
        await runShift(book, resumed!, new AbortController().signal);
        expect(await db.deskRecord.count({ where: { shiftId: shift!.id, kind: "note" } })).toBe(5);
        expect(await db.deskWatch.count()).toBe(1);
        expect(await db.deskShift.findUniqueOrThrow({ where: { id: resumed!.id } })).toMatchObject({ status: "completed", error: null });
        expect(fixture.model.mock.calls.filter(([s]) => s.role === "catalyst")).toHaveLength(1);
        expect(fetch).not.toHaveBeenCalled();
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
