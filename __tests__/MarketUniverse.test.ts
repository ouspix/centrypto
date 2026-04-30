import { describe, expect, it } from "vitest";
import { activeMarketAssets, buildMarketTickRow, prioritizeBackfillSymbols } from "@/services/MarketUniverse";

describe("MarketUniverse", () => {
    it("filters delisted Hyperliquid assets out of backfill universes", () => {
        const active = activeMarketAssets([
            { name: "BTC" },
            { name: "MATIC", isDelisted: true },
            { name: "ETH", isDelisted: false },
            { name: "" }
        ], [
            { markPx: "100" },
            { markPx: "1" },
            { markPx: "200" },
            { markPx: "0" }
        ]);

        expect(active.map(({ asset }) => asset.name)).toEqual(["BTC", "ETH"]);
    });

    it("builds a usable tick row from asset context data", () => {
        const ts = new Date("2026-04-30T00:00:00.000Z");
        const row = buildMarketTickRow("BTC", {
            markPx: "75000",
            openInterest: "2",
            funding: "0.0001",
            dayNtlVlm: "1000000"
        }, ts);

        expect(row).toEqual({
            ts,
            symbol: "BTC",
            markPrice: 75000,
            indexPrice: 75000,
            openInterest: 150000,
            fundingRate: 0.0001,
            volume24h: 1000000
        });
    });

    it("puts explicit priorities first and fills the rest from ranked volume order", () => {
        const plan = prioritizeBackfillSymbols(
            ["HYPE", "PUMP", "BTC", "ETH", "SOL", "DOGE"],
            ["BTC", "ETH", "SOL", "LINK"],
            5
        );

        expect(plan.prioritySymbols).toEqual(["BTC", "ETH", "SOL", "HYPE", "PUMP"]);
        expect(plan.remainingSymbols).toEqual(["DOGE"]);
    });
});
