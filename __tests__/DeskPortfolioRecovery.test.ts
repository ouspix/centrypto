// @vitest-environment node
import { describe, expect, it } from "vitest";
import { recoverPortfolioComparisons } from "@/lib/desk/portfolio-recovery";
describe("historical portfolio journal recovery", () => {
    it("recovers distinct acknowledged holdings, last write per holding, with original times and provenance", () => {
        const at = new Date("2026-11-12T22:00Z");
        const calls = ["A", "B", "A", "C", "D"].map((holdingInstrumentId, i) => ({ id: i+1, key: `call:${i}`, bookId: "book", shiftId: "shift", role: "lead", createdAt: at,
            dataJson: JSON.stringify({ name: i === 1 ? "record_candidate_comparison" : "record_portfolio_comparison",
                args: i === 1 ? { portfolioChoice: { holdingInstrumentId, choice: "hold" } } : { holdingInstrumentId, choice: "exit_to_cash", reason: String(i) } }) }));
        const receipts = new Map(calls.slice(0, 4).map((c, i) => [c.key + ":result", { id: i+10, createdAt: at, data: i === 3 ? { error: "Validation failed" } : { portfolioRecorded: true } }]));
        const contexts = new Map([["shift", { bookVersion: 14, mode: "live", portfolio: { holdings: [] } }]]);
        const r = recoverPortfolioComparisons(calls, receipts, contexts);
        expect(r).toHaveLength(2); expect(r.map(x => x.key)).toEqual(["portfolio-comparison:shift:lead:A", "portfolio-comparison:shift:lead:B"]);
        expect(JSON.parse(r[0].dataJson)).toMatchObject({ reason: "2", recovery: { toolRecordId: 3, historical: true }, bookVersion: 14 });
        expect(r.every(x => +x.createdAt === +at)).toBe(true);
        expect(recoverPortfolioComparisons(calls, receipts, new Map())).toEqual([]);
        expect(recoverPortfolioComparisons(calls, receipts, contexts)).toEqual(r);
    });
});
