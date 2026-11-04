import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $queryRawUnsafe: vi.fn(async () => [{ name: "SymbolSentimentSnapshot" }]), symbolSentimentSnapshot: { findFirst: mocks.snapshot } } }));
vi.mock("@/lib/news-db", () => { throw new Error("Public sentiment must never import the private news database"); });
vi.mock("@/sentiment/config", () => ({ getSymbolConfig: () => ({ BTC: {} }), addSymbolToConfig: vi.fn() }));
vi.mock("@/sentiment/symbolMapper", () => ({ clearMatchersCache: vi.fn() }));
import { GET as allSentiment } from "@/app/api/sentiment/route";
import { GET as assetSentiment } from "@/app/api/sentiment/[symbol]/route";
beforeEach(() => {
    mocks.snapshot.mockReset();
    mocks.snapshot.mockResolvedValue({ symbol: "BTC", score: 0.1, disagreement: 0.2, mentions: 4, mentionsVsBaseline: 1, change2h: 0, sourceMixJson: '{}', tagsJson: '["public-only"]' });
});
describe("public/private news separation", () => {
    it("serves legacy public snapshots without a wallet session or private store access", async () => {
        const response = await allSentiment();
        expect(response.status).toBe(200);
        const rows = await response.json();
        expect(rows[0].tags).toEqual(["public-only"]);
        expect(rows[0]).not.toHaveProperty("evidence");
        expect(rows[0]).not.toHaveProperty("briefingId");
    });
    it("keeps the public per-asset endpoint on legacy snapshots", async () => {
        const response = await assetSentiment(new Request("http://localhost/api/sentiment/BTC"), { params: { symbol: "BTC" } });
        expect((await response.json()).tags).toEqual(["public-only"]);
        expect(mocks.snapshot).toHaveBeenCalledWith({ where: { symbol: "BTC" }, orderBy: { updatedAt: "desc" } });
    });
});
