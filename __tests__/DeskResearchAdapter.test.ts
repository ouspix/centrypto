// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeInstruments } from "@/lib/desk/instruments";
import type { ResearchRequest } from "@/lib/desk/backtest/types";
const db = vi.hoisted(() => ({
  main: vi.fn(),
  test: vi.fn(),
  archive: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("@/lib/market-db", () => ({
  marketDbMain: { $queryRawUnsafe: db.main },
  marketDbTest: { $queryRawUnsafe: db.test },
}));
vi.mock("@/src/backtest/BacktestDb", () => ({
  DEFAULT_BACKTEST_DB_PATH: "/history.db",
  createBacktestDbClient: () => ({
    $queryRawUnsafe: db.archive,
    $disconnect: db.disconnect,
  }),
}));
vi.mock("node:fs/promises", () => ({
  access: async () => {},
  realpath: async (s: string) => s,
  readFile: async () => {
    throw Object.assign(new Error("No sidecar"), { code: "ENOENT" });
  },
}));
import { loadResearchData } from "@/lib/desk/backtest/data";
const at = Date.parse("2026-11-01T00:00:00Z");
const instruments = (testnet: boolean) =>
  nativeInstruments(testnet, [{ name: "BTC", szDecimals: 4 }], {
    tokens: [],
    universe: [],
  });
function request(testnet = false): ResearchRequest {
  return {
    hypothesis: "Recorded execution history",
    source: "collector",
    start: new Date(at).toISOString(),
    end: new Date(at + 1800000).toISOString(),
    instrumentIds: [(testnet ? "testnet" : "mainnet") + ":perp:BTC"],
    intervalSeconds: 60,
    feeBpsPerSide: 3.5,
    extraSlippageBps: 1,
    orders: [],
  };
}
const tick = (time: number, oracle = 100) => ({
  ts: new Date(time),
  symbol: "BTC",
  indexPrice: oracle,
  bookBidPx: 99,
  bookBidSz: 3,
  bookAskPx: 101,
  bookAskSz: 2,
});
beforeEach(() => {
  vi.clearAllMocks();
  db.main.mockResolvedValue([]);
  db.test.mockResolvedValue([]);
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => [{ coin: "BTC", time: at + 63, fundingRate: "0.0001" }],
  } as Response);
});
describe("historical data adapters", () => {
  it("uses raw collector symbols, isolates networks and never borrows future funding oracles", async () => {
    db.test.mockResolvedValue([tick(at - 1000, 98), tick(at + 1000, 104)]);
    const r = await loadResearchData(
      request(true),
      true,
      instruments(true),
      new AbortController().signal,
    );
    expect(db.main).not.toHaveBeenCalled();
    expect(db.test.mock.calls[0][4]).toEqual(["BTC"]);
    expect(r.observations[0]).toMatchObject({
      instrumentId: "testnet:perp:BTC",
      at: at + 1000,
    });
    expect(r.funding[0]).toMatchObject({ at: at + 63, oracle: 98 });
    expect(r.coverage.missingBooks).toBe(29);
  });
  it("reads archive funding marks locally and samples finer L2 observations without inventing depth", async () => {
    db.archive.mockImplementation(async (sql: string) =>
      sql.includes('FROM "MarketTick"')
        ? [tick(at)]
        : sql.includes('FROM "MarketCandle"') ? [] : [0, 10000, 60000].map((delta) => ({
            ts: new Date(at + delta),
            symbol: "BTC-PERP",
            bidsJson: '[{"price":99,"size":3}]',
            asksJson: '[{"price":101,"size":2}]',
          })),
    );
    const r = await loadResearchData(
      { ...request(), source: "archive" },
      false,
      instruments(false),
      new AbortController().signal,
    );
    expect(db.main).not.toHaveBeenCalled();
    expect(db.test).not.toHaveBeenCalled();
    expect(db.archive.mock.calls[0].at(-1)).toBe("BTC");
    expect(db.archive.mock.calls[1].at(-1)).toBe("BTC-PERP");
    expect(r.observations).toHaveLength(2);
    expect(r.funding[0].oracle).toBe(100);
    expect(r.observations[0].depth.levels[0][0]).toEqual({ px: "99", sz: "3" });
    expect(db.disconnect).toHaveBeenCalledOnce();
  });
  it("fails explicitly when ticks have no executable quotes", async () => {
    db.main.mockResolvedValue([
      { ...tick(at), bookBidPx: null, bookAskPx: null },
    ]);
    await expect(
      loadResearchData(
        request(),
        false,
        instruments(false),
        new AbortController().signal,
      ),
    ).rejects.toThrow("candles and marks cannot substitute");
  });
  it("rejects crossed historical books", async () => {
    db.main.mockResolvedValue([{ ...tick(at), bookBidPx: 102 }]);
    await expect(
      loadResearchData(
        request(),
        false,
        instruments(false),
        new AbortController().signal,
      ),
    ).rejects.toThrow("No valid execution observations");
  });
});
