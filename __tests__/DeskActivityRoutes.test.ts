// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    auth: vi.fn(), book: vi.fn(), shifts: vi.fn(), records: vi.fn(), note: vi.fn(),
}));
vi.mock("@/lib/auth/wallet-session", () => ({
    requireWalletSession: mocks.auth, WalletSessionError: class extends Error { status = 401; },
}));
vi.mock("@/lib/db", () => ({ prisma: {
    deskBook: { findFirst: mocks.book }, deskShift: { findMany: mocks.shifts },
    deskRecord: { findMany: mocks.records, findFirst: mocks.note },
} }));
import { GET } from "@/app/api/desk/activity/route";
import { WalletSessionError } from "@/lib/auth/wallet-session";
const get = (query = "bookId=b&network=mainnet") => GET(new Request("http://localhost/api/desk/activity?" + query));
beforeEach(() => {
    vi.clearAllMocks(); mocks.auth.mockReturnValue({ address: "owner" });
    mocks.book.mockResolvedValue({ id: "b", version: 1, heartbeatAt: null, enabled: false });
    mocks.shifts.mockResolvedValue([]); mocks.records.mockResolvedValue([]); mocks.note.mockResolvedValue(null);
});
describe("activity read boundary", () => {
    it("requires a verified session before reading any book", async () => {
        mocks.auth.mockImplementationOnce(() => { throw new WalletSessionError("Sign in"); });
        expect((await get()).status).toBe(401);
        expect(mocks.book).not.toHaveBeenCalled();
    });
    it("binds ownership and network, and never reads activity for an inaccessible book", async () => {
        mocks.book.mockResolvedValueOnce(null);
        expect((await get()).status).toBe(404);
        expect(mocks.book).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "b", ownerAddress: "owner", isTestnet: false } }));
        expect(mocks.records).not.toHaveBeenCalled();
    });
    it("returns bounded private snapshots and refuses unspecified networks", async () => {
        expect((await get("bookId=b")).status).toBe(400);
        const response = await get();
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toMatchObject({ bookId: "b", shift: null, analysts: expect.any(Array) });
        expect(mocks.records.mock.calls.every(([query]) => query.take <= 200)).toBe(true);
    });
});
