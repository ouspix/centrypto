// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stream = new EventEmitter();
const upsert = vi.fn();
const ticks = vi.fn();
const observations = vi.fn();

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv("MARKET_COLLECTOR_ROLE", "worker");
    stream.removeAllListeners();
    upsert.mockReset().mockImplementation(async (query) => query.create);
    ticks.mockReset().mockResolvedValue({ count: 1 });
    observations.mockReset().mockResolvedValue({ id: 1 });
    const db = { marketTick: { createMany: ticks }, marketCandle: { upsert }, marketCandleObservation: { create: observations }, $transaction: (queries: Promise<unknown>[]) => Promise.all(queries) };
    vi.doMock("@/lib/hyperliquid-ws", () => ({
        HyperliquidWS: vi.fn().mockImplementation(() => Object.assign(stream, { connect: vi.fn(), subscribeToCandles: vi.fn(), subscribeToL2Book: vi.fn(), unsubscribeFromL2Book: vi.fn() })),
    }));
    vi.doMock("@/lib/hyperliquid-info", () => ({
        getMetaAndAssetCtxs: async () => ({ universe: [{ name: "BTC" }], assetCtxs: [{ markPx: "100", oraclePx: "100" }] }),
    }));
    vi.doMock("@/lib/market-db", () => ({
        getMarketDb: async () => db,
        withMarketDbRetry: async (_db: unknown, _label: string, operation: () => Promise<unknown>) => operation(),
    }));
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

function candle(t: number, close: string) {
    stream.emit("candle", { i: "1m", s: "BTC", t, o: "1", h: "2", l: "1", c: close, v: "10" });
}

describe("collector candle backpressure", () => {
    it("records actual quote sizes and drops stale, crossed and wrong-network books", async () => {
        const { MarketCollectorService } = await import("@/services/MarketCollectorService");
        const collector = new MarketCollectorService();
        await collector.startCandleStream(false);
        stream.emit("open");
        await Promise.resolve();
        stream.emit("l2Book", { coin: "BTC", time: Date.now(), levels: [[{ px: "99", sz: "3" }], [{ px: "101", sz: "2" }]] });
        await collector.collectTicks(false);
        expect(ticks.mock.lastCall![0].data[0]).toMatchObject({ symbol: "BTC", bookBidPx: 99, bookBidSz: 3, bookAskPx: 101, bookAskSz: 2 });
        expect(ticks.mock.lastCall![0].data[0].receivedAt).toBeInstanceOf(Date);
        expect(ticks.mock.lastCall![0].data[0].bookReceivedAt).toBeInstanceOf(Date);
        await collector.collectTicks(true);
        expect(ticks.mock.lastCall![0].data[0].bookBidPx).toBeUndefined();
        await vi.advanceTimersByTimeAsync(2001);
        stream.emit("l2Book", { coin: "BTC", time: Date.now(), levels: [[{ px: "102", sz: "3" }], [{ px: "101", sz: "2" }]] });
        await collector.collectTicks(false);
        expect(ticks.mock.lastCall![0].data[0].bookBidPx).toBeUndefined();
    });
    it("retries a failed batch without overwriting a newer candle", async()=>{
        const {MarketCollectorService}=await import("@/services/MarketCollectorService");
        await new MarketCollectorService().startCandleStream(false);
        upsert.mockImplementationOnce(async()=>{candle(60000,"3");throw new Error("database interrupted");});
        candle(60000,"2");await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(upsert.mock.lastCall![0].create.close).toBe(3);
    });
    it("coalesces repeated live updates and writes the latest candle values", async () => {
        const { MarketCollectorService } = await import("@/services/MarketCollectorService");
        await new MarketCollectorService().startCandleStream(false);
        for (let i = 0; i < 10000; i++) candle(60000, String(i));
        await vi.advanceTimersByTimeAsync(1000);
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(upsert.mock.calls[0][0].create).toMatchObject({ close: 9999, openTime: new Date(60000) });
        expect(observations).toHaveBeenCalledTimes(1);
        expect(observations.mock.calls[0][0].data).toMatchObject({ close: 9999, closeTime: new Date(120000), source: "hyperliquid_websocket" });
        expect(observations.mock.calls[0][0].data.receivedAt).toBeInstanceOf(Date);
    });

    it("bounds backlog to the newest 2000 candles and flushes at most 200 per batch", async () => {
        const { MarketCollectorService } = await import("@/services/MarketCollectorService");
        await new MarketCollectorService().startCandleStream(false);
        for (let i = 0; i < 2500; i++) candle(i * 60000, String(i));
        await vi.advanceTimersByTimeAsync(1000);
        expect(upsert).toHaveBeenCalledTimes(200);
        expect(upsert.mock.calls[0][0].create.openTime).toEqual(new Date(500 * 60000));
        await vi.advanceTimersByTimeAsync(9000);
        expect(upsert).toHaveBeenCalledTimes(2000);
        expect(upsert.mock.lastCall![0].create.close).toBe(2499);
    });
});
