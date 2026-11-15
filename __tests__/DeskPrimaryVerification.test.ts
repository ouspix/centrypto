// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { publicObservation, publicResearchTools, verifiedPrimarySource, type PublicCache, type PublicCacheEntry } from "@/lib/desk/research";
import { ShiftObservationBoard } from "@/lib/desk/read-cache";
import type { DeskTurn, ToolContext } from "@/lib/desk/runtime";

const topic = { id: "mainnet:perp:AVAX", label: "AVAX" };
const url = "https://www.avalanche.com/about/blog/announcement";
const ctx: ToolContext = { role: "catalyst", shiftId: "shift", callId: "call", signal: new AbortController().signal };
const source = { url, title: "Planned settlement ledger", finding: "Announced selection; approval and launch remain pending.",
    publishedAt: "2026-11-09T13:00:00Z", sourceRole: "primary", subjectMatch: "matched", identityBasis: "Avalanche native token" };
function fixture() {
    let now = Date.parse("2026-11-09T13:18:00Z"), revision = 1;
    const entries = new Map<string, PublicCacheEntry>();
    const cache: PublicCache = { revision: async () => revision, get: async k => entries.get(k) ?? null,
        put: async rows => { for (const row of rows) entries.set(row.key, row); } };
    const board = new ShiftObservationBoard(() => now);
    const transport = vi.fn(async (_turn: DeskTurn, seen: (item: Record<string, unknown>) => void) => {
        seen({ action: { type: "openPage", url } });
        return JSON.stringify({ sources: [source] });
    });
    const tools = () => publicResearchTools({ topics: async () => [topic], cache, transport, now: () => now,
        observed: (t, op, result, expiry) => board.publish(op, Date.parse(expiry), publicObservation(t, op, result, expiry)) });
    const run = async (name: string, args: Record<string, unknown>) => tools().find(t => t.name === name)!.run(args, ctx);
    return { run, transport, board, cache, now: () => now, advance: (ms: number) => { now += ms; }, correct: () => { revision++; } };
}
type Result = { retrievedAt: string; status?: string; sources: Array<typeof source & { evidenceId: string }>;
    readVerification?: { status: string; priorObservation?: { retrievedAt: string; source: typeof source }; nextStep: string } };
const search = async (f: ReturnType<typeof fixture>, angle = "official announcement") =>
    await f.run("search_public_sources", { topicId: topic.id, angle }) as Result;
const read = async (f: ReturnType<typeof fixture>, evidenceId: string) =>
    await f.run("read_public_source", { evidenceId }) as Result;

describe("primary-source verification recovery", () => {
    it("admits only a current successful exact primary read to the host strategy consumer", async () => {
        const f = fixture(), found = await search(f), id = found.sources[0].evidenceId;
        expect(await verifiedPrimarySource(f.cache, topic, id, f.now())).toBeNull();
        await read(f, id);
        expect(await verifiedPrimarySource(f.cache, topic, id, f.now())).toMatchObject({ source: { url, sourceRole: "primary" } });
        expect(await verifiedPrimarySource(f.cache, { ...topic, id: "mainnet:perp:SOL" }, id, f.now())).toBeNull();
        f.advance(5 * 60_000);
        expect(await verifiedPrimarySource(f.cache, topic, id, f.now())).toBeNull();
        await search(f);
        f.transport.mockResolvedValueOnce('{"sources":[]}');
        await read(f, id);
        expect(await verifiedPrimarySource(f.cache, topic, id, f.now())).toBeNull();
        f.correct();
        expect(await verifiedPrimarySource(f.cache, topic, id, f.now())).toBeNull();
    });

    it("preserves the dated announcement across failed reads and restarts without claiming fresh confirmation", async () => {
        const f = fixture();
        const found = await search(f);
        f.advance(30_000);
        f.transport.mockImplementationOnce(async turn => {
            expect(turn.input).toContain(found.retrievedAt);
            expect(turn.input).toContain(source.finding);
            expect(turn.input).toContain("exact-source verification");
            return '{"sources":[]}';
        });
        const failed = await read(f, found.sources[0].evidenceId);
        expect(failed.status).toBe("source_read_unavailable");
        expect(failed.sources).toEqual([]);
        expect(failed.readVerification).toMatchObject({ status: "read_unavailable",
            priorObservation: { retrievedAt: found.retrievedAt, source: { url, sourceRole: "primary", finding: source.finding } } });
        expect(failed.readVerification?.nextStep).toContain("primary confirmation and counterparty statements");
        expect((await read(f, found.sources[0].evidenceId)).readVerification).toEqual(failed.readVerification);
        expect(f.transport).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(await f.board.recent())).toContain('"status":"read_unavailable"');
        // The alternate recovery angle must not hit the cached original announcement search.
        await search(f, "primary confirmation and counterparty statements");
        await search(f, "primary confirmation and counterparty statements");
        expect(f.transport).toHaveBeenCalledTimes(3);
        f.advance(5 * 60_000);
        const recovered = await read(f, found.sources[0].evidenceId);
        expect(recovered.readVerification?.status).toBe("source_read");
        expect(recovered.readVerification?.priorObservation).toBeUndefined();
        expect(recovered.sources[0].finding).toBe(source.finding);
    });

    it("does not replace an inaccessible primary page with an unrelated or unobserved URL", async () => {
        const f = fixture();
        const found = await search(f);
        f.transport.mockImplementationOnce(async (_turn, seen) => {
            const other = "https://reporter.example/tokenomics";
            seen({ url: other });
            return JSON.stringify({ sources: [source, { ...source, url: other }] });
        });
        const failed = await read(f, found.sources[0].evidenceId);
        expect(failed.sources).toEqual([]);
        expect(failed.readVerification?.status).toBe("read_unavailable");
    });

    it("rejects superseded and expired receipts instead of falling back to old confirmation", async () => {
        const f = fixture();
        const found = await search(f);
        f.correct();
        await expect(read(f, found.sources[0].evidenceId)).rejects.toThrow(/superseded/);
        expect(f.transport).toHaveBeenCalledTimes(1);
        f.advance(61 * 60_000);
        await expect(read(f, found.sources[0].evidenceId)).rejects.toThrow(/receipt/);
    });

    it("keeps a primary announcement ahead of background links in the bounded shared observation", async () => {
        const sources = [0, 1, 2].map(i => ({ ...source, sourceRole: i === 2 ? "primary" as const : "secondary" as const,
            evidenceId: `web-${i}` }));
        const summary = publicObservation(topic, "search:official announcement", {
            retrievedAt: "2026-11-09T13:18:00Z", sources,
        }, "2026-11-09T14:18:00Z");
        expect(summary.sources).toHaveLength(2);
        expect(summary.sources[0].evidenceId).toBe("web-2");
        expect(summary.sources[0].sourceRole).toBe("primary");
    });
});
