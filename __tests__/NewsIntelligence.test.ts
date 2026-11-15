import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    sources: vi.fn(), count: vi.fn(), briefing: vi.fn(), evidence: vi.fn(), events: vi.fn(), findSource: vi.fn(),
    updateDocuments: vi.fn(), transaction: vi.fn(), findAnalysis: vi.fn(),
    findJobs: vi.fn(), findJob: vi.fn(), updateJob: vi.fn()
}));
vi.mock("@/lib/news-db", () => ({ newsDb: {
    newsSource: { findMany: mocks.sources, findFirst: mocks.findSource },
    newsDocument: { count: mocks.count, findMany: mocks.evidence, updateMany: mocks.updateDocuments },
    newsBriefing: { findFirst: mocks.briefing },
    newsEvent: { findMany: mocks.events },
    newsAnalysis: { findUnique: mocks.findAnalysis },
    $transaction: mocks.transaction
} }));
vi.mock("@/lib/db", () => ({ prisma: { codexJob: { findMany: mocks.findJobs, findUnique: mocks.findJob, update: mocks.updateJob } } }));
import { NewsIntelligenceService } from "@/services/NewsIntelligenceService";
const service = new NewsIntelligenceService();
const asOf = new Date("2026-10-31T09:00:00Z");
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("NEWS_COLLECTOR_OWNER_ADDRESS", "0xabc"); mocks.sources.mockResolvedValue([]); mocks.count.mockResolvedValue(0); mocks.briefing.mockResolvedValue(null); mocks.events.mockResolvedValue([]); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("invalid news analysis retry", () => {
    beforeEach(() => {
        mocks.findJobs.mockResolvedValue([]);
        mocks.findAnalysis.mockResolvedValue(null);
        mocks.evidence.mockResolvedValue([{ analysisJobId: "news-job" }]);
        mocks.transaction.mockImplementation((updates: Promise<unknown>[]) => Promise.all(updates));
        mocks.updateDocuments.mockResolvedValue({ count: 1 });
    });

    it.each(["runner validation", "semantic validation"])("requeues evidence once after %s", async (failure) => {
        mocks.findJob.mockResolvedValue(failure === "runner validation"
            ? { ownerAddress: "0xabc", status: "failed", errorCode: "invalid_output" }
            : { ownerAddress: "0xabc", status: "completed", metadataJson: '{"universe":[]}', resultJson: '{"summary":"","signals":[null]}' });

        await service.finalizeAnalyses();

        const where = { ownerAddress: "0xabc", analysisJobId: "news-job", status: "analyzing" };
        expect(mocks.updateDocuments.mock.calls).toEqual([
            [{ where: { ...where, analysisRetryUsed: true }, data: { status: "rejected" } }],
            [{ where: { ...where, analysisRetryUsed: false }, data: { status: "pending", analysisJobId: null, analysisRetryUsed: true } }]
        ]);
        expect(mocks.transaction).toHaveBeenCalledOnce();
        if (failure === "semantic validation") {
            expect(mocks.updateJob).toHaveBeenCalledWith({
                where: { id: "news-job" }, data: { status: "failed", errorCode: "invalid_output" }
            });
        }
    });

    it("requeues a timed-out batch without using its validation retry", async () => {
        mocks.findJob.mockResolvedValue({ status: "failed", errorCode: "timeout" });

        await service.finalizeAnalyses();

        expect(mocks.updateDocuments).toHaveBeenCalledOnce();
        expect(mocks.updateDocuments).toHaveBeenCalledWith({
            where: { analysisJobId: "news-job", status: "analyzing" },
            data: { status: "pending", analysisJobId: null }
        });
    });
});

describe("private news context", () => {
    it("scopes source and evidence reads to the authenticated wallet", async () => {
        mocks.evidence.mockResolvedValue([]);
        await service.sources("0xABC"); await service.evidence("0xABC", ["foreign-evidence"]);
        expect(mocks.sources.mock.calls[0][0].where.ownerAddress).toBe("0xabc");
        expect(mocks.evidence.mock.calls[0][0].where).toEqual({ ownerAddress: "0xabc", id: { in: ["foreign-evidence"] } });
    });
    it("excludes future briefings and expired/mismatched-symbol events", async () => {
        mocks.sources.mockResolvedValue([{ name: "Source", enabled: true, status: "healthy", lastSuccessAt: new Date(asOf.getTime() - 1000), intervalSeconds: 60 }]);
        const signals = [{ symbols: ["BTC"], expiresAt: "2026-10-31T10:00:00Z" }, { symbols: ["ETH"], expiresAt: "2026-10-31T10:00:00Z" }, { symbols: ["BTC"], expiresAt: "2026-10-30T10:00:00Z" }];
        mocks.briefing.mockResolvedValue({ id: "briefing", availableAt: new Date(asOf.getTime() - 1000), summary: "Current", signalsJson: JSON.stringify(signals) });
        mocks.events.mockResolvedValue(signals.map(signal => ({ signalJson: JSON.stringify(signal) })));
        const result = await service.briefing("0xABC", ["BTC-PERP"], asOf);
        expect(mocks.briefing.mock.calls[0][0].where.availableAt).toEqual({ lte: asOf });
        expect(result.briefingId).toBe("briefing"); expect(result.signals).toHaveLength(1); expect(result.status).toBe("healthy");
    });
    it("fills the asset briefing from matching active events beyond the global 30-event snapshot", async () => {
        const availableAt = new Date(asOf.getTime() - 1000);
        const event = (summary: string, symbols: string[], facts?: object) => ({
            signalJson: JSON.stringify({ summary, symbols, expiresAt: "2026-10-31T10:00:00Z", ...(facts ? { facts } : {}) })
        });
        const unrelated = Array.from({ length: 30 }, (_, i) => event(`ETH ${i}`, ["ETH"]));
        const macro = event("Market-wide rates change", [], { targets: [{ relation: "market", mechanism: "Unexpected change in USD rates" }] });
        const bitcoin = Array.from({ length: 35 }, (_, i) => event(`BTC ${i}`, ["BTC"]));
        mocks.briefing.mockResolvedValue({ id: "batch", availableAt, summary: "Current batch", signalsJson: JSON.stringify(unrelated.map(row => JSON.parse(row.signalJson))) });
        mocks.events.mockResolvedValue([...unrelated, macro, ...bitcoin]);

        const context = await service.briefing("0xABC", ["BTC-PERP"], asOf);

        expect(context.signals.map(signal => signal.summary)).toEqual(["Market-wide rates change", ...bitcoin.slice(0, 29).map(row => JSON.parse(row.signalJson).summary)]);
        expect(context.briefingId).toBe("batch");
        expect(context.availableAt).toBe(availableAt.toISOString());
        expect(mocks.events).toHaveBeenCalledWith({
            where: { ownerAddress: "0xabc", availableAt: { lte: availableAt }, expiresAt: { gt: asOf } },
            orderBy: [{ availableAt: "desc" }, { id: "asc" }],
            select: { signalJson: true }
        });
    });
    it("shows asset subjects and exposures in the panel while excluding market-wide and unrelated news", async () => {
        const event = (summary: string, symbols: string[], facts?: object) => ({
            signalJson: JSON.stringify({ summary, symbols, expiresAt: "2026-10-31T10:00:00Z", facts })
        });
        mocks.briefing.mockResolvedValue({ id: "batch", availableAt: asOf, summary: "Current batch" });
        mocks.events.mockResolvedValue([
            event("Market commentary", ["BTC", "ETH"], { subject: {}, targets: [{ relation: "market", symbol: "BTC", mechanism: "USD liquidity" }] }),
            event("Legacy BTC", ["BTC"]),
            event("PEPE migration", [], { subject: { symbol: "PEPE" }, targets: [] }),
            event("Venue suspends PEPE deposits", [], { subject: {}, targets: [{ relation: "venue", symbol: "PEPE", mechanism: "Deposit suspension" }] }),
            event("Legacy PEPE", ["PEPE"]),
            event("Unrelated application", ["PEPE"], { subject: {}, targets: [{ relation: "unresolved", symbol: "PEPE", mechanism: "Association only" }] })
        ]);

        const expected = ["PEPE migration", "Venue suspends PEPE deposits", "Legacy PEPE"];
        const briefing = await service.assetBriefing("0xABC", ["kPEPE-PERP"], asOf);
        expect(briefing.signals.map(signal => signal.summary)).toEqual(expected);
        expect((await service.assetEvents("0xABC", ["kPEPE-PERP"])).map(signal => signal.summary)).toEqual(expected);
        expect((await service.assetBriefing("0xABC", ["HYPE"], asOf)).signals).toEqual([]);
    });
    it("passes only signals fully supported by fresh healthy sources, even before a healthy observation day", async () => {
        vi.stubEnv("NEWS_TRADER_CONTEXT_ENABLED", "healthy");
        const source = { id: "fresh", name: "Fresh", enabled: true, status: "healthy", lastSuccessAt: asOf, intervalSeconds: 60 };
        mocks.sources.mockResolvedValue([source,
            { ...source, id: "partial", status: "partial" },
            { ...source, id: "stale", lastSuccessAt: new Date(asOf.getTime() - 180_001) },
            { ...source, id: "future", lastSuccessAt: new Date(asOf.getTime() + 1) },
            { ...source, id: "disabled", enabled: false }
        ]);
        const availableAt = new Date(asOf.getTime() - 1000);
        mocks.briefing.mockResolvedValue({ id: "batch", availableAt, summary: "Unfiltered batch claim" });
        const event = (summary: string, symbols: string[], evidenceIds: string[]) => ({
            signalJson: JSON.stringify({ summary, symbols, evidenceIds, ...(summary === "Macro" ? { facts: { targets: [{ relation: "market", mechanism: "Unexpected change in USD rates" }] } } : {}) })
        });
        mocks.events.mockResolvedValue([
            ...Array(30).fill(event("Blocked", ["BTC"], ["bad"])),
            event("Mixed", ["BTC"], ["good", "missing"]), event("No citations", [], []),
            event("Unresolved", [], ["good"]), event("Asset", ["BTC"], ["good"]), event("Macro", [], ["good"]), event("Other", ["ETH"], ["other"])
        ]);
        mocks.evidence.mockResolvedValue([{ id: "good" }]);

        const context = await service.traderContext(["BTC-PERP"], asOf);

        expect(context?.signals.map(signal => signal.summary)).toEqual(["Asset", "Macro"]);
        expect(context?.summary).not.toContain("Unfiltered batch claim");
        expect(context?.coverage).toMatchObject({ configured: 4, healthy: 1 });
        expect(context?.status).toBe("incomplete");
        expect(mocks.events.mock.calls[0][0].where).toEqual({ ownerAddress: "0xabc", availableAt: { lte: availableAt }, expiresAt: { gt: asOf } });
        expect(mocks.evidence.mock.calls[0][0].where).toMatchObject({
            ownerAddress: "0xabc", id: { in: ["bad", "good", "missing"] }, sourceId: { in: ["fresh"] },
            status: "analyzed", availableAt: { lte: availableAt }, expiresAt: { gt: asOf },
            source: { ownerAddress: "0xabc", collector: { ownerAddress: "0xabc", enabled: true } }
        });
        mocks.evidence.mockResolvedValue([]);
        expect(await service.traderContext(["BTC-PERP"], asOf)).toBeNull();
    });
    it("does not disguise unavailable, pending, or incomplete coverage as neutral sentiment", async () => {
        expect((await service.briefing("0xabc", undefined, asOf)).status).toBe("no_sources");
        mocks.sources.mockResolvedValue([{ name: "Private channel", enabled: true, status: "login_required", lastSuccessAt: null, intervalSeconds: 60 }]);
        expect((await service.briefing("0xabc", undefined, asOf)).status).toBe("incomplete");
        mocks.sources.mockResolvedValue([{ name: "Private channel", enabled: true, status: "healthy", lastSuccessAt: new Date(asOf.getTime() - 1000), intervalSeconds: 60 }]);
        mocks.count.mockResolvedValue(3);
        expect((await service.briefing("0xabc", undefined, asOf)).status).toBe("pending");
        mocks.sources.mockRejectedValue(new Error("database unavailable"));
        expect((await service.briefing("0xabc", undefined, asOf)).status).toBe("unavailable");
    });
    it("rejects source updates belonging to another wallet", async () => {
        mocks.findSource.mockResolvedValue(null);
        await expect(service.saveSource("0xabc", { name: "News", adapter: "article", url: "https://example.com/news" }, "foreign-source")).rejects.toThrow("not found");
        expect(mocks.findSource).toHaveBeenCalledWith({ where: { id: "foreign-source", ownerAddress: "0xabc" } });
    });
    it("cannot use another wallet's signed-in collector browser", async () => {
        await expect(service.saveSource("0xother", { name: "Private channel", adapter: "discord", url: "https://discord.com/channels/123/456" })).rejects.toThrow("not paired");
        expect(mocks.findSource).not.toHaveBeenCalled();
    });
});
