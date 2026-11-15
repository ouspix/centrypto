// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeskBook } from "@prisma/client";
import { exchangeHttpError } from "@/lib/desk/exchange-error";
import { decimalPrice } from "@/lib/desk/venue-price";
import { hyperliquidDeskVenue } from "@/lib/desk/venue";

vi.mock("@/lib/hyperliquid-api-wallet", () => ({
    getUserHyperliquidApiWalletCredential: async () => ({ privateKey: "0x" + "1".repeat(64) }),
}));
vi.mock("@nktkas/hyperliquid/signing", () => ({ signL1Action: async () => ({ r: "fake", s: "fake", v: 27 }) }));
afterEach(() => { vi.unstubAllGlobals(); });

describe("exchange wire values and diagnostics", () => {
    it("preserves approved decimal prices and quantities without binary tails or exponents", () => {
        expect([560.3, 570.56, 0.467, 1e-8, 1e21].map(decimalPrice))
            .toEqual(["560.3", "570.56", "0.467", "0.00000001", "1000000000000000000000"]);
    });
    it("keeps the HTTP code and venue explanation while redacting credentials", () => {
        const error = exchangeHttpError("exchange", 422,
            'Failed to deserialize JSON\n{"signature":{"r":"0x' + "a".repeat(64) +
            '","s":"secret"},"apiKey":"sensitive"} Bearer token');
        expect(error.message).toContain("HTTP 422: Failed to deserialize JSON");
        expect(error.message).not.toMatch(/sensitive|secret|Bearer token|0xaaaa/);
        expect(error.message).not.toContain("Venue rejection:");
        expect(exchangeHttpError("exchange", 503, "x".repeat(2000)).message.length).toBeLessThan(650);
    });
    it("preserves exchange response bodies and never retries an HTTP failure", async () => {
        const fetch = vi.fn().mockResolvedValue(new Response("Failed to deserialize JSON body: invalid decimal", { status: 422 }));
        vi.stubGlobal("fetch", fetch);
        const book = { ownerAddress: "0xowner", accountAddress: "0xowner", kind: "directional", isTestnet: true } as DeskBook;
        const dispatched = vi.fn();
        await expect(hyperliquidDeskVenue.write(book, { type: "order", orders: [], grouping: "na" },
            Date.now(), async () => {}, dispatched)).rejects.toThrow("Exchange exchange HTTP 422: Failed to deserialize JSON body: invalid decimal");
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(dispatched).toHaveBeenCalledTimes(1);
    });
});
