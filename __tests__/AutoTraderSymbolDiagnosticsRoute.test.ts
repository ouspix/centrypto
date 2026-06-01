import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetLatestSymbolDiagnostics = vi.hoisted(() => vi.fn());
const mockRequireWalletSession = vi.hoisted(() => vi.fn());

vi.mock("@/services/OpportunityJournalService", () => ({
    OpportunityJournalService: {
        getInstance: () => ({
            getLatestSymbolDiagnostics: mockGetLatestSymbolDiagnostics
        })
    }
}));

vi.mock("@/lib/auth/wallet-session", () => {
    class WalletSessionError extends Error {
        public readonly status: number;
        constructor(message: string, status = 401) {
            super(message);
            this.status = status;
        }
    }
    return {
        requireWalletSession: mockRequireWalletSession,
        WalletSessionError
    };
});

describe("auto-trader symbol diagnostics route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRequireWalletSession.mockReturnValue({
            address: "0x00000000000000000000000000000000000000ab"
        });
        mockGetLatestSymbolDiagnostics.mockResolvedValue({
            symbol: "BTC-PERP",
            network: "testnet",
            latestSnapshotId: 77,
            discovered: true
        });
    });

    it("requires a symbol query parameter", async () => {
        const { GET } = await import("@/app/api/auto-trader/diagnostics/symbol/route");

        const response = await GET(new Request("http://localhost/api/auto-trader/diagnostics/symbol?network=testnet"));

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "symbol is required" });
        expect(mockGetLatestSymbolDiagnostics).not.toHaveBeenCalled();
    });

    it("normalizes the symbol and loads wallet-scoped diagnostics", async () => {
        const { GET } = await import("@/app/api/auto-trader/diagnostics/symbol/route");

        const response = await GET(new Request("http://localhost/api/auto-trader/diagnostics/symbol?symbol=BTC&network=testnet"));
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(mockGetLatestSymbolDiagnostics).toHaveBeenCalledWith({
            accountAddress: "0x00000000000000000000000000000000000000ab",
            network: "testnet",
            symbol: "BTC-PERP"
        });
        expect(payload).toMatchObject({
            symbol: "BTC-PERP",
            latestSnapshotId: 77,
            discovered: true
        });
    });
});
