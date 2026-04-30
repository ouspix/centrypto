import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearHyperliquidLimiterState,
    hyperliquidExchangePost,
    hyperliquidInfoPost
} from "@/lib/rate-limit/hyperliquid-limiter";

describe("Hyperliquid limiter", () => {
    beforeEach(() => {
        clearHyperliquidLimiterState();
        process.env.HL_MIN_DELAY_MS = "0";
        process.env.HL_RETRY_BASE_MS = "1";
        process.env.HL_RETRY_CAP_MS = "2";
        global.fetch = vi.fn();
    });

    it("coalesces identical metadata requests", async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ universe: [] })
        });

        const [a, b] = await Promise.all([
            hyperliquidInfoPost("hl:info:meta", "https://example.test/info", { type: "meta" }, { ttlMs: 1000 }),
            hyperliquidInfoPost("hl:info:meta", "https://example.test/info", { type: "meta" }, { ttlMs: 1000 })
        ]);

        expect(a).toEqual({ universe: [] });
        expect(b).toEqual({ universe: [] });
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("retries 429s for safe info reads", async () => {
        (global.fetch as any)
            .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "rate" })
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });

        await expect(hyperliquidInfoPost("hl:info:meta", "https://example.test/info", { type: "meta" })).resolves.toEqual({ ok: true });
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("serves stale safe reads when refresh fails", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ universe: [{ name: "BTC" }] })
        });

        await hyperliquidInfoPost("hl:info:meta", "https://example.test/info", { type: "meta" }, { ttlMs: 10, staleMs: 1000, allowStale: true });
        vi.setSystemTime(new Date("2026-04-30T00:00:00.020Z"));
        (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });

        await expect(hyperliquidInfoPost("hl:info:meta", "https://example.test/info", { type: "meta" }, { ttlMs: 10, staleMs: 1000, allowStale: true }))
            .resolves.toEqual({ universe: [{ name: "BTC" }] });
        vi.useRealTimers();
    });

    it("does not blindly retry exchange order placement", async () => {
        (global.fetch as any).mockResolvedValue({ ok: false, status: 429, text: async () => "rate" });

        await expect(hyperliquidExchangePost("hl:exchange:order", "https://example.test/exchange", { action: "order" }, { walletKey: "0xabc" }))
            .rejects.toThrow(/rate limited/i);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});
