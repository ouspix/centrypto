import { describe, expect, it } from "vitest";
import {
    computeMfeMaeFromCandles,
    computeReviewFlags,
    extractOrderResponseStatus,
    generateCloid,
    normalizeHyperliquidFill,
    reconstructTradeLifecycles
} from "@/lib/auto-trader-review/review-utils";
import { nextExchangeNonce } from "@/lib/hyperliquid-execution";

describe("auto-trader review helpers", () => {
    it("generates Hyperliquid client order ids", () => {
        const cloid = generateCloid();
        expect(cloid).toMatch(/^0x[a-f0-9]{32}$/);
    });

    it("allocates monotonic Hyperliquid nonces within the process", () => {
        const first = nextExchangeNonce(1770000000000);
        const second = nextExchangeNonce(1770000000000);
        const third = nextExchangeNonce(1769999999999);

        expect(second).toBe(first + 1);
        expect(third).toBe(second + 1);
    });

    it("normalizes Hyperliquid fills with stable idempotency keys", () => {
        const fill = normalizeHyperliquidFill({
            coin: "BTC",
            px: "100",
            sz: "0.5",
            side: "B",
            dir: "Open Long",
            fee: "0.01",
            closedPnl: "0",
            hash: "0xabc",
            oid: 123,
            tid: 456,
            cloid: "0x11111111111111111111111111111111",
            time: 1770000000000
        }, {
            accountAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            network: "mainnet"
        });

        expect(fill.normalizedSymbol).toBe("BTC-PERP");
        expect(fill.fillType).toBe("OPEN");
        expect(fill.dedupeKey).toContain("tid:456");
        expect(fill.oid).toBe("123");
    });

    it("reconstructs partial long close lifecycles FIFO", () => {
        const fills = [
            {
                id: "open-1",
                normalizedSymbol: "BTC-PERP",
                side: "B",
                dir: "Open Long",
                px: 100,
                sz: 1,
                closedPnl: 0,
                fee: 0.1,
                time: new Date("2026-05-24T00:00:00Z"),
                attributionStatus: "MATCHED",
                attributionMethod: "ORDER_ID",
                decisionId: "d1",
                orderAttemptId: "o1"
            },
            {
                id: "close-1",
                normalizedSymbol: "BTC-PERP",
                side: "A",
                dir: "Close Long",
                px: 110,
                sz: 0.4,
                closedPnl: 4,
                fee: 0.05,
                time: new Date("2026-05-24T00:10:00Z"),
                attributionStatus: "MATCHED",
                attributionMethod: "ORDER_ID",
                decisionId: "d2",
                orderAttemptId: "o2"
            },
            {
                id: "close-2",
                normalizedSymbol: "BTC-PERP",
                side: "A",
                dir: "Close Long",
                px: 90,
                sz: 0.6,
                closedPnl: -6,
                fee: 0.05,
                time: new Date("2026-05-24T00:20:00Z"),
                attributionStatus: "MATCHED",
                attributionMethod: "ORDER_ID",
                decisionId: "d3",
                orderAttemptId: "o3"
            }
        ];

        const [lifecycle] = reconstructTradeLifecycles({
            accountAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            network: "mainnet",
            fills
        });

        expect(lifecycle.status).toBe("CLOSED");
        expect(lifecycle.sizeOpened).toBe(1);
        expect(lifecycle.sizeClosed).toBe(1);
        expect(lifecycle.grossRealizedPnl).toBe(-2);
        expect(lifecycle.fees).toBe(0.2);
        expect(lifecycle.netRealizedPnl).toBe(-2.2);
        expect(lifecycle.closeFillIds).toEqual(["close-1", "close-2"]);
    });

    it("computes long and short MFE/MAE from 1m candles", () => {
        const longMetrics = computeMfeMaeFromCandles({
            side: "long",
            entryPrice: 100,
            candles: [{ high: 105, low: 98 }, { high: 103, low: 96 }],
            expectedMinutes: 2
        });
        expect(longMetrics.mfeBps).toBe(500);
        expect(longMetrics.maeBps).toBe(-400);

        const shortMetrics = computeMfeMaeFromCandles({
            side: "short",
            entryPrice: 100,
            candles: [{ high: 104, low: 95 }, { high: 102, low: 97 }],
            expectedMinutes: 2
        });
        expect(shortMetrics.mfeBps).toBe(500);
        expect(shortMetrics.maeBps).toBe(-400);
    });

    it("flags observed green-to-red and late giveback", () => {
        const flags = computeReviewFlags({
            mfeBps: 100,
            entryPrice: 100,
            sizeOpened: 1,
            netRealizedPnl: -0.25,
            status: "CLOSED"
        });

        expect(flags.observedGreenToRed).toBe(true);
        expect(flags.lateGiveback).toBe(true);
        expect(flags.givebackPct).toBe(125);
    });

    it("does not flag open lifecycles from entry fees alone", () => {
        const flags = computeReviewFlags({
            mfeBps: 38.1,
            entryPrice: 2.391,
            sizeOpened: 23.8,
            netRealizedPnl: -0.024583,
            status: "OPEN"
        });

        expect(flags.observedGreenToRed).toBe(false);
        expect(flags.lateGiveback).toBe(false);
        expect(flags.givebackPct).toBeNull();
    });

    it("extracts order ids from Hyperliquid order responses", () => {
        const filled = extractOrderResponseStatus({
            status: "ok",
            response: { data: { statuses: [{ filled: { oid: 42, avgPx: "100", totalSz: "1" } }] } }
        }, 0);
        expect(filled.status).toBe("FILLED");
        expect(filled.oid).toBe("42");

        const failed = extractOrderResponseStatus({
            status: "ok",
            response: { data: { statuses: [{ error: "bad order" }] } }
        }, 0);
        expect(failed.status).toBe("FAILED");
        expect(failed.reason).toBe("bad order");
    });
});
