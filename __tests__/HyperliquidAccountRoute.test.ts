import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetClearinghouseState = vi.hoisted(() => vi.fn());
const mockGetSpotClearinghouseState = vi.hoisted(() => vi.fn());
const mockGetAllMids = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hyperliquid-info", () => ({
    getClearinghouseState: mockGetClearinghouseState,
    getSpotClearinghouseState: mockGetSpotClearinghouseState,
    getAllMids: mockGetAllMids
}));

describe("Hyperliquid account route", () => {
    beforeEach(() => {
        mockGetClearinghouseState.mockReset();
        mockGetSpotClearinghouseState.mockReset();
        mockGetAllMids.mockReset();
    });

    it("returns account value for an explicit connected wallet address", async () => {
        const { GET } = await import("@/app/api/hyperliquid/account/route");
        mockGetClearinghouseState.mockResolvedValue({
            marginSummary: { accountValue: "100.50" },
            assetPositions: [
                {
                    position: {
                        coin: "BTC",
                        szi: "0.1",
                        entryPx: "100",
                        leverage: { value: "5" },
                        unrealizedPnl: "3.25"
                    }
                }
            ]
        });
        mockGetSpotClearinghouseState.mockResolvedValue({
            balances: [
                { coin: "USDC", total: "1262.594298", hold: "0.0" }
            ]
        });
        mockGetAllMids.mockResolvedValue({ BTC: "120" });

        const response = await GET(new Request(
            "http://localhost/api/hyperliquid/account?network=mainnet&address=0x00000000000000000000000000000000000000AB"
        ));
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(mockGetClearinghouseState).toHaveBeenCalledWith("0x00000000000000000000000000000000000000ab", false);
        expect(payload.accountValue).toBe(100.5);
        expect(payload.perpAccountValue).toBe(100.5);
        expect(payload.spotUsdc).toBe(1262.594298);
        expect(payload.equitySource).toBe("perps");
        expect(payload.unrealizedPnl).toBe(3.25);
        expect(payload.totalExposurePct).toBeCloseTo((12 / 100.5) * 100);
        expect(payload.marginUsagePct).toBeCloseTo((2.4 / 100.5) * 100);
    });

    it("uses spot USDC as account value when perps clearinghouse value is zero", async () => {
        const { GET } = await import("@/app/api/hyperliquid/account/route");
        mockGetClearinghouseState.mockResolvedValue({
            marginSummary: { accountValue: "0.0" },
            assetPositions: []
        });
        mockGetSpotClearinghouseState.mockResolvedValue({
            balances: [
                { coin: "USDC", total: "1262.594298", hold: "0.0" }
            ],
            tokenToAvailableAfterMaintenance: [[0, "1262.594298"]]
        });

        const response = await GET(new Request(
            "http://localhost/api/hyperliquid/account?network=mainnet&address=0x00000000000000000000000000000000000000AB"
        ));
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.accountValue).toBe(1262.594298);
        expect(payload.perpAccountValue).toBe(0);
        expect(payload.spotUsdc).toBe(1262.594298);
        expect(payload.equitySource).toBe("spot_usdc");
        expect(payload.totalExposurePct).toBe(0);
        expect(payload.marginUsagePct).toBe(0);
    });

    it("requires either an address query param or a wallet session", async () => {
        const { GET } = await import("@/app/api/hyperliquid/account/route");

        const response = await GET(new Request("http://localhost/api/hyperliquid/account?network=testnet"));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "Wallet address required" });
        expect(mockGetClearinghouseState).not.toHaveBeenCalled();
        expect(mockGetSpotClearinghouseState).not.toHaveBeenCalled();
    });
});
