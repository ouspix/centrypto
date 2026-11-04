import { prisma } from "@/lib/db";
import { normalizeWalletAddress } from "@/lib/auth/wallet-session";
import { buildActiveScreenerSummary, normalizeAutoTraderConfigOverride } from "@/lib/auto-trader-config";
import {
    candidatePromotionRulesEqual,
    candidatePromotionRulesHash,
    normalizeCandidatePromotionConfig,
    withCandidatePromotionEpoch
} from "@/lib/candidate-promotion";
import { validateLivePriorBuckets } from "@/lib/candidate-promotion-priors";
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
        await this.finalizeStaleRuns(new Date(Date.now() - 15 * 60_000));
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
        const existing = await this.findSettings(normalizedUser, isTestnet);
        const existingConfig = existing
            ? normalizeAutoTraderConfigOverride(parseConfig(existing.config))
            : undefined;
        const configOverride = normalizeAutoTraderConfigOverride(input.configOverride);
        const existingPromotion = normalizeCandidatePromotionConfig(existingConfig?.candidate_promotion);
        const incomingPromotion = normalizeCandidatePromotionConfig(configOverride.candidate_promotion);
        const promotionEpoch = existing && candidatePromotionRulesEqual(existingPromotion, incomingPromotion)
            ? existingPromotion.config_epoch ?? null
            : new Date().toISOString();
        configOverride.candidate_promotion = withCandidatePromotionEpoch(incomingPromotion, promotionEpoch);
        await validateLivePriorBuckets(configOverride.candidate_promotion);
        const config = JSON.stringify(configOverride);
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
                normalizeAutoTraderConfigOverride(parseConfig(settings.config))
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
        await this.finalizeStaleRuns(staleRunningBefore, settings.userAddress, settings.isTestnet);
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

    private async finalizeStaleRuns(staleBefore: Date, userAddress?: string, isTestnet?: boolean): Promise<void> {
        const model = (prisma as any).autoTraderRun;
        if (!model?.updateMany) return;
        await model.updateMany({
            where: {
                status: "RUNNING",
                startedAt: { lt: staleBefore },
                ...(userAddress ? { accountAddress: normalizeWalletAddress(userAddress) } : {}),
                ...(isTestnet === undefined ? {} : { network: isTestnet ? "testnet" : "mainnet" })
            },
            data: {
                status: "FAILED",
                error: "stale running auto-trader run finalized during scheduler claim",
                finishedAt: new Date(),
                updatedAt: new Date()
            }
        });
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
        const configOverride = settings
            ? normalizeAutoTraderConfigOverride(parseConfig(settings.config))
            : undefined;
        return {
            configured: !!settings,
            enabled: !!settings?.enabled,
            running,
            userAddress: settings?.userAddress ?? null,
            isTestnet: settings?.isTestnet ?? null,
            frequencySeconds: settings?.frequencySeconds ?? 600,
            model: settings?.model ?? DEFAULT_MODEL,
            configOverride,
            configPresetName: configOverride?.preset_name ?? configOverride?.profileName ?? configOverride?.preset ?? null,
            activeScreenerSummary: settings ? buildActiveScreenerSummary(configOverride) : null,
            activeCandidatePromotionSummary: settings ? buildActiveCandidatePromotionSummary(configOverride?.candidate_promotion) : null,
            config_epoch: configOverride?.candidate_promotion?.config_epoch ?? null,
            candidatePromotionRulesHash: configOverride?.candidate_promotion
                ? candidatePromotionRulesHash(configOverride.candidate_promotion)
                : null,
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

function buildActiveCandidatePromotionSummary(config?: unknown) {
    const normalized = normalizeCandidatePromotionConfig(config);
    const priorStatuses = Object.values(normalized.prior_buckets).map(bucket => bucket.status);
    const overrides = Object.values(normalized.playbook_overrides);
    const globalRules = normalized.global_structure_rules;
    const demotionRuleCount = [
        globalRules.lateChase !== "ALLOW",
        globalRules.extendedBreakoutWithoutPullback !== "ALLOW",
        ...overrides.map(override => override.action !== "enabled")
    ].filter(Boolean).length;

    return {
        rules: normalized,
        config_epoch: normalized.config_epoch ?? null,
        rules_hash: candidatePromotionRulesHash(normalized),
        live_prior_bucket_count: priorStatuses.filter(status => status === "LIVE").length,
        shadow_prior_bucket_count: priorStatuses.filter(status => status === "SHADOW").length,
        demotion_rule_count: demotionRuleCount
    };
}
