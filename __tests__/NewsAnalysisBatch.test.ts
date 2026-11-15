import { describe, expect, it } from "vitest";
import { batchReady, exactPublication, retryDelay } from "@/lib/news/analysis-batch";

describe("news analysis budget", () => {
    const now = Date.now();
    const news = { availableAt: new Date(now), source: { priority: 1, url: "https://t.me/s/coinnesskr" } };
    it("coalesces busy wires while bounding quiet-feed delay and passing priority alerts", () => {
        expect(batchReady([news], now)).toBe(false);
        expect(batchReady([news], now + 600_000)).toBe(true);
        expect(batchReady(Array(8).fill(news), now)).toBe(true);
        expect(batchReady([{ ...news, source: { priority: 1, url: "https://status.solana.com/history.rss" } }], now)).toBe(true);
    });
    it("only reuses dated exact copies from the same source and attribution", () => {
        const doc = { publishedAt: new Date(now), revisionHash: "exact", sourceId: "wire", author: "author", completeness: "full", mediaLinksJson: "[]" };
        expect(exactPublication({ ...doc })).toBe(exactPublication(doc));
        for (const change of [{ sourceId: "official" }, { author: "other" }, { revisionHash: "edit" }, { publishedAt: new Date(now + 1000) }])
            expect(exactPublication({ ...doc, ...change })).not.toBe(exactPublication(doc));
        expect(exactPublication({ ...doc, publishedAt: null })).toBeNull();
    });
    it("backs off repeated failures and clears the delay after a successful job", () => {
        const failed = { status: "failed", errorCode: "timeout" };
        expect(retryDelay(Array(4).fill(failed))).toBe(1_800_000);
        expect(retryDelay([{ status: "completed", errorCode: null }, failed])).toBe(0);
    });
});
