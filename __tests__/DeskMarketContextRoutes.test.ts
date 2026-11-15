// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    auth: vi.fn(), book: vi.fn(), reviews: vi.fn(), context: vi.fn(), screen: vi.fn(),
}));
vi.mock("@/lib/auth/wallet-session", () => ({
    requireWalletSession: mocks.auth, WalletSessionError: class extends Error {},
}));
vi.mock("@/lib/db", () => ({
    prisma: { deskBook: { findFirst: mocks.book }, deskRecord: { findMany: mocks.reviews } },
}));
vi.mock("@/lib/desk/market-context", () => ({
    readMarketContext: mocks.context, screenBook: mocks.screen, ScreenCursorError: class extends Error {},
}));

import { GET } from "@/app/api/desk/market-context/route";
import { POST } from "@/app/api/desk/screen/route";
import { WalletSessionError } from "@/lib/auth/wallet-session";

const query = "?bookId=book&network=testnet";
const get = (suffix = "") => GET(new Request("http://localhost/api/desk/market-context" + query + suffix));
const post = (body: unknown) => POST(new Request("http://localhost/api/desk/screen" + query, {
    method: "POST", body: JSON.stringify(body),
}));

beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockReturnValue({ address: "owner" });
    mocks.book.mockResolvedValue({ id: "book", isTestnet: true });
    mocks.reviews.mockResolvedValue([]);
    mocks.context.mockResolvedValue({ status: "observed" });
    mocks.screen.mockResolvedValue({ status: "research_candidates" });
});

describe("market context read boundary", () => {
    it("requires a wallet session before looking up context", async () => {
        mocks.auth.mockImplementationOnce(() => { throw new WalletSessionError("Wallet session required"); });
        expect((await get()).status).toBe(401);
        expect(mocks.book).not.toHaveBeenCalled();
        expect(mocks.context).not.toHaveBeenCalled();
    });
    it("binds ownership and network for both endpoints", async () => {
        mocks.book.mockResolvedValue(null);
        expect((await get()).status).toBe(404);
        expect((await post({})).status).toBe(404);
        expect(mocks.book).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "book", ownerAddress: "owner", isTestnet: true },
        }));
        expect(mocks.screen).not.toHaveBeenCalled();
    });
    it("handles inaccessible archived evidence and validates screen criteria", async () => {
        mocks.context.mockResolvedValueOnce(null);
        expect((await get("&snapshotId=" + "a".repeat(64))).status).toBe(404);
        expect((await post({ limit: 1000 })).status).toBe(400);
        expect(mocks.screen).not.toHaveBeenCalled();
        const response = await post({ preset: "compression", limit: 2 });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(mocks.screen).toHaveBeenCalledWith({ id: "book", isTestnet: true },
            expect.objectContaining({ preset: "compression", limit: 2 }), undefined);
    });
});
