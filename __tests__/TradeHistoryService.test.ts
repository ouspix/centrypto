import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUserFills = vi.hoisted(() => vi.fn());
const mockGetClearinghouseState = vi.hoisted(() => vi.fn());
const mockFindAutoTraderFills = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hyperliquid-info", () => ({
    getUserFills: mockGetUserFills,
    getClearinghouseState: mockGetClearinghouseState
}));

vi.mock("@/lib/db", () => ({
    prisma: {
        autoTraderFill: {
            findMany: mockFindAutoTraderFills
        }
    }
}));

describe("TradeHistoryService", () => {
    beforeEach(() => {
        mockGetUserFills.mockReset();
        mockGetClearinghouseState.mockReset();
        mockFindAutoTraderFills.mockReset();
        mockFindAutoTraderFills.mockResolvedValue([]);
    });

    it("uses live clearinghouse leverage for fills when available", async () => {
        const { TradeHistoryService } = await import("@/services/TradeHistoryService");
        mockGetUserFills.mockResolvedValue([
            fill({ coin: "ETH", hash: "h1", oid: 1, dir: "Open Long" })
        ]);
        mockGetClearinghouseState.mockResolvedValue({
            assetPositions: [
                { position: { coin: "ETH", leverage: { value: "5" } } }
            ]
        });

        const trades = await new TradeHistoryService().getTrades("0xabc", false);

        expect(trades[0].leverage).toBe(5);
    });

    it("prefers locally recorded submitted leverage over current account leverage", async () => {
        const { TradeHistoryService } = await import("@/services/TradeHistoryService");
        mockGetUserFills.mockResolvedValue([
            fill({ coin: "ETH", hash: "h2", oid: 2, tid: "t2", dir: "Close Long" })
        ]);
        mockGetClearinghouseState.mockResolvedValue({
            assetPositions: [
                { position: { coin: "ETH", leverage: { value: "3" } } }
            ]
        });
        mockFindAutoTraderFills.mockResolvedValue([
            {
                hash: "h2",
                oid: "2",
                tid: "t2",
                orderAttempt: {
                    decision: {
                        submittedOrderPlanJson: JSON.stringify({ exchangeLeverage: 7 })
                    }
                },
                decision: null
            }
        ]);

        const trades = await new TradeHistoryService().getTrades("0xabc", false);

        expect(trades[0].leverage).toBe(7);
    });

    it("returns null leverage when the fill and account state do not expose it", async () => {
        const { TradeHistoryService } = await import("@/services/TradeHistoryService");
        mockGetUserFills.mockResolvedValue([
            fill({ coin: "CRV", hash: "h3", oid: 3, dir: "Open Short" })
        ]);
        mockGetClearinghouseState.mockResolvedValue({ assetPositions: [] });

        const trades = await new TradeHistoryService().getTrades("0xabc", true);

        expect(trades[0].leverage).toBeNull();
    });
});

function fill(overrides: Record<string, unknown>) {
    return {
        coin: "ETH",
        side: "B",
        sz: "0.01",
        px: "1800",
        closedPnl: "0",
        fee: "0",
        time: 1_720_000_000_000,
        hash: "hash",
        oid: 1,
        tid: "tid",
        dir: "Open Long",
        ...overrides
    };
}
