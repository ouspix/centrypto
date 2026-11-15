import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUserFills = vi.hoisted(() => vi.fn());
const mockGetClearinghouseState = vi.hoisted(() => vi.fn());
const findLeverageSnapshots = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hyperliquid-info", () => ({
    getUserFills: mockGetUserFills,
    getClearinghouseState: mockGetClearinghouseState
}));

vi.mock("@/lib/db", () => ({
    prisma: { orderLeverageSnapshot: { findMany: findLeverageSnapshots } },
}));

describe("TradeHistoryService", () => {
    beforeEach(() => {
        mockGetUserFills.mockReset();
        mockGetClearinghouseState.mockReset();
        findLeverageSnapshots.mockReset().mockResolvedValue([]);
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
        expect(trades[0].leverageSource).toBe("current");
    });

    it("uses an explicit fill leverage ahead of current account leverage", async () => {
        const { TradeHistoryService } = await import("@/services/TradeHistoryService");
        mockGetUserFills.mockResolvedValue([fill({leverage: 7})]);
        mockGetClearinghouseState.mockResolvedValue({assetPositions:[{position:{coin:"ETH",leverage:{value:"3"}}}]});
        expect((await new TradeHistoryService().getTrades("0xabc", false))[0].leverage).toBe(7);
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

    it("replays split opening fills before applying the range and preserves the venue P&L", async () => {
        const { TradeHistoryService } = await import("@/services/TradeHistoryService");
        const opened = 1_720_000_000_000;
        const closed = opened + 2_204_369;
        mockGetClearinghouseState.mockResolvedValue({ assetPositions: [] });
        mockGetUserFills.mockResolvedValue([
            fill({ coin: "TIA", oid: 2, tid: 13, side: "A", dir: "Close Long", px: "0.43854", sz: "621.9",
                startPosition: "621.9", closedPnl: "-2.002518", fee: "0.117818", feeToken: "USDC", time: closed }),
            fill({ coin: "TIA", tid: 11, px: "0.44177", sz: "56.5", startPosition: "565.4", time: opened }),
            fill({ coin: "TIA", tid: 12, px: "0.44176", sz: "565.4", startPosition: "0", time: opened }),
        ]);

        const service = new TradeHistoryService();
        const [exit, ...entries] = await service.getTrades("0xabc");
        expect(exit).toMatchObject({
            exitPrice: 0.43854, status: "closed", side: "long", realizedPnl: -2.002518,
            fees: 0.117818, feeToken: "USDC", leverage: null,
        });
        expect(exit.entryPrice).toBeCloseTo(0.4417609085061907, 12);
        expect(entries.map(trade => trade.entryPrice)).toEqual([0.44177, 0.44176]);
        expect(new Set(entries.map(trade => trade.id)).size).toBe(2);
        expect(await service.getTrades("0xabc", false, 1, opened + 1)).toEqual([exit]);
    });

    it("keeps entry price unavailable when the visible history starts mid-position", async () => {
        const { TradeHistoryService } = await import("@/services/TradeHistoryService");
        mockGetClearinghouseState.mockResolvedValue(null);
        mockGetUserFills.mockResolvedValue([
            fill({ side: "B", dir: "Close Short", startPosition: "-0.01", px: "1800", closedPnl: "0" }),
        ]);

        const [exit] = await new TradeHistoryService().getTrades("0xabc");
        expect(exit).toMatchObject({
            entryPrice: null, exitPrice: 1800, status: "closed", side: "short", realizedPnl: 0,
        });
    });

    it("reads recorded leverage by exchange or client order ID within the wallet and network", async () => {
        const { TradeHistoryService } = await import("@/services/TradeHistoryService");
        const observedAt = new Date(1_719_999_999_000);
        mockGetUserFills.mockResolvedValue([
            fill({ oid: 1, leverage: 7 }),
            fill({ oid: 2 }),
            fill({ oid: 3, cloid: "client-stop" }),
            fill({ oid: 4, cloid: "client-entry" }),
        ]);
        mockGetClearinghouseState.mockResolvedValue({
            assetPositions: [{ position: { coin: "ETH", leverage: { value: 2 } } }],
        });
        findLeverageSnapshots.mockResolvedValue([
            { cloid: "venue-1", oid: "1", coin: "ETH", leverage: 5, marginMode: "cross", observedAt },
            { cloid: "venue-2", oid: "2", coin: "ETH", leverage: 4, marginMode: "cross", observedAt },
            { cloid: "client-stop", oid: null, coin: "ETH", leverage: 3, marginMode: "isolated", observedAt },
            { cloid: "client-entry", oid: "11", coin: "ETH", leverage: 5, marginMode: "cross", observedAt },
        ]);

        const [fillLevel, byOid, byCloid, unmatched] = await new TradeHistoryService().getTrades("0xAbC", true);
        expect(findLeverageSnapshots).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountAddress: "0xabc", isTestnet: true }),
        }));
        expect(fillLevel).toMatchObject({ leverage: 7, leverageSource: "fill" });
        expect(byOid).toMatchObject({ leverage: 4, leverageSource: "order", marginMode: "cross", leverageObservedAt: observedAt });
        expect(byCloid).toMatchObject({ leverage: 3, leverageSource: "order", marginMode: "isolated" });
        expect(unmatched).toMatchObject({ leverage: 2, leverageSource: "current" });
    });

    it("carries the short entry basis through a reduction and resets it on a reversal", async () => {
        const { TradeHistoryService } = await import("@/services/TradeHistoryService");
        mockGetClearinghouseState.mockResolvedValue(null);
        mockGetUserFills.mockResolvedValue([
            fill({ time: 4, side: "A", dir: "Close Long", startPosition: "1", sz: "1", px: "102" }),
            fill({ time: 3, side: "B", dir: "Short > Long", startPosition: "-1", sz: "2", px: "95" }),
            fill({ time: 2, side: "B", dir: "Close Short", startPosition: "-2", sz: "1", px: "98" }),
            fill({ time: 1, side: "A", dir: "Open Short", startPosition: "0", sz: "2", px: "100" }),
        ]);

        const trades = await new TradeHistoryService().getTrades("0xabc");
        expect(trades.map(trade => [trade.entryPrice, trade.side, trade.status])).toEqual([
            [95, "long", "closed"],
            [100, "short", "closed"],
            [100, "short", "closed"],
            [100, "short", "open"],
        ]);
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
