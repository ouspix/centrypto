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
        const mainDb = marketDb(new Date("2026-04-30T00:00:00Z"));
        const testDb = marketDb(new Date("2026-04-30T00:00:00Z"));
        vi.doMock("@/lib/market-db", () => ({
            marketDbMain: mainDb,
            marketDbTest: testDb,
            getMarketDb: vi.fn().mockImplementation(async (isTestnet: boolean) => isTestnet ? testDb : mainDb),
            withMarketDbRetry: vi.fn().mockImplementation(async (_db: unknown, _label: string, operation: () => Promise<unknown>) => operation())
        }));

        const { ensureCollectorReady } = await import("@/services/CollectorRunner");

        await expect(ensureCollectorReady(false)).rejects.toMatchObject({
            name: "MarketDataStaleError",
            message: expect.stringContaining("Check the VPS `centrypto-market` service and its logs"),
        });
        vi.useRealTimers();
    });

    it("loads only the latest tick per symbol when ranking a large historical universe", async () => {
        const now = new Date();
        const groupBy = vi.fn().mockResolvedValue([
            { symbol: "BTC", _max: { ts: now } },
            { symbol: "ETH", _max: { ts: now } },
        ]);
        const findMany = vi.fn().mockResolvedValue([
            { symbol: "BTC", ts: now, volume24h: 100 },
            { symbol: "ETH", ts: now, volume24h: 200 },
        ]);
        vi.doMock("@/lib/market-db", () => ({
            getMarketDb: async () => ({ marketTick: { groupBy, findMany } }),
            withMarketDbRetry: async (_db: unknown, _label: string, operation: () => Promise<unknown>) => operation(),
        }));
        const { getCollectorRunner } = await import("@/services/CollectorRunner");
        const runner = getCollectorRunner(false) as unknown as { rankSymbolsByRecentVolume(): Promise<string[]> };
        expect(await runner.rankSymbolsByRecentVolume()).toEqual(["ETH", "BTC"]);
        expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ["symbol"], _max: { ts: true } }));
        expect(findMany).toHaveBeenCalledWith({
            where: { OR: [{ symbol: "BTC", ts: now }, { symbol: "ETH", ts: now }] },
            select: { symbol: true, ts: true, volume24h: true },
            orderBy: { ts: "desc" },
        });
    });

    it("does not queue overlapping tick requests while a snapshot is still pending", async () => {
        vi.useFakeTimers();
        let finish!: () => void;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        const collectTicks = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined);
        vi.doMock("@/services/MarketCollectorService", () => ({
            MarketCollectorService: vi.fn().mockImplementation(() => ({ collectTicks })),
        }));
        const { getCollectorRunner } = await import("@/services/CollectorRunner");
        const runner = getCollectorRunner(false) as unknown as { startTickLoop(): void; stop(): void };
        try {
            runner.startTickLoop();
            await vi.advanceTimersByTimeAsync(60000);
            expect(collectTicks).toHaveBeenCalledTimes(1);
            finish();
            await vi.advanceTimersByTimeAsync(15000);
            expect(collectTicks).toHaveBeenCalledTimes(2);
        } finally {
            finish();
            runner.stop();
            vi.useRealTimers();
        }
    });
});

function marketDb(ts: Date) {
    return {
        marketTick: {
            findFirst: vi.fn().mockResolvedValue({ ts, symbol: "BTC" })
        },
        marketCandle: {
            findFirst: vi.fn().mockResolvedValue({ openTime: ts, symbol: "BTC" }),
            groupBy: vi.fn().mockResolvedValue([])
        },
        $queryRawUnsafe: vi.fn().mockResolvedValue([])
    };
}
