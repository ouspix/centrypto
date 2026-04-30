import { beforeEach, describe, expect, it, vi } from "vitest";

describe("CollectorRunner readiness", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
        vi.useRealTimers();
        (globalThis as any).__collectorRunners = undefined;
    });

    it("returns a clear stale-data error when API collector startup is disabled", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-30T00:10:00Z"));
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("ALLOW_API_COLLECTOR_START", "false");
        vi.doMock("@/services/MarketCollectorService", () => ({
            MarketCollectorService: vi.fn().mockImplementation(() => ({
                startCandleStream: vi.fn(),
                collectTicks: vi.fn()
            }))
        }));
        vi.doMock("@/lib/market-db", () => ({
            marketDbMain: marketDb(new Date("2026-04-30T00:00:00Z")),
            marketDbTest: marketDb(new Date("2026-04-30T00:00:00Z"))
        }));

        const { ensureCollectorReady } = await import("@/services/CollectorRunner");

        await expect(ensureCollectorReady(false)).rejects.toThrow(/Cached mainnet market data is stale/i);
        vi.useRealTimers();
    });
});

function marketDb(ts: Date) {
    return {
        marketTick: {
            findFirst: vi.fn().mockResolvedValue({ ts, symbol: "BTC" })
        },
        marketCandle: {
            findFirst: vi.fn().mockResolvedValue({ openTime: ts, symbol: "BTC" })
        }
    };
}
