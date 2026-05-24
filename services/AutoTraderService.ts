import { prisma } from "@/lib/db";
import { normalizeWalletAddress } from "@/lib/auth/wallet-session";
import { ensureCollectorReady } from "@/services/CollectorRunner";
import { OrchestratorService } from "@/services/OrchestratorService";

type AutoTraderRecord = {
    id: string;
    userAddress: string;
    isTestnet: boolean;
    enabled: boolean;
    frequencySeconds: number;
    model: string;
    config: string | null;
    lastRunAt: Date | null;
    nextRunAt: Date | null;
    lastStatus: string | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
};

type ConfigureAutoTraderInput = {
    enabled: boolean;
    frequencySeconds: number;
    model: string;
    configOverride?: unknown;
};

type RuntimeState = {
    running: Set<string>;
    bootstrapped: boolean;
};

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v3.2-exp";
const MIN_FREQUENCY_SECONDS = 60;

const globalForAutoTrader = globalThis as unknown as {
    __centryptoAutoTrader?: RuntimeState;
};

const runtime = globalForAutoTrader.__centryptoAutoTrader ?? {
    running: new Set<string>(),
    bootstrapped: false
};
globalForAutoTrader.__centryptoAutoTrader = runtime;

export class AutoTraderService {
    private static instance: AutoTraderService;

    public static getInstance(): AutoTraderService {
        if (!AutoTraderService.instance) {
            AutoTraderService.instance = new AutoTraderService();
        }
        return AutoTraderService.instance;
    }

    public async bootstrapEnabled(): Promise<void> {
        if (runtime.bootstrapped) return;
        runtime.bootstrapped = true;
    }

    public async getStatus(userAddress: string, isTestnet: boolean) {
        await this.bootstrapEnabled();
        const normalizedUser = normalizeWalletAddress(userAddress);
        const settings = await this.findSettings(normalizedUser, isTestnet);
        return this.toStatus(settings, this.isRunning(normalizedUser, isTestnet));
    }

    public async configure(userAddress: string, isTestnet: boolean, input: ConfigureAutoTraderInput) {
        await this.bootstrapEnabled();
        const normalizedUser = normalizeWalletAddress(userAddress);
        const frequencySeconds = Math.max(MIN_FREQUENCY_SECONDS, Math.floor(Number(input.frequencySeconds) || 600));
        const model = String(input.model || DEFAULT_MODEL);
        const config = input.configOverride === undefined ? null : JSON.stringify(input.configOverride);
        const now = new Date();

        const settings = await autoTraderModel().upsert({
            where: { userAddress_isTestnet: { userAddress: normalizedUser, isTestnet } },
            update: {
                enabled: !!input.enabled,
                frequencySeconds,
                model,
                config,
                nextRunAt: input.enabled ? now : null,
                lastError: input.enabled ? null : undefined
            },
            create: {
                userAddress: normalizedUser,
                isTestnet,
                enabled: !!input.enabled,
                frequencySeconds,
                model,
                config,
                nextRunAt: input.enabled ? now : null,
                lastStatus: "configured"
            }
        });

        return this.toStatus(settings, this.isRunning(normalizedUser, isTestnet));
    }

    public async runDueOnce(): Promise<void> {
        await this.bootstrapEnabled();
        const due = await autoTraderModel().findMany({
            where: {
                enabled: true,
                OR: [
                    { nextRunAt: null },
                    { nextRunAt: { lte: new Date() } }
                ]
            }
        });
        await Promise.all((due as AutoTraderRecord[]).map(settings => this.runSettings(settings)));
    }

    private async runSettings(settings: AutoTraderRecord): Promise<void> {
        const key = this.key(settings.userAddress, settings.isTestnet);
        if (runtime.running.has(key)) return;

        runtime.running.add(key);
        try {
            const claimed = await this.claimSettings(settings);
            if (!claimed) return;

            await ensureCollectorReady(settings.isTestnet);
            const result = await OrchestratorService.getInstance().runAutonomousTraderCycle(
                settings.userAddress,
                settings.model,
                settings.isTestnet,
                parseConfig(settings.config)
            );
            const nextRunAt = new Date(Date.now() + settings.frequencySeconds * 1000);
            const updated = await autoTraderModel().update({
                where: { id: settings.id },
                data: {
                    lastRunAt: new Date(),
                    nextRunAt,
                    lastStatus: result.llmStatus?.status === "skipped" ? "skipped" : "completed",
                    lastError: null
                }
            });
        } catch (error) {
            const nextRunAt = new Date(Date.now() + settings.frequencySeconds * 1000);
            await autoTraderModel().update({
                where: { id: settings.id },
                data: {
                    lastRunAt: new Date(),
                    nextRunAt,
                    lastStatus: "failed",
                    lastError: error instanceof Error ? error.message : String(error)
                }
            });
        } finally {
            runtime.running.delete(key);
        }
    }

    private async claimSettings(settings: AutoTraderRecord): Promise<boolean> {
        const now = new Date();
        const staleRunningBefore = new Date(Date.now() - Math.max(300, settings.frequencySeconds * 2) * 1000);
        const result = await autoTraderModel().updateMany({
            where: {
                id: settings.id,
                enabled: true,
                AND: [
                    {
                        OR: [
                            { nextRunAt: null },
                            { nextRunAt: { lte: now } }
                        ]
                    },
                    {
                        OR: [
                            { lastStatus: null },
                            { lastStatus: { not: "running" } },
                            { updatedAt: { lt: staleRunningBefore } }
                        ]
                    }
                ]
            },
            data: {
                lastStatus: "running",
                lastError: null
            }
        });
        return result.count === 1;
    }

    private async findSettings(userAddress: string, isTestnet: boolean): Promise<AutoTraderRecord | null> {
        return autoTraderModel().findUnique({
            where: { userAddress_isTestnet: { userAddress, isTestnet } }
        });
    }

    private isRunning(userAddress: string, isTestnet: boolean): boolean {
        return runtime.running.has(this.key(userAddress, isTestnet));
    }

    private key(userAddress: string, isTestnet: boolean): string {
        return `${normalizeWalletAddress(userAddress)}:${isTestnet ? "testnet" : "mainnet"}`;
    }

    private toStatus(settings: AutoTraderRecord | null, running: boolean) {
        return {
            configured: !!settings,
            enabled: !!settings?.enabled,
            running,
            userAddress: settings?.userAddress ?? null,
            isTestnet: settings?.isTestnet ?? null,
            frequencySeconds: settings?.frequencySeconds ?? 600,
            model: settings?.model ?? DEFAULT_MODEL,
            lastRunAt: settings?.lastRunAt?.toISOString() ?? null,
            nextRunAt: settings?.nextRunAt?.toISOString() ?? null,
            lastStatus: settings?.lastStatus ?? null,
            lastError: settings?.lastError ?? null,
            updatedAt: settings?.updatedAt?.toISOString() ?? null
        };
    }
}

function autoTraderModel() {
    const model = (prisma as any).autoTraderSettings;
    if (!model) {
        throw new Error("AutoTraderSettings Prisma model is unavailable; run npm run prisma:generate");
    }
    return model;
}

function parseConfig(config: string | null): unknown {
    if (!config) return undefined;
    try {
        return JSON.parse(config);
    } catch {
        return undefined;
    }
}
