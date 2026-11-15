// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ perp: vi.fn(), spot: vi.fn() }));
vi.mock("@/lib/hyperliquid-info", () => ({ getClearinghouseState: mocks.perp, getSpotClearinghouseState: mocks.spot, getFrontendOpenOrders: async () => [], hyperliquidInfoUrl: () => "https://example.test/info" }));
import { accountExposure } from "@/lib/desk/market";
describe("explicit desk collateral", () => {
    it("stops downstream account requests when the first account read fails",async()=>{
        vi.clearAllMocks();mocks.perp.mockResolvedValue(null);
        await expect(accountExposure({accountAddress:"owner",isTestnet:false} as any)).rejects.toThrow("Account exposure unavailable");
        expect(mocks.spot).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it("does not count spot USDC as funded perpetual equity", async () => {
        vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => "default" } as Response);
        mocks.perp.mockResolvedValue({ assetPositions: [], marginSummary: { accountValue: "0", totalMarginUsed: "0" } });
        mocks.spot.mockResolvedValue({ balances: [{ coin: "USDC", token: 0, total: "1250", hold: "50" }] });
        const result = await accountExposure({ accountAddress: "owner", isTestnet: false } as any);
        expect(result.collateral).toMatchObject({ status: "no_perp_collateral", perpEquityUsd: 0, spotUsdcAvailable: 1200, transferAuthorized: false });
    });
    it("recognizes shared unified collateral despite zero legacy perp equity", async () => {
        vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => "unifiedAccount" } as Response);
        mocks.perp.mockResolvedValue({ assetPositions: [], marginSummary: { accountValue: "0" } });
        mocks.spot.mockResolvedValue({ balances: [{ coin: "USDC", token: 0, total: "1250", hold: "50" }] });
        expect((await accountExposure({} as any)).collateral).toMatchObject({ accountMode: "unifiedAccount", status: "unified_usdc_collateral_present", spotUsdcAvailable: 1200, transferAuthorized: false });
    });
    it("keeps missing equity unknown rather than assuming zero or available margin", async () => {
        vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => "default" } as Response);
        mocks.perp.mockResolvedValue({ assetPositions: [] }); mocks.spot.mockResolvedValue({ balances: [] });
        expect((await accountExposure({} as any)).collateral.status).toBe("unknown");
    });
});
