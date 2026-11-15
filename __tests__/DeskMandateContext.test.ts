// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bookRiskContext, SWING_DESK_MANDATE, DEFAULT_DESK_MANDATE } from "@/lib/desk/mandate";
import { sizeSwingRisk } from "@/lib/desk/risk-sizing";
import { routineOpening } from "@/lib/desk/routine-work";
import { deskRoles, roleInstructions } from "@/lib/desk/roles";
import { DISCRETIONARY_PROFILE } from "@/lib/desk/decision-policy";
import { SWING_PROFILE } from "@/lib/desk/swing";
import { NEWS_STRATEGY_PROFILE } from "@/lib/desk/news-strategy";

describe("current mandate context and preserved host safeguards", () => {
    it("reports configured values without mutating the book or imposing the old two-slot budget", () => {
        const mandate = { ...SWING_DESK_MANDATE, maxConcurrentPositions: 10, maxOpenRiskUsd: 50 };
        const book = { id: "live", version: 13, mandateJson: JSON.stringify(mandate) };
        const before = JSON.stringify(book), result = bookRiskContext(book);
        expect(result).toMatchObject({ source: "current_book_mandate", bookVersion: 13, mandate,
            sizingPolicy: { maxConcurrentPositions: 10, aggregateRiskLimitUsd: 50, costAllowanceBps: 50 } });
        expect(JSON.stringify(book)).toBe(before);
    });
    it("keeps legacy sizing fallbacks separate from omitted operator fields", () => {
        const result = bookRiskContext({ id: "legacy", version: 1, mandateJson: JSON.stringify(DEFAULT_DESK_MANDATE) });
        expect(result.mandate.maxOpenRiskUsd).toBeUndefined();
        expect(result.mandate.maxConcurrentPositions).toBeUndefined();
        expect(result.sizingPolicy).toMatchObject({ aggregateRiskLimitUsd: 30, maxConcurrentPositions: 2, costAllowanceBps: 50 });
    });
    it("preserves the installed capital and sizing leverage caps even above configured defaults", () => {
        const mandate = { ...SWING_DESK_MANDATE, capitalUsd: 2000, maxGrossLeverage: 2, maxOrderUsd: 2000, maxInstrumentUsd: 2000, maxRiskPerTradeUsd: 1000, maxOpenRiskUsd: 1000 };
        const context = bookRiskContext({ id: "larger", version: 2, mandateJson: JSON.stringify(mandate) });
        const sized = sizeSwingRisk({ entry: 100, stop: 99, side: "buy", equityUsd: 3000, committedUsd: 0, openRiskUsd: 0, instrumentUsd: 0, depthUsd: 10000, szDecimals: 2, mandate });
        expect(context.mandate.capitalUsd).toBe(2000);
        expect(context.sizingPolicy).toMatchObject({ capitalCeilingUsd: 1245, maxGrossLeverage: 1 });
        expect(sized.usableCapitalUsd).toBe(1245);
        expect(sized.notionalUsd).toBeLessThanOrEqual(1245);
    });
    it.each(deskRoles)("gives %s the current risk context in routine work and no copied dollar instruction", role => {
        const riskPolicy = bookRiskContext({ id: "live", version: 13, mandateJson: JSON.stringify({ ...SWING_DESK_MANDATE, maxOpenRiskUsd: 50, maxConcurrentPositions: 10 }) });
        const brief = routineOpening({ mandate: riskPolicy.mandate, riskPolicy, triggers: [{ kind: "watch", payload: { role } }] }, role);
        expect(brief).toMatchObject({ riskPolicy, mandate: { maxOpenRiskUsd: 50, maxConcurrentPositions: 10 } });
        const instructions = roleInstructions(role, { live: true, consult: false });
        expect(instructions).toContain("current book mandate");
        expect(instructions).not.toMatch(/1245|6\.225|12\.45|24\.9/);
    });
    it("keeps strategy descriptions free of independent copied risk allowances", () => {
        for (const profile of [DISCRETIONARY_PROFILE, SWING_PROFILE, NEWS_STRATEGY_PROFILE]) {
            expect(profile).not.toHaveProperty("aggregateOpenRiskUsd");
            expect(profile).not.toHaveProperty("riskPerTradeUsd");
            expect(profile).not.toHaveProperty("capitalCeilingUsd");
        }
        expect(NEWS_STRATEGY_PROFILE.activationSupported).toBe(false);
    });
});
