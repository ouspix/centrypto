import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ ownership: vi.fn(), auth: vi.fn(), hand: vi.fn(), kill: vi.fn() }));
vi.mock("@/lib/auth/wallet-session", () => ({
    requireWalletSession: h.auth,
    WalletSessionError: class extends Error {
        status = 401;
    },
}));
vi.mock("@/lib/desk/books", async (orig) => ({
    ...(await orig<typeof import("@/lib/desk/books")>()),
    ownedBook: h.ownership,
}));
vi.mock("@/lib/desk/execution", () => ({
    adoptDeskPosition: h.hand,
    deskExecutionState: vi.fn(),
    abandonDeskIntent: vi.fn(),
}));
vi.mock("@/lib/risk/kill-switch", () => ({ getWalletKillSwitch: vi.fn(), setWalletKillSwitch: h.kill }));
import { POST } from "@/app/api/desk/route";
import { DeskInputError } from "@/lib/desk/books";
import { WalletSessionError } from "@/lib/auth/wallet-session";
function post(body: unknown, origin = "http://localhost") {
    return POST(
        new Request("http://localhost/api/desk", {
            method: "POST",
            headers: { "Content-Type": "application/json", origin },
            body: JSON.stringify(body),
        }),
    );
}
beforeEach(() => {
    vi.clearAllMocks();
    h.auth.mockReturnValue({ address: "owner" });
});
describe("desk operator boundary", () => {
    it("rejects unauthenticated and cross-origin mutations before ownership or execution", async () => {
        h.auth.mockImplementationOnce(() => {
            throw new WalletSessionError("sign in");
        });
        expect((await post({ action: "handover", bookId: "target" })).status).toBe(401);
        expect(
            (await post({ action: "kill", bookId: "target", enabled: false }, "https://foreign.invalid")).status,
        ).toBe(403);
        expect(h.ownership).not.toHaveBeenCalled();
        expect(h.kill).not.toHaveBeenCalled();
    });
    it("refuses foreign book, regardless of owner or network supplied in the request", async () => {
        h.ownership.mockRejectedValueOnce(new DeskInputError("Book not found.", 404));
        const response = await post({
            action: "handover",
            bookId: "foreign",
            ownerAddress: "spoofed",
            instrumentId: "mainnet:perp:BTC",
        });
        expect(response.status).toBe(404);
        expect(h.ownership).toHaveBeenCalledWith("owner", "foreign");
        expect(h.hand).not.toHaveBeenCalled();
    });
});
