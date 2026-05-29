import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    exchangePost: vi.fn(),
    getMeta: vi.fn(),
    signL1Action: vi.fn(),
    privateKeyToAccount: vi.fn()
}));

vi.mock("@/lib/rate-limit/hyperliquid-limiter", () => ({
    hyperliquidExchangePost: mocks.exchangePost
}));

vi.mock("@/lib/hyperliquid-info", () => ({
    getMeta: mocks.getMeta,
    hyperliquidInfoUrl: (isTestnet: boolean) =>
        isTestnet ? "https://api.hyperliquid-testnet.xyz/info" : "https://api.hyperliquid.xyz/info"
}));

vi.mock("@nktkas/hyperliquid/signing", () => ({
    signL1Action: mocks.signL1Action
}));

vi.mock("viem/accounts", () => ({
    privateKeyToAccount: mocks.privateKeyToAccount
}));

import { placeOrderWithPrivateKey, placeTriggerOrdersWithPrivateKey } from "@/lib/hyperliquid-execution";

const stopCloid = "0x11111111111111111111111111111111" as const;
const takeProfitCloid = "0x22222222222222222222222222222222" as const;
const entryCloid = "0x33333333333333333333333333333333" as const;

describe("Hyperliquid execution payloads", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getMeta.mockResolvedValue([{ szDecimals: 2 }]);
        mocks.privateKeyToAccount.mockReturnValue({ address: "0xWallet" });
        mocks.signL1Action.mockResolvedValue({
            r: "0x".padEnd(66, "1"),
            s: "0x".padEnd(66, "2"),
            v: 27
        });
        mocks.exchangePost.mockResolvedValue({
            status: "ok",
            response: { type: "order", data: { statuses: [] } }
        });
    });

    it("submits standalone position-protection triggers without TP/SL parent grouping", async () => {
        await placeTriggerOrdersWithPrivateKey(
            "abc",
            {
                asset: 0,
                positionSide: "long",
                sz: 1.23,
                stopLossPrice: 95,
                takeProfitPrice: 105,
                nonce: 123,
                cloids: {
                    stopLoss: stopCloid,
                    takeProfit: takeProfitCloid
                }
            },
            false
        );

        const payload = mocks.exchangePost.mock.calls[0][2];
        expect(payload.action.grouping).toBe("na");
        expect(payload.action.orders).toEqual([
            expect.objectContaining({
                a: 0,
                b: false,
                r: true,
                c: stopCloid,
                t: { trigger: { isMarket: true, triggerPx: "95", tpsl: "sl" } }
            }),
            expect.objectContaining({
                a: 0,
                b: false,
                r: true,
                c: takeProfitCloid,
                t: { trigger: { isMarket: true, triggerPx: "105", tpsl: "tp" } }
            })
        ]);
        expect(mocks.signL1Action).toHaveBeenCalledWith(expect.objectContaining({
            action: expect.objectContaining({ grouping: "na" }),
            nonce: 123,
            isTestnet: false
        }));
    });

    it("keeps normal TP/SL grouping when entry and bracket orders are submitted atomically", async () => {
        await placeOrderWithPrivateKey(
            "abc",
            {
                asset: 0,
                isBuy: true,
                limitPx: 100,
                sz: 1.23,
                reduceOnly: false,
                stopLossPrice: 95,
                takeProfitPrice: 105,
                nonce: 456,
                cloids: {
                    entry: entryCloid,
                    stopLoss: stopCloid,
                    takeProfit: takeProfitCloid
                }
            },
            false
        );

        const payload = mocks.exchangePost.mock.calls[0][2];
        expect(payload.action.grouping).toBe("normalTpsl");
        expect(payload.action.orders).toEqual([
            expect.objectContaining({
                a: 0,
                b: true,
                r: false,
                c: entryCloid,
                t: { limit: { tif: "Gtc" } }
            }),
            expect.objectContaining({
                b: false,
                r: true,
                c: stopCloid,
                t: { trigger: { isMarket: true, triggerPx: "95", tpsl: "sl" } }
            }),
            expect.objectContaining({
                b: false,
                r: true,
                c: takeProfitCloid,
                t: { trigger: { isMarket: true, triggerPx: "105", tpsl: "tp" } }
            })
        ]);
    });
});
