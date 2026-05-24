import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";

const mockGetClearinghouseState = vi.hoisted(() => vi.fn());
const mockGetSpotClearinghouseState = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hyperliquid-info", () => ({
    getClearinghouseState: mockGetClearinghouseState,
    getSpotClearinghouseState: mockGetSpotClearinghouseState
}));

describe("AccountStateService", () => {
    beforeEach(() => {
        mockGetClearinghouseState.mockReset();
        mockGetSpotClearinghouseState.mockReset();
    });

    it("uses spot USDC as usable equity when the perps account value is zero", async () => {
        const { AccountStateService } = await import("@/services/AccountStateService");
        mockGetClearinghouseState.mockResolvedValue({
            marginSummary: { accountValue: "0.0", totalPnl: "0.0" },
            assetPositions: []
        });
        mockGetSpotClearinghouseState.mockResolvedValue({
            balances: [
                { coin: "USDC", total: "1262.594298", hold: "0.0" }
            ],
            tokenToAvailableAfterMaintenance: [[0, "1262.594298"]]
        });

        const { account } = await new AccountStateService().buildAccountState(
            "0x00000000000000000000000000000000000000ab",
            false,
            DEFAULT_AGENT_CONFIG.risk
        );

        expect(account.equity_usd).toBe(1262.594298);
        expect(account.perp_equity_usd).toBe(0);
        expect(account.spot_usdc).toBe(1262.594298);
        expect(account.equity_source).toBe("spot_usdc");
        expect(account.max_daily_loss).toBeCloseTo(1262.594298 * DEFAULT_AGENT_CONFIG.risk.daily_loss_kill_switch_fraction);
        expect(account.derived_portfolio.remaining_capacity).toBe(DEFAULT_AGENT_CONFIG.risk.max_total_exposure_fraction);
    });

    it("keeps perps account value as primary equity when it is nonzero", async () => {
        const { AccountStateService } = await import("@/services/AccountStateService");
        mockGetClearinghouseState.mockResolvedValue({
            marginSummary: { accountValue: "907.455515", totalPnl: "0.0" },
            assetPositions: []
        });
        mockGetSpotClearinghouseState.mockResolvedValue({
            balances: [
                { coin: "USDC", total: "100.0", hold: "0.0" }
            ]
        });

        const { account } = await new AccountStateService().buildAccountState(
            "0x00000000000000000000000000000000000000ab",
            true,
            DEFAULT_AGENT_CONFIG.risk
        );

        expect(account.equity_usd).toBe(907.455515);
        expect(account.perp_equity_usd).toBe(907.455515);
        expect(account.spot_usdc).toBe(100);
        expect(account.equity_source).toBe("perps");
    });
});
