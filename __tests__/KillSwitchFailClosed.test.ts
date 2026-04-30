import { beforeEach, describe, expect, it, vi } from "vitest";

describe("wallet kill-switch fail-closed behavior", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
    });

    it("blocks production execution when WalletRiskControl model is unavailable", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.doMock("@/lib/db", () => ({ prisma: {} }));

        const { assertWalletExecutionAllowed } = await import("@/lib/risk/execution-safety");

        await expect(assertWalletExecutionAllowed("0x1234567890abcdef1234567890abcdef12345678", false))
            .rejects.toThrow(/WalletRiskControl Prisma model is unavailable/i);
    });

    it("blocks production execution when kill-switch lookup fails", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.doMock("@/lib/db", () => ({
            prisma: {
                walletRiskControl: {
                    findUnique: vi.fn().mockRejectedValue(new Error("database unavailable"))
                }
            }
        }));

        const { assertWalletExecutionAllowed } = await import("@/lib/risk/execution-safety");

        await expect(assertWalletExecutionAllowed("0x1234567890abcdef1234567890abcdef12345678", false))
            .rejects.toThrow(/kill-switch lookup failed/i);
    });
});
