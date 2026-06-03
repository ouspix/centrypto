import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutoTraderService } from "@/services/AutoTraderService";

const autoTraderSettingsMock = vi.hoisted(() => ({
    upsert: vi.fn(),
    findUnique: vi.fn()
}));

vi.mock("@/lib/db", () => ({
    prisma: {
        autoTraderSettings: autoTraderSettingsMock,
        autoTraderRun: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 })
        }
    }
}));

vi.mock("@/services/CollectorRunner", () => ({
    ensureCollectorReady: vi.fn().mockResolvedValue(undefined)
}));

function settingsRecord(overrides: Record<string, any> = {}) {
    return {
        id: "settings-1",
        userAddress: "0x00000000000000000000000000000000000000ab",
        isTestnet: true,
        enabled: true,
        frequencySeconds: 600,
        model: "test-model",
        config: null,
        lastRunAt: null,
        nextRunAt: null,
        lastStatus: "configured",
        lastError: null,
        createdAt: new Date("2026-06-02T10:00:00Z"),
        updatedAt: new Date("2026-06-02T10:00:00Z"),
        ...overrides
    };
}

describe("AutoTraderService config persistence", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        autoTraderSettingsMock.upsert.mockImplementation(({ update }) => {
            return Promise.resolve(settingsRecord({
                enabled: update.enabled,
                frequencySeconds: update.frequencySeconds,
                model: update.model,
                config: update.config,
                nextRunAt: update.nextRunAt
            }));
        });
    });

    it("persists Discovery Balanced screener fields in AutoTraderSettings.config", async () => {
        const status = await AutoTraderService.getInstance().configure(
            "0x00000000000000000000000000000000000000ab",
            true,
            {
                enabled: true,
                frequencySeconds: 600,
                model: "test-model",
                configOverride: {
                    screenerPresetName: "Discovery Balanced"
                }
            }
        );
        const persisted = JSON.parse(autoTraderSettingsMock.upsert.mock.calls[0][0].update.config);

        expect(persisted.screener.discoveryMaxSymbols).toBe(40);
        expect(persisted.screener.hotMoverTopN).toBe(12);
        expect(persisted.screener.includeExecutionBlockedForDiagnostics).toBe(true);
        expect(status.activeScreenerSummary!.discoveryMaxSymbols).toBe(40);
    });

    it("reloads status with activeScreenerSummary from persisted config", async () => {
        autoTraderSettingsMock.findUnique.mockResolvedValue(settingsRecord({
            config: JSON.stringify({
                screenerPresetName: "Discovery Balanced"
            })
        }));

        const status = await AutoTraderService.getInstance().getStatus(
            "0x00000000000000000000000000000000000000ab",
            true
        );

        expect(status.configOverride!.screener.discoveryMaxSymbols).toBe(40);
        expect(status.activeScreenerSummary!.discoveryMaxSymbols).toBe(40);
        expect(status.activeScreenerSummary!.hotMoverTopN).toBe(12);
    });
});
