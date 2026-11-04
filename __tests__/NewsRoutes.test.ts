import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ session: vi.fn(), sources: vi.fn(), save: vi.fn(), evidence: vi.fn(), briefing: vi.fn() }));
vi.mock("@/lib/auth/wallet-session", () => ({ requireWalletSession: mocks.session, WalletSessionError: class extends Error { status = 401; } }));
vi.mock("@/services/NewsIntelligenceService", () => ({ NewsIntelligenceService: vi.fn(() => ({ sources: mocks.sources, saveSource: mocks.save, evidence: mocks.evidence, briefing: mocks.briefing })) }));
vi.mock("@/lib/news-db", () => ({ newsDb: {} }));
vi.mock("@/services/CodexQueueService", () => ({ CodexQueueService: vi.fn(() => ({})) }));
import { GET, POST } from "@/app/api/news/[...path]/route";
import { WalletSessionError } from "@/lib/auth/wallet-session";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("NEWS_COLLECTOR_OWNER_ADDRESS", "0xaccount"); mocks.session.mockReturnValue({ address: "0xowner" }); });
afterEach(() => { vi.unstubAllEnvs(); });
describe("news endpoint ownership", () => {
    it("rejects unauthenticated reads before touching private data", async () => {
        mocks.session.mockImplementation(() => { throw new WalletSessionError("Wallet session required"); });
        const response = await GET(new NextRequest("http://localhost/api/news/sources"), { params: { path: ["sources"] } });
        expect(response.status).toBe(401); expect(mocks.sources).not.toHaveBeenCalled();
    });
    it("uses the installation news account for writes regardless of trading wallet or spoofed payload owner", async () => {
        mocks.save.mockResolvedValue({ id: "source" });
        const request = new NextRequest("http://localhost/api/news/sources", { method: "POST", body: JSON.stringify({ ownerAddress: "0xvictim", name: "Source", adapter: "article", url: "https://example.com" }) });
        expect((await POST(request, { params: { path: ["sources"] } })).status).toBe(200);
        expect(mocks.save.mock.calls[0][0]).toBe("0xaccount");
    });
    it("marks private responses non-cacheable and scopes evidence access", async () => {
        mocks.evidence.mockResolvedValue([]);
        const response = await GET(new NextRequest("http://localhost/api/news/evidence?ids=other-wallet-item"), { params: { path: ["evidence"] } });
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(mocks.evidence).toHaveBeenCalledWith("0xaccount", ["other-wallet-item"]);
    });
    it("does not expose database exception text containing source fields", async () => {
        mocks.sources.mockRejectedValue(new Error('Invalid prisma.newsSource.findMany invocation: sensitive database details'));
        const response = await GET(new NextRequest("http://localhost/api/news/sources"), { params: { path: ["sources"] } });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "News request failed" });
    });
    it("reads the same news setup after switching trading wallets", async () => {
        mocks.sources.mockResolvedValue([{ id: "existing" }]);
        const request = new NextRequest("http://localhost/api/news/sources");
        const context = { params: { path: ["sources"] } };
        const first = await GET(request, context);
        mocks.session.mockReturnValue({ address: "0xanother" });
        const second = await GET(request, context);
        expect(await first.json()).toEqual({ sources: [{ id: "existing" }] });
        expect(await second.json()).toEqual({ sources: [{ id: "existing" }] });
        expect(mocks.sources.mock.calls).toEqual([["0xaccount"], ["0xaccount"]]);
    });
    it("reports missing installation configuration instead of querying a trading wallet's news", async () => {
        vi.stubEnv("NEWS_COLLECTOR_OWNER_ADDRESS", "");
        const response = await GET(new NextRequest("http://localhost/api/news/sources"), { params: { path: ["sources"] } });
        expect(response.status).toBe(503);
        expect(mocks.sources).not.toHaveBeenCalled();
    });
});
