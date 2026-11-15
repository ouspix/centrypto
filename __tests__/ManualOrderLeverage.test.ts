import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    leverage: vi.fn(),
    place: vi.fn(),
    setLeverage: vi.fn(),
    createSnapshots: vi.fn(),
    linkSnapshot: vi.fn(),
}));

vi.mock("@/lib/auth/wallet-session", () => ({
    requireWalletSessionFromCookies: () => ({ address: "0xowner" }),
    WalletSessionError: Error,
}));
vi.mock("@/lib/db", () => ({
    prisma: { orderLeverageSnapshot: { createMany: mocks.createSnapshots, updateMany: mocks.linkSnapshot } },
}));
vi.mock("@/lib/desk/execution-lease", () => ({
    withManualExecution: async (_db: unknown, _owner: string, _testnet: boolean, _cleanup: boolean,
        work: (check: () => Promise<void>) => Promise<unknown>) => ({ value: await work(async () => {}) }),
}));
vi.mock("@/lib/risk/execution-safety", () => ({ assertWalletExecutionAllowed: async () => {} }));
vi.mock("@/lib/hyperliquid-api-wallet", () => ({
    getUserHyperliquidApiWalletCredential: async () => ({ privateKey: "mock-credential" }),
    markHyperliquidApiWalletUsed: async () => {},
}));
vi.mock("@/lib/hyperliquid-info", () => ({ getActiveAssetLeverage: mocks.leverage }));
vi.mock("@/lib/hyperliquid-execution", () => ({
    getAssetMeta: async () => ({ name: "TIA", maxLeverage: 5 }),
    placeOrderWithPrivateKey: mocks.place,
    updateLeverageWithPrivateKey: mocks.setLeverage,
}));

import { placeOrderAction } from "@/app/actions/trade";

describe("manual order leverage recording", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.place.mockResolvedValue({
            status: "ok",
            response: { data: { statuses: [{ filled: { oid: 10 } }, { resting: { oid: 11 } }] } },
        });
    });

    it("records the exchange's leverage for the entry and stop before placement", async () => {
        mocks.leverage.mockResolvedValue({ type: "cross", value: 5 });
        const result = await placeOrderAction({
            asset: 1, isBuy: true, limitPx: 0.44, sz: 50, reduceOnly: false, stopLossPrice: 0.42, leverage: 1,
        }, false);

        expect(result.success).toBe(true);
        expect(mocks.leverage).toHaveBeenCalledWith("0xowner", "TIA", false);
        const [, order] = mocks.place.mock.calls[0];
        expect(order.cloids.entry).toMatch(/^0x[0-9a-f]{32}$/);
        expect(order.cloids.stopLoss).not.toBe(order.cloids.entry);
        expect(mocks.createSnapshots).toHaveBeenCalledWith({ data: [
            expect.objectContaining({ coin: "TIA", leverage: 5, marginMode: "cross", cloid: order.cloids.entry }),
            expect.objectContaining({ coin: "TIA", leverage: 5, marginMode: "cross", cloid: order.cloids.stopLoss }),
        ] });
        expect(mocks.setLeverage.mock.invocationCallOrder[0]).toBeLessThan(mocks.leverage.mock.invocationCallOrder[0]);
        expect(mocks.createSnapshots.mock.invocationCallOrder[0]).toBeLessThan(mocks.place.mock.invocationCallOrder[0]);
        expect(mocks.linkSnapshot).toHaveBeenCalledWith({
            where: { accountAddress: "0xowner", isTestnet: false, cloid: order.cloids.stopLoss },
            data: { oid: "11" },
        });
    });

    it("still places a reduce-only order when leverage is unavailable", async () => {
        mocks.leverage.mockResolvedValue(null);
        const result = await placeOrderAction({
            asset: 1, isBuy: false, limitPx: 0.44, sz: 50, reduceOnly: true,
        }, true);

        expect(result.success).toBe(true);
        expect(mocks.leverage).toHaveBeenCalledWith("0xowner", "TIA", true);
        expect(mocks.setLeverage).not.toHaveBeenCalled();
        expect(mocks.createSnapshots).not.toHaveBeenCalled();
        expect(mocks.place).toHaveBeenCalledOnce();
    });
});
