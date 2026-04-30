import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import { marketDbMain } from "@/lib/market-db";

type CompareOutput = {
    summaries: Array<{
        source: "live_db" | "s3_archive";
        snapshots: number;
        avgUniverse: number;
        avgActivity: number;
        avgLiquidity: number;
        avgRanked: number;
        selectedCounts: Record<string, number>;
        avgRank: Record<string, number>;
    }>;
    comparison: {
        sharedSnapshots: number;
        avgTopOverlap: number;
        sampleChanges: unknown[];
    };
};

describe("mainnet screener simulation", () => {
    it("replays the April 11 04:00 mainnet hour without live L2 and ranks BTC like the S3 backtest feed", async () => {
        const start = new Date("2026-04-11T04:00:00Z");
        const end = new Date("2026-04-11T04:59:50Z");
        const [tickCount, candleCount] = await Promise.all([
            marketDbMain.marketTick.count({ where: { symbol: "BTC", ts: { gte: start, lte: end } } }),
            marketDbMain.marketCandle.count({ where: { symbol: "BTC", timeframe: "1m", openTime: { gte: start, lte: end } } })
        ]);

        if (tickCount < 60 || candleCount < 60) {
            console.warn(
                "[mainnet screener simulation] Skipping: md_main.db is missing the April 11 BTC one-hour backfill. " +
                "Run scripts/tmp_backfill_main_from_backtest_hour.ts first."
            );
            return;
        }

        const output = execFileSync("npx", [
            "tsx",
            "-r",
            "dotenv/config",
            "scripts/compare_screener_live_vs_s3.ts",
            "--start", "2026-04-11T04:00:00Z",
            "--end", "2026-04-11T04:59:50Z",
            "--interval-seconds", "10",
            "--top", "6",
            "--db", "prisma/backtest.db",
            "--hydrate", "false",
            "--symbols", "BTC",
            "--screening", "Swing Relaxed",
            "--disable-liquidity", "true",
            "--min-realized-vol", "0",
            "--min-recent-volume", "0"
        ], {
            cwd: process.cwd(),
            env: { ...process.env, DOTENV_CONFIG_PATH: ".env.local" },
            encoding: "utf8"
        });

        const result = JSON.parse(output) as CompareOutput;
        const live = result.summaries.find(summary => summary.source === "live_db");
        const s3 = result.summaries.find(summary => summary.source === "s3_archive");

        expect(live).toBeDefined();
        expect(s3).toBeDefined();
        expect(live!.snapshots).toBe(360);
        expect(s3!.snapshots).toBe(360);
        expect(live!.avgRanked).toBe(1);
        expect(s3!.avgRanked).toBe(1);
        expect(live!.selectedCounts.BTC).toBe(360);
        expect(s3!.selectedCounts.BTC).toBe(360);
        expect(live!.avgRank.BTC).toBe(1);
        expect(s3!.avgRank.BTC).toBe(1);
        expect(result.comparison.sharedSnapshots).toBe(360);
        expect(result.comparison.avgTopOverlap).toBe(1);
        expect(result.comparison.sampleChanges).toEqual([]);
    });
});
