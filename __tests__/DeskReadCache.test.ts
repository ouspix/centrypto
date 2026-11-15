// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrismaClient, type DeskBook, type DeskShift } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { ShiftReads, ShiftObservationBoard } from "@/lib/desk/read-cache";
import { instrumentResearchTopic, publicResearchTools } from "@/lib/desk/research";
import { nativeInstruments } from "@/lib/desk/instruments";
import { bookPublicCache } from "@/lib/desk/public-cache";
import type { DeskTurn, ToolContext } from "@/lib/desk/runtime";
import type { DeskTool } from "@/lib/desk/roundtable";

describe("read observations", () => {
    it("coalesces pending reads, respects source expiry, and does not cache a failed refresh", async () => {
        let now = 1000;
        const reads = new ShiftReads(() => now);
        const fetch = vi.fn(async () => ({ sourceTime: now - 2, price: 100 }));
        const get = () => reads.read("l2:SOL", 10, fetch, (s) => s.sourceTime + 6);
        const [a, b] = await Promise.all([get(), get()]);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(a.expiresAt).toBe(1004);
        expect(b.reused).toBe(true);
        now = 1004;
        fetch.mockRejectedValueOnce(Error("offline"));
        await expect(get()).rejects.toThrow("offline");
        expect((await get()).reused).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(3);
        expect((await new ShiftReads(() => now).read("l2:SOL", 10, fetch)).reused).toBe(false);
    });
    it("shares only unexpired summaries within the prompt budget, dropping corrected stories", async () => {
        let now = 1000,
            revision = 1;
        const board = new ShiftObservationBoard(() => now);
        board.publish("quote", 1050, { bid: 42 });
        board.publish("story", 1150, { evidenceId: "host-issued" }, async () => revision === 1);
        expect(await board.recent()).toEqual([{ evidenceId: "host-issued" }, { bid: 42 }]);
        revision++;
        expect(await board.recent()).toEqual([{ bid: 42 }]);
        now += 50;
        expect(await board.recent()).toEqual([]);
        for (let i = 0; i < 20; i++) board.publish("data" + i, 2000, { fact: "測".repeat(350) });
        expect(Buffer.byteLength(JSON.stringify(await board.recent()))).toBeLessThan(2450);
    });
});

const topic = { id: "mainnet:perp:SOL", label: "SOL" },
    url = "https://issuer.example/status/one";
const ctx: ToolContext = { role: "risk", shiftId: "a", callId: "1", signal: new AbortController().signal };
let dir: string, db: PrismaClient;
beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "desk-source-cache-"));
    const url = "file:" + path.join(dir, "fixture.db");
    execFileSync(
        process.execPath,
        [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", "prisma/schema.prisma"],
        { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe", timeout: 30_000 },
    );
    db = new PrismaClient({ datasources: { db: { url } } });
}, 35000);
afterAll(async () => {
    await db?.$disconnect();
    if (dir) await rm(dir, { recursive: true, force: true });
});
const call = (tools: DeskTool[], name: string, args: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.run(args, ctx) as Promise<{
        retrievedAt: string;
        reused: boolean;
        sources: { url: string; evidenceId: string }[];
    }>;
async function newBook(name: string) {
    return db.deskBook.create({
        data: { ownerAddress: name, accountAddress: name, isTestnet: false, kind: "directional", mandateJson: "{}" },
    });
}
async function material(book: DeskBook, revisionId: number, eventKey: string, ids: string[]) {
    return db.deskWake.create({
        data: {
            bookId: book.id,
            version: 1,
            key: "news:" + revisionId,
            kind: "discovery",
            mode: "live",
            dueAt: new Date(),
            priority: 4,
            payload: JSON.stringify({ eventKey, revisionId, instrumentIds: ids, publicSubject: "anonymous" }),
        },
    });
}
it("persists only verified public receipts, reuses after restart, invalidates on a related correction, and isolates book, network, mandate and mode", async () => {
    let now = Date.now();
    const a = await newBook("owner-a"),
        b = await newBook("owner-b");
    const scopes = (book: DeskBook, mode = "live", version = 1) =>
        bookPublicCache(db, book, { bookId: book.id, mode, version } as DeskShift, () => now);
    const transport = vi.fn(async (_turn: DeskTurn, seen: (item: Record<string, unknown>) => void) => {
        seen({ action: { type: "openPage", url } });
        return JSON.stringify({
            sources: [
                { url, title: "Issuer", finding: "Governance proposal", publishedAt: null },
                { url: "https://unseen.example/fake", title: "Invented", finding: "bad", publishedAt: null },
            ],
        });
    });
    const tools = (book: DeskBook, mode = "live", version = 1) =>
        publicResearchTools({
            topics: async () => [topic],
            cache: scopes(book, mode, version),
            transport,
            now: () => now,
        });
    const query = (t: DeskTool[]) =>
        call(t, "search_public_sources", { topicId: topic.id, angle: "official announcement" });
    const read = (t: DeskTool[], evidenceId: string) => call(t, "read_public_source", { evidenceId });
    await material(a, 1, "supply:sol", [topic.id]);
    const t1 = tools(a);
    const [fresh, shared] = await Promise.all([query(t1), query(t1)]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(shared.reused || fresh.reused).toBe(true);
    expect(fresh.sources).toHaveLength(1);
    const id = fresh.sources[0].evidenceId;
    await read(t1, id);
    expect(transport).toHaveBeenCalledTimes(2);
    await material(a, 2, "unrelated", ["mainnet:perp:BTC"]);
    const restart = tools(a);
    expect((await query(restart)).retrievedAt).toBe(fresh.retrievedAt);
    expect((await read(tools(a), id)).reused).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
    for (const isolated of [tools(b), tools(a, "research"), tools({ ...a, isTestnet: true }), tools(a, "live", 2)]) {
        await expect(read(isolated, id)).rejects.toThrow(/receipt/);
    }
    await material(a, 3, "supply:sol", []); // retraction removed SOL from the new mapping
    await expect(read(restart, id)).rejects.toThrow(/superseded/);
    expect((await query(restart)).reused).toBe(false);
    expect((await read(restart, id)).reused).toBe(false);
    now += 61 * 60000;
    const expired = tools(a);
    await expect(read(expired, id)).rejects.toThrow(/receipt/);
    expect((await query(expired)).reused).toBe(false);
    expect(JSON.stringify(await db.deskPublicCache.findMany())).not.toContain("unseen.example");
});

it("keeps exact venue identity in searches and reads, rejects namesakes and caches an unresolved lookup across restarts", async () => {
    let now = Date.now();
    const book = await newBook("0x-private-identity-test-owner");
    const item = nativeInstruments(false, [], { tokens: [
        { index: 0, name: "USDC", szDecimals: 6, tokenId: "0xcash" },
        { index: 641, name: "MGW", szDecimals: 1, tokenId: "0x3da4372a3031c0f476d1a23dfe2deeee", evmContract: { address: "0xbridge" } },
    ], universe: [{ index: 497, name: "@497", tokens: [641, 0] }] })[0];
    let matched = false;
    const transport = vi.fn(async (turn: DeskTurn, seen: (item: Record<string, unknown>) => void) => {
        expect(turn.input).toContain("Hyperliquid mainnet");
        expect(turn.input).toContain(item.tokenId);
        expect(turn.input).toContain("0xbridge");
        expect(turn.input).toContain("@497");
        expect(turn.input).not.toContain(book.ownerAddress);
        seen({ url });
        return JSON.stringify({ sources: [{ url, title: matched ? "Token issuer" : "Football contract",
            finding: "Public claim", publishedAt: null, subjectMatch: matched ? "matched" : "unrelated",
            identityBasis: matched ? "Issuer identifies the supplied token ID on Hyperliquid" : "Ticker namesake only" }] });
    });
    const tools = () => publicResearchTools({ topics: async () => [instrumentResearchTopic(item)], transport,
        cache: bookPublicCache(db, book, { version: 1, mode: "live" } as DeskShift, () => now), now: () => now });
    const search = () => call(tools(), "search_public_sources", { topicId: item.id, angle: "official announcement" });
    expect((await search()).sources).toEqual([]);
    now += 20 * 60000;
    expect((await search()).reused).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    matched = true;
    await material(book, 10, "identity-confirmed", [item.id]);
    const resolved = await search();
    expect(resolved.reused).toBe(false);
    expect(resolved.sources).toHaveLength(1);
    await call(tools(), "read_public_source", { evidenceId: resolved.sources[0].evidenceId });
    expect(transport).toHaveBeenCalledTimes(3);
    now += 61 * 60000;
    await search();
    expect(transport).toHaveBeenCalledTimes(4);
});

it("does not cache transport failures and keeps urgent negative searches on a five minute expiry", async () => {
    let now = Date.now();
    const book = await newBook("negative-urgent");
    const transport = vi.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValue('{"sources":[]}');
    const tools = () => publicResearchTools({ topics: async () => [topic], transport,
        cache: bookPublicCache(db, book, { version: 1, mode: "live" } as DeskShift, () => now), now: () => now });
    const search = () => call(tools(), "search_public_sources", { topicId: topic.id, angle: "security and operational status" });
    await expect(search()).rejects.toThrow("offline");
    expect((await search()).reused).toBe(false);
    expect((await search()).reused).toBe(true);
    now += 5 * 60000;
    expect((await search()).reused).toBe(false);
    expect(transport).toHaveBeenCalledTimes(3);
});
