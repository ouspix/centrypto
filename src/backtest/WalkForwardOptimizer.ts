import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { Worker } from "worker_threads";
import { AgentConfig, AGENT_PRESETS, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { SCREENER_PRESETS, ScreenerConfig } from "@/lib/screener-config";
import { BacktestRunner } from "./BacktestRunner";
import { BacktestMetrics, BacktestRunConfig, CoverageReport, SimTrade } from "./BacktestTypes";

export const PARAM_RANGES = {
    mean_reversion: {
        ret_sigma_threshold: [1.5, 3.5],
        book_pressure_min: [0.0, 0.12]
    },
    momentum: {
        vol_ratio_min: [0.5, 1.5],
        book_pressure_min: [0.02, 0.20]
    },
    breakout: {
        vol_ratio_min: [1.0, 2.5],
        book_pressure_min: [0.05, 0.30]
    },
    cost_sanity: {
        min_edge_to_cost_mult: [3.0, 8.0],
        min_stop_to_cost_mult: [1.2, 3.0],
        min_tp_to_cost_mult: [2.0, 5.0]
    },
    screener: {
        maxSpreadBps: [8, 35],
        minDepthUsd: [0, 100_000],
        maxCostBps: [10, 60],
        minRecentVolume: [0, 25_000],
        recentVolumeMinutes: [5, 30],
        minRealizedVol: [0, 0.0015],
        minVolume24h: [0, 15_000_000],
        qualityWeight: [0.5, 2.5]
    },
    management_policy: {
        hold_confidence: [0.45, 0.65],
        close_confidence: [0.55, 0.85],
        momentum_opposite_pressure_threshold: [0.04, 0.14],
        momentum_opposite_pressure_cycles: [2, 5],
        momentum_unprofitable_max_age_minutes: [90, 240],
        breakout_opposite_pressure_threshold: [0.04, 0.14],
        breakout_unprofitable_max_age_minutes: [45, 150],
        mean_reversion_sigma_worsening_threshold: [0.5, 2.0],
        mean_reversion_opposite_pressure_threshold: [0.02, 0.10],
        mean_reversion_unprofitable_max_age_minutes: [20, 90],
        fallback_opposite_pressure_threshold: [0.01, 0.08],
        fallback_unprofitable_max_age_minutes: [15, 75]
    }
} as const;

export type OptimizerScoreGates = {
    minTrades: number;
    maxDrawdownBps: number;
    minProfitFactor: number;
    maxStopHitRate: number;
    maxSymbolConcentration: number;
    maxRegimeConcentration: number;
    allowSyntheticCandles: boolean;
};

export type OptimizerMode = "random" | "adaptive";

export type OptimizerParamSchema = {
    target: "agent" | "screener";
    path: string;
    type: "float" | "int" | "bool" | "enum";
    min?: number;
    max?: number;
    values?: Array<string | number | boolean>;
    mutateScale: number;
};

export type AdaptiveOptimizerOptions = OptimizerRunOptions & {
    explorationTrials: number;
    generationTrials: number;
    generations: number;
    eliteCount: number;
    nearMissCount: number;
    noiseDecay: number;
    initialNoiseScale: number;
    finalists: number;
    successiveHalving: boolean;
    halvingKeepRatio: number;
    sliceCount: number;
    outputDir?: string;
};

export type OptimizerGenerationSummary = {
    generation: number;
    candidate_count: number;
    evaluated_count: number;
    cheap_evaluation_count: number;
    full_evaluation_count: number;
    accepted_count: number;
    rejected_count: number;
    elite_config_hashes: string[];
    near_miss_config_hashes: string[];
    rejection_counts: Record<string, number>;
    score_distribution: DistributionSummary;
    trade_count_distribution: DistributionSummary;
};

export type OptimizerTrace = {
    mode: OptimizerMode;
    generation_summaries: OptimizerGenerationSummary[];
    elite_config_hashes: string[];
    near_miss_config_hashes: string[];
    rejection_counts: Record<string, number>;
    score_distribution: DistributionSummary;
    trade_count_distribution: DistributionSummary;
};

export const DEFAULT_OPTIMIZER_SCORE_GATES: OptimizerScoreGates = {
    minTrades: 30,
    maxDrawdownBps: 2_000,
    minProfitFactor: 1.0,
    maxStopHitRate: 0.60,
    maxSymbolConcentration: 0.35,
    maxRegimeConcentration: 0.70,
    allowSyntheticCandles: false
};

export const DEFAULT_ADAPTIVE_OPTIMIZER_OPTIONS: AdaptiveOptimizerOptions = {
    explorationTrials: 80,
    generationTrials: 40,
    generations: 4,
    eliteCount: 8,
    nearMissCount: 8,
    noiseDecay: 0.65,
    initialNoiseScale: 0.35,
    finalists: 20,
    successiveHalving: true,
    halvingKeepRatio: 0.35,
    sliceCount: 4,
    concurrency: 1
};

export type ScoredConfig = {
    config_hash: string;
    agentConfig: AgentConfig;
    screenerConfig: ScreenerConfig;
    metrics: BacktestMetrics;
    score: number;
    coverage: CoverageReport;
    rejected: boolean;
    rejection_reason?: string;
    fold_count?: number;
    fold_scores?: number[];
    fold_rejection_reasons?: string[];
};

export type OptimizerProgress = {
    completed: number;
    total: number;
    trialIndex: number;
    result: ScoredConfig;
};

export type OptimizerRunOptions = {
    concurrency?: number;
    onProgress?: (progress: OptimizerProgress) => void;
};

export type CandidateConfigPair = {
    agentConfig: AgentConfig;
    screenerConfig: ScreenerConfig;
};

export const PARAM_SCHEMA: OptimizerParamSchema[] = [
    { target: "agent", path: "triggers.mean_reversion.ret_sigma_threshold", type: "float", min: PARAM_RANGES.mean_reversion.ret_sigma_threshold[0], max: PARAM_RANGES.mean_reversion.ret_sigma_threshold[1], mutateScale: 0.20 },
    { target: "agent", path: "triggers.mean_reversion.book_pressure_min", type: "float", min: PARAM_RANGES.mean_reversion.book_pressure_min[0], max: PARAM_RANGES.mean_reversion.book_pressure_min[1], mutateScale: 0.20 },
    { target: "agent", path: "triggers.momentum.vol_ratio_min", type: "float", min: PARAM_RANGES.momentum.vol_ratio_min[0], max: PARAM_RANGES.momentum.vol_ratio_min[1], mutateScale: 0.20 },
    { target: "agent", path: "triggers.momentum.book_pressure_min", type: "float", min: PARAM_RANGES.momentum.book_pressure_min[0], max: PARAM_RANGES.momentum.book_pressure_min[1], mutateScale: 0.20 },
    { target: "agent", path: "triggers.breakout.vol_ratio_min", type: "float", min: PARAM_RANGES.breakout.vol_ratio_min[0], max: PARAM_RANGES.breakout.vol_ratio_min[1], mutateScale: 0.20 },
    { target: "agent", path: "triggers.breakout.book_pressure_min", type: "float", min: PARAM_RANGES.breakout.book_pressure_min[0], max: PARAM_RANGES.breakout.book_pressure_min[1], mutateScale: 0.20 },
    { target: "agent", path: "cost_sanity.min_edge_to_cost_mult", type: "float", min: PARAM_RANGES.cost_sanity.min_edge_to_cost_mult[0], max: PARAM_RANGES.cost_sanity.min_edge_to_cost_mult[1], mutateScale: 0.18 },
    { target: "agent", path: "cost_sanity.min_stop_to_cost_mult", type: "float", min: PARAM_RANGES.cost_sanity.min_stop_to_cost_mult[0], max: PARAM_RANGES.cost_sanity.min_stop_to_cost_mult[1], mutateScale: 0.18 },
    { target: "agent", path: "cost_sanity.min_tp_to_cost_mult", type: "float", min: PARAM_RANGES.cost_sanity.min_tp_to_cost_mult[0], max: PARAM_RANGES.cost_sanity.min_tp_to_cost_mult[1], mutateScale: 0.18 },
    { target: "agent", path: "management_policy.hold_confidence", type: "float", min: PARAM_RANGES.management_policy.hold_confidence[0], max: PARAM_RANGES.management_policy.hold_confidence[1], mutateScale: 0.18 },
    { target: "agent", path: "management_policy.close_confidence", type: "float", min: PARAM_RANGES.management_policy.close_confidence[0], max: PARAM_RANGES.management_policy.close_confidence[1], mutateScale: 0.18 },
    { target: "agent", path: "management_policy.playbook_aware.momentum.opposite_pressure_threshold", type: "float", min: PARAM_RANGES.management_policy.momentum_opposite_pressure_threshold[0], max: PARAM_RANGES.management_policy.momentum_opposite_pressure_threshold[1], mutateScale: 0.20 },
    { target: "agent", path: "management_policy.playbook_aware.momentum.opposite_pressure_cycles", type: "int", min: PARAM_RANGES.management_policy.momentum_opposite_pressure_cycles[0], max: PARAM_RANGES.management_policy.momentum_opposite_pressure_cycles[1], mutateScale: 0.35 },
    { target: "agent", path: "management_policy.playbook_aware.momentum.unprofitable_max_age_minutes", type: "int", min: PARAM_RANGES.management_policy.momentum_unprofitable_max_age_minutes[0], max: PARAM_RANGES.management_policy.momentum_unprofitable_max_age_minutes[1], mutateScale: 0.20 },
    { target: "agent", path: "management_policy.playbook_aware.breakout.opposite_pressure_threshold", type: "float", min: PARAM_RANGES.management_policy.breakout_opposite_pressure_threshold[0], max: PARAM_RANGES.management_policy.breakout_opposite_pressure_threshold[1], mutateScale: 0.20 },
    { target: "agent", path: "management_policy.playbook_aware.breakout.unprofitable_max_age_minutes", type: "int", min: PARAM_RANGES.management_policy.breakout_unprofitable_max_age_minutes[0], max: PARAM_RANGES.management_policy.breakout_unprofitable_max_age_minutes[1], mutateScale: 0.20 },
    { target: "agent", path: "management_policy.playbook_aware.mean_reversion.sigma_worsening_threshold", type: "float", min: PARAM_RANGES.management_policy.mean_reversion_sigma_worsening_threshold[0], max: PARAM_RANGES.management_policy.mean_reversion_sigma_worsening_threshold[1], mutateScale: 0.20 },
    { target: "agent", path: "management_policy.playbook_aware.mean_reversion.opposite_pressure_threshold", type: "float", min: PARAM_RANGES.management_policy.mean_reversion_opposite_pressure_threshold[0], max: PARAM_RANGES.management_policy.mean_reversion_opposite_pressure_threshold[1], mutateScale: 0.20 },
    { target: "agent", path: "management_policy.playbook_aware.mean_reversion.unprofitable_max_age_minutes", type: "int", min: PARAM_RANGES.management_policy.mean_reversion_unprofitable_max_age_minutes[0], max: PARAM_RANGES.management_policy.mean_reversion_unprofitable_max_age_minutes[1], mutateScale: 0.20 },
    { target: "agent", path: "management_policy.playbook_aware.fallback.opposite_pressure_threshold", type: "float", min: PARAM_RANGES.management_policy.fallback_opposite_pressure_threshold[0], max: PARAM_RANGES.management_policy.fallback_opposite_pressure_threshold[1], mutateScale: 0.20 },
    { target: "agent", path: "management_policy.playbook_aware.fallback.unprofitable_max_age_minutes", type: "int", min: PARAM_RANGES.management_policy.fallback_unprofitable_max_age_minutes[0], max: PARAM_RANGES.management_policy.fallback_unprofitable_max_age_minutes[1], mutateScale: 0.20 },
    { target: "screener", path: "maxSpreadBps", type: "float", min: PARAM_RANGES.screener.maxSpreadBps[0], max: PARAM_RANGES.screener.maxSpreadBps[1], mutateScale: 0.20 },
    { target: "screener", path: "minDepthUsd", type: "float", min: PARAM_RANGES.screener.minDepthUsd[0], max: PARAM_RANGES.screener.minDepthUsd[1], mutateScale: 0.20 },
    { target: "screener", path: "maxCostBps", type: "float", min: PARAM_RANGES.screener.maxCostBps[0], max: PARAM_RANGES.screener.maxCostBps[1], mutateScale: 0.20 },
    { target: "screener", path: "minRecentVolume", type: "float", min: PARAM_RANGES.screener.minRecentVolume[0], max: PARAM_RANGES.screener.minRecentVolume[1], mutateScale: 0.20 },
    { target: "screener", path: "recentVolumeMinutes", type: "int", min: PARAM_RANGES.screener.recentVolumeMinutes[0], max: PARAM_RANGES.screener.recentVolumeMinutes[1], mutateScale: 0.20 },
    { target: "screener", path: "minRealizedVol", type: "float", min: PARAM_RANGES.screener.minRealizedVol[0], max: PARAM_RANGES.screener.minRealizedVol[1], mutateScale: 0.20 },
    { target: "screener", path: "minVolume24h", type: "float", min: PARAM_RANGES.screener.minVolume24h[0], max: PARAM_RANGES.screener.minVolume24h[1], mutateScale: 0.20 },
    { target: "screener", path: "quality_weights.vol_score", type: "float", min: PARAM_RANGES.screener.qualityWeight[0], max: PARAM_RANGES.screener.qualityWeight[1], mutateScale: 0.25 },
    { target: "screener", path: "quality_weights.move_score", type: "float", min: PARAM_RANGES.screener.qualityWeight[0], max: PARAM_RANGES.screener.qualityWeight[1], mutateScale: 0.25 },
    { target: "screener", path: "quality_weights.trend_align", type: "float", min: PARAM_RANGES.screener.qualityWeight[0], max: PARAM_RANGES.screener.qualityWeight[1], mutateScale: 0.25 },
    { target: "screener", path: "quality_weights.spread_penalty", type: "float", min: PARAM_RANGES.screener.qualityWeight[0], max: PARAM_RANGES.screener.qualityWeight[1], mutateScale: 0.25 },
    { target: "screener", path: "quality_weights.illiquidity_penalty", type: "float", min: PARAM_RANGES.screener.qualityWeight[0], max: PARAM_RANGES.screener.qualityWeight[1], mutateScale: 0.25 },
    { target: "screener", path: "quality_weights.cost_to_edge_penalty", type: "float", min: PARAM_RANGES.screener.qualityWeight[0], max: PARAM_RANGES.screener.qualityWeight[1], mutateScale: 0.25 }
];

export type OptimizerTrialWorkerMessage =
    | {
        type: "run";
        trialIndex: number;
        baseRunConfig: BacktestRunConfig;
        gates: OptimizerScoreGates;
    }
    | {
        type: "evaluate";
        trialIndex: number;
        runConfig: BacktestRunConfig;
        candidate: CandidateConfigPair;
        gates: OptimizerScoreGates;
    }
    | { type: "close" };

export type OptimizerTrialWorkerResult = {
    type: "result";
    trialIndex: number;
    result: ScoredConfig;
};

const REJECTED_SCORE = -1_000_000_000;

export interface ChampionChallengerResult {
    champion: AgentConfig;
    challenger: AgentConfig;
    championMetrics: BacktestMetrics;
    challengerMetrics: BacktestMetrics;
    accepted: boolean;
    reason: string;
}

export function sampleRandomConfig(baseConfig: AgentConfig, seed = 1): AgentConfig {
    const rng = mulberry32(seed);
    const clone = structuredClone(baseConfig);
    clone.management_policy = clone.management_policy ?? structuredClone(DEFAULT_AGENT_CONFIG.management_policy);
    for (const param of PARAM_SCHEMA.filter(entry => entry.target === "agent")) {
        applyParamValue(clone, param, sampleParamValue(rng, param));
    }
    return clone;
}

export function sampleRandomScreenerConfig(baseConfig: ScreenerConfig, seed = 1): ScreenerConfig {
    const rng = mulberry32(seed);
    const clone = structuredClone(baseConfig);
    for (const param of PARAM_SCHEMA.filter(entry => entry.target === "screener")) {
        applyParamValue(clone, param, sampleParamValue(rng, param));
    }
    return clone;
}

export function sampleBroadConfigPair(baseAgent: AgentConfig, baseScreener: ScreenerConfig, seed = 1): {
    agentConfig: AgentConfig;
    screenerConfig: ScreenerConfig;
} {
    return {
        agentConfig: sampleRandomConfig(baseAgent, seed),
        screenerConfig: sampleRandomScreenerConfig(baseScreener, seed + 10_000)
    };
}

export function mutateConfigPair(
    parentAgent: AgentConfig,
    parentScreener: ScreenerConfig,
    seed = 1,
    noiseScale = 0.25
): {
    agentConfig: AgentConfig;
    screenerConfig: ScreenerConfig;
} {
    const rng = mulberry32(seed);
    const agentConfig = structuredClone(parentAgent);
    const screenerConfig = structuredClone(parentScreener);
    agentConfig.management_policy = agentConfig.management_policy ?? structuredClone(DEFAULT_AGENT_CONFIG.management_policy);

    for (const param of PARAM_SCHEMA) {
        const target = param.target === "agent" ? agentConfig : screenerConfig;
        const current = readParamValue(target, param);
        const value = mutateParamValue(rng, param, current, noiseScale);
        applyParamValue(target, param, value);
    }

    return { agentConfig, screenerConfig };
}

export function readParamValue(config: AgentConfig | ScreenerConfig, param: OptimizerParamSchema): unknown {
    return param.path.split(".").reduce<unknown>((current, key) => {
        if (current === null || typeof current !== "object") return undefined;
        return (current as Record<string, unknown>)[key];
    }, config);
}

export function applyParamValue(config: AgentConfig | ScreenerConfig, param: OptimizerParamSchema, value: unknown): void {
    const parts = param.path.split(".");
    let current: Record<string, unknown> = config as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
        const next = current[part];
        if (next === null || typeof next !== "object") current[part] = {};
        current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = clampParamValue(value, param);

    if (param.target === "agent" && param.path === "cost_sanity.min_edge_to_cost_mult") {
        const agent = config as AgentConfig;
        const minEdgeToCost = agent.cost_sanity.min_edge_to_cost_mult;
        agent.gates.edge_to_cost_mult_by_regime = {
            RISK_ON: minEdgeToCost,
            RISK_OFF: minEdgeToCost,
            CHOP: minEdgeToCost
        };
    }
}

export function clampParamValue(value: unknown, param: OptimizerParamSchema): unknown {
    if (param.type === "bool") return Boolean(value);
    if (param.type === "enum") {
        if (!param.values || param.values.length === 0) return value;
        return param.values.includes(value as never) ? value : param.values[0];
    }

    const min = param.min ?? Number.NEGATIVE_INFINITY;
    const max = param.max ?? Number.POSITIVE_INFINITY;
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : min;
    const clamped = Math.min(max, Math.max(min, numeric));
    return param.type === "int" ? Math.round(clamped) : clamped;
}

export function scoreMetrics(metrics: BacktestMetrics, coverage?: CoverageReport): number {
    let penalty = 0;
    if (metrics.trade_count < 30) penalty += 200;
    if (metrics.trade_count > 500) penalty += 100;
    if (metrics.one_symbol_concentration > 0.35) penalty += 100;
    if (metrics.one_regime_concentration > 0.70) penalty += 50;

    if (coverage) {
        const missingFeatures = sumValues(coverage.missing_feature_rows_by_symbol);
        const missingBooks = sumValues(coverage.missing_execution_books_by_symbol ?? {});
        penalty += missingFeatures * 0.05;
        penalty += missingBooks * 0.02;
        penalty += coverage.missing_candle_intervals.length;
        penalty += coverage.symbols_dropped_insufficient_history.length * 25;
        if (coverage.synthetic_execution_candles) penalty += 250;
    }

    const turnoverCostBps = metrics.turnover_usd > 0
        ? (metrics.turnover_cost_usd / metrics.turnover_usd) * 10000
        : 0;
    return metrics.net_pnl_bps
        - 2.0 * metrics.max_drawdown_bps
        - 0.5 * turnoverCostBps
        - penalty;
}

export class WalkForwardOptimizer {
    private lastAdaptiveTrace: OptimizerTrace | null = null;

    constructor(private readonly runner = new BacktestRunner()) {}

    public async randomSearch(
        baseRunConfig: BacktestRunConfig,
        trials: number,
        gates: OptimizerScoreGates = DEFAULT_OPTIMIZER_SCORE_GATES,
        options: OptimizerRunOptions = {}
    ): Promise<ScoredConfig[]> {
        const concurrency = positiveInt(options.concurrency, 1);
        if (concurrency > 1 && trials > 1) {
            return runTrialsInWorkers(baseRunConfig, trials, gates, concurrency, options.onProgress);
        }

        const results: ScoredConfig[] = [];
        for (let i = 0; i < trials; i++) {
            const result = await runOptimizerTrial(this.runner, baseRunConfig, i, gates);
            results.push(result);
            options.onProgress?.({ completed: results.length, total: trials, trialIndex: i, result });
        }
        return results.sort((a, b) => b.score - a.score);
    }

    public getLastAdaptiveTrace(): OptimizerTrace | null {
        return this.lastAdaptiveTrace;
    }

    public async adaptiveSearch(
        baseRunConfig: BacktestRunConfig,
        options: Partial<AdaptiveOptimizerOptions> = {},
        gates: OptimizerScoreGates = DEFAULT_OPTIMIZER_SCORE_GATES
    ): Promise<ScoredConfig[]> {
        const settings: AdaptiveOptimizerOptions = {
            ...DEFAULT_ADAPTIVE_OPTIMIZER_OPTIONS,
            ...options
        };
        const generationCount = Math.max(1, Math.floor(settings.generations));
        const allFullResults: ScoredConfig[] = [];
        const generationSummaries: OptimizerGenerationSummary[] = [];

        if (settings.outputDir) await fs.mkdir(settings.outputDir, { recursive: true });

        for (let generation = 0; generation < generationCount; generation++) {
            const candidates = buildGenerationCandidates(baseRunConfig, allFullResults, settings, generation);
            const generationResults = await evaluateGeneration(
                this.runner,
                baseRunConfig,
                candidates,
                generation,
                gates,
                settings,
                progress => settings.onProgress?.(progress)
            );
            allFullResults.push(...generationResults.fullResults);

            const eligibleParents = selectMutationParents(allFullResults, settings);
            const summary = buildGenerationSummary(
                generation,
                candidates.length,
                generationResults,
                eligibleParents.elites.map(result => result.config_hash),
                eligibleParents.nearMisses.map(result => result.config_hash)
            );
            generationSummaries.push(summary);

            if (settings.outputDir) {
                await fs.writeFile(
                    path.join(settings.outputDir, `generation_${generation}_results.json`),
                    JSON.stringify(generationResults.fullResults, null, 2)
                );
            }
        }

        const sorted = sortScoredConfigs(dedupeResultsByHash(allFullResults))
            .slice(0, Math.max(1, Math.floor(settings.finalists)));
        this.lastAdaptiveTrace = buildOptimizerTrace("adaptive", generationSummaries, sorted);
        if (settings.outputDir) {
            await fs.writeFile(path.join(settings.outputDir, "optimizer_trace.json"), JSON.stringify(this.lastAdaptiveTrace, null, 2));
        }
        return sorted;
    }

    public async walkForward(
        baseRunConfig: BacktestRunConfig,
        trainDays: number,
        testDays: number,
        trials: number,
        gates: OptimizerScoreGates = DEFAULT_OPTIMIZER_SCORE_GATES,
        options: OptimizerRunOptions = {}
    ): Promise<ScoredConfig[]> {
        const foldResults: ScoredConfig[] = [];
        let trainStart = new Date(baseRunConfig.start);
        let foldIndex = 0;
        while (true) {
            const trainEnd = addDays(trainStart, trainDays);
            const testEnd = addDays(trainEnd, testDays);
            if (testEnd > baseRunConfig.end) break;

            const top = await this.randomSearch({
                ...baseRunConfig,
                start: trainStart,
                end: trainEnd,
                runId: `${baseRunConfig.runId ?? "wf"}_train_${foldIndex}`
            }, trials, gates, options);
            const viableTop = top.filter(result => !result.rejected);
            const keepSource = viableTop.length > 0 ? viableTop : top;
            const keep = keepSource.slice(0, Math.max(1, Math.ceil(keepSource.length * 0.2)));
            for (const candidate of keep) {
                try {
                    const testRun = await this.runner.run({
                        ...baseRunConfig,
                        start: trainEnd,
                        end: testEnd,
                        agentConfig: candidate.agentConfig,
                        screeningConfig: candidate.screenerConfig,
                        runId: `${baseRunConfig.runId ?? "wf"}_test_${foldIndex}_${candidate.config_hash}`
                    });
                    foldResults.push(scoreConfigRun(candidate.agentConfig, candidate.screenerConfig, testRun.metrics, testRun.coverage, testRun.trades, gates));
                } catch (error) {
                    foldResults.push(failedScoredConfig(candidate.agentConfig, candidate.screenerConfig, `runner_error:${formatError(error)}`));
                }
            }

            foldIndex++;
            trainStart = addDays(trainStart, testDays);
        }
        return aggregateScoredConfigs(foldResults, gates);
    }
}

export function aggregateScoredConfigs(
    foldResults: ScoredConfig[],
    gates: OptimizerScoreGates = DEFAULT_OPTIMIZER_SCORE_GATES
): ScoredConfig[] {
    const grouped = new Map<string, ScoredConfig[]>();
    for (const result of foldResults) {
        const group = grouped.get(result.config_hash) ?? [];
        group.push(result);
        grouped.set(result.config_hash, group);
    }

    const aggregated = Array.from(grouped.values()).map(group => {
        const first = group[0];
        const metrics = aggregateMetrics(group.map(result => result.metrics));
        const coverage = aggregateCoverage(group.map(result => result.coverage));
        const hardFoldRejection = group.find(result => isHardFoldRejection(result.rejection_reason));
        const gateRejection = optimizerRejectionReason(metrics, coverage, gates);
        const rejection = hardFoldRejection ? `${hardFoldRejection.rejection_reason}_in_fold` : gateRejection;
        return {
            config_hash: first.config_hash,
            agentConfig: first.agentConfig,
            screenerConfig: first.screenerConfig,
            metrics,
            coverage,
            score: rejection ? REJECTED_SCORE : scoreMetrics(metrics, coverage),
            rejected: !!rejection,
            rejection_reason: rejection ?? undefined,
            fold_count: group.length,
            fold_scores: group.map(result => result.score),
            fold_rejection_reasons: group.map(result => result.rejection_reason).filter((reason): reason is string => !!reason)
        };
    });

    return aggregated.sort((a, b) => b.score - a.score);
}

export function coverageRejectionReason(coverage: CoverageReport, tradedSymbols: Iterable<string> = []): string | null {
    if (coverage.available_timestamps <= 0) return "no_feature_timestamps";
    const traded = new Set(Array.from(tradedSymbols).map(toPerpSymbol));
    if (traded.size === 0) return null;

    const missingCandles = coverage.missing_candle_intervals.filter(interval => traded.has(toPerpSymbol(interval.symbol)));
    if (missingCandles.length > 0) {
        return `missing_execution_candles_for_traded_symbols:${Array.from(new Set(missingCandles.map(interval => toPerpSymbol(interval.symbol)))).join(",")}`;
    }

    return null;
}

export function optimizerRejectionReason(
    metrics: BacktestMetrics,
    coverage: CoverageReport,
    gates: OptimizerScoreGates = DEFAULT_OPTIMIZER_SCORE_GATES,
    tradedSymbols: Iterable<string> = []
): string | null {
    const coverageRejection = coverageRejectionReason(coverage, tradedSymbols);
    if (coverageRejection) return coverageRejection;
    if (coverage.synthetic_execution_candles && !gates.allowSyntheticCandles) return "synthetic_execution_candles";
    if (metrics.trade_count < gates.minTrades) return `min_trades:${metrics.trade_count}<${gates.minTrades}`;
    if (metrics.max_drawdown_bps > gates.maxDrawdownBps) return `max_drawdown_bps:${metrics.max_drawdown_bps}>${gates.maxDrawdownBps}`;
    if (metrics.profit_factor < gates.minProfitFactor) return `min_profit_factor:${metrics.profit_factor}<${gates.minProfitFactor}`;
    if (metrics.stop_hit_rate > gates.maxStopHitRate) return `max_stop_hit_rate:${metrics.stop_hit_rate}>${gates.maxStopHitRate}`;
    if (metrics.one_symbol_concentration > gates.maxSymbolConcentration) {
        return `max_symbol_concentration:${metrics.one_symbol_concentration}>${gates.maxSymbolConcentration}`;
    }
    if (metrics.one_regime_concentration > gates.maxRegimeConcentration) {
        return `max_regime_concentration:${metrics.one_regime_concentration}>${gates.maxRegimeConcentration}`;
    }
    return null;
}

export function configHash(agentConfig: AgentConfig, screenerConfig: ScreenerConfig): string {
    return createHash("sha256")
        .update(stableStringify({ agentConfig, screenerConfig }))
        .digest("hex")
        .slice(0, 16);
}

export function acceptChallenger(
    champion: AgentConfig,
    challenger: AgentConfig,
    championMetrics: BacktestMetrics,
    challengerMetrics: BacktestMetrics
): ChampionChallengerResult {
    const championScore = scoreMetrics(championMetrics);
    const challengerScore = scoreMetrics(challengerMetrics);
    const accepted = challengerScore > championScore * 1.15 &&
        challengerMetrics.max_drawdown_bps <= championMetrics.max_drawdown_bps * 1.10 &&
        challengerMetrics.trade_count >= 30 &&
        challengerMetrics.one_symbol_concentration < 0.35 &&
        challengerMetrics.one_regime_concentration < 0.70;
    return {
        champion,
        challenger,
        championMetrics,
        challengerMetrics,
        accepted,
        reason: accepted
            ? "challenger improves out-of-sample score without unacceptable drawdown or concentration"
            : challengerRejectionReason(championScore, challengerScore, championMetrics, challengerMetrics)
    };
}

export async function runOptimizerTrial(
    runner: BacktestRunner,
    baseRunConfig: BacktestRunConfig,
    trialIndex: number,
    gates: OptimizerScoreGates
): Promise<ScoredConfig> {
    const { agentConfig, screenerConfig } = sampleBroadConfigPair(
        baseRunConfig.agentConfig,
        baseRunConfig.screeningConfig,
        baseRunConfig.seed + trialIndex
    );
    try {
        const run = await runner.run({
            ...baseRunConfig,
            agentConfig,
            screeningConfig: screenerConfig,
            runId: `${baseRunConfig.runId ?? "opt"}_${trialIndex}`
        });
        return scoreConfigRun(agentConfig, screenerConfig, run.metrics, run.coverage, run.trades, gates);
    } catch (error) {
        return failedScoredConfig(agentConfig, screenerConfig, `runner_error:${formatError(error)}`);
    }
}

export async function runOptimizerCandidate(
    runner: BacktestRunner,
    runConfig: BacktestRunConfig,
    candidate: CandidateConfigPair,
    gates: OptimizerScoreGates
): Promise<ScoredConfig> {
    try {
        const run = await runner.run({
            ...runConfig,
            agentConfig: candidate.agentConfig,
            screeningConfig: candidate.screenerConfig
        });
        return scoreConfigRun(candidate.agentConfig, candidate.screenerConfig, run.metrics, run.coverage, run.trades, gates);
    } catch (error) {
        return failedScoredConfig(candidate.agentConfig, candidate.screenerConfig, `runner_error:${formatError(error)}`);
    }
}

function runTrialsInWorkers(
    baseRunConfig: BacktestRunConfig,
    trials: number,
    gates: OptimizerScoreGates,
    concurrency: number,
    onProgress: OptimizerRunOptions["onProgress"]
): Promise<ScoredConfig[]> {
    const workerCount = Math.min(positiveInt(concurrency, 1), trials);
    const results = new Array<ScoredConfig>(trials);
    const workers: Worker[] = [];
    let nextTrial = 0;
    let completed = 0;
    let settled = false;

    return new Promise((resolve, reject) => {
        const cleanup = () => {
            for (const worker of workers) void worker.terminate();
        };
        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        const maybeResolve = () => {
            if (completed < trials || settled) return;
            settled = true;
            cleanup();
            resolve(results.slice().sort((a, b) => b.score - a.score));
        };
        const assign = (worker: Worker) => {
            if (settled) return;
            if (nextTrial >= trials) {
                worker.postMessage({ type: "close" } satisfies OptimizerTrialWorkerMessage);
                return;
            }
            const trialIndex = nextTrial++;
            worker.postMessage({
                type: "run",
                trialIndex,
                baseRunConfig,
                gates
            } satisfies OptimizerTrialWorkerMessage);
        };

        for (let i = 0; i < workerCount; i++) {
            const worker = new Worker(new URL("./OptimizerTrialWorker.cjs", import.meta.url));
            workers.push(worker);
            worker.on("message", (message: OptimizerTrialWorkerResult) => {
                if (message?.type !== "result") return;
                results[message.trialIndex] = message.result;
                completed++;
                onProgress?.({
                    completed,
                    total: trials,
                    trialIndex: message.trialIndex,
                    result: message.result
                });
                maybeResolve();
                assign(worker);
            });
            worker.on("error", fail);
            worker.on("exit", code => {
                if (!settled && code !== 0) fail(new Error(`optimizer worker exited with code ${code}`));
            });
            assign(worker);
        }
    });
}

type GenerationEvaluationResult = {
    fullResults: ScoredConfig[];
    cheapResults: ScoredConfig[];
    fullEvaluationCount: number;
    cheapEvaluationCount: number;
};

type CandidateEvaluationTask = {
    trialIndex: number;
    runConfig: BacktestRunConfig;
    candidate: CandidateConfigPair;
    gates: OptimizerScoreGates;
};

type DistributionSummary = {
    min: number | null;
    p25: number | null;
    median: number | null;
    p75: number | null;
    max: number | null;
    mean: number | null;
};

function buildGenerationCandidates(
    baseRunConfig: BacktestRunConfig,
    priorResults: ScoredConfig[],
    options: AdaptiveOptimizerOptions,
    generation: number
): CandidateConfigPair[] {
    if (generation === 0) return dedupeConfigPairs(buildGenerationZeroCandidates(baseRunConfig));

    if (generation === 1) {
        return dedupeConfigPairs(Array.from({ length: Math.max(0, Math.floor(options.explorationTrials)) }, (_, index) =>
            sampleBroadConfigPair(
                baseRunConfig.agentConfig,
                baseRunConfig.screeningConfig,
                baseRunConfig.seed + 100_000 + index
            )
        ));
    }

    const parentSelection = selectMutationParents(priorResults, options);
    const parents = [...parentSelection.elites, ...parentSelection.nearMisses];
    const trialCount = Math.max(0, Math.floor(options.generationTrials));
    if (parents.length === 0) {
        return dedupeConfigPairs(Array.from({ length: trialCount }, (_, index) =>
            sampleBroadConfigPair(
                baseRunConfig.agentConfig,
                baseRunConfig.screeningConfig,
                baseRunConfig.seed + generation * 100_000 + index
            )
        ));
    }

    const rng = mulberry32(baseRunConfig.seed + generation * 97_003);
    const noiseScale = options.initialNoiseScale * Math.pow(options.noiseDecay, Math.max(0, generation - 2));
    return dedupeConfigPairs(Array.from({ length: trialCount }, (_, index) => {
        const parent = parents[Math.floor(rng() * parents.length) % parents.length];
        return mutateConfigPair(
            parent.agentConfig,
            parent.screenerConfig,
            baseRunConfig.seed + generation * 100_000 + index,
            noiseScale
        );
    }));
}

function buildGenerationZeroCandidates(baseRunConfig: BacktestRunConfig): CandidateConfigPair[] {
    const candidates: CandidateConfigPair[] = [{
        agentConfig: structuredClone(baseRunConfig.agentConfig),
        screenerConfig: structuredClone(baseRunConfig.screeningConfig)
    }];

    const namedAgent = AGENT_PRESETS[baseRunConfig.agentPresetName];
    const namedScreener = SCREENER_PRESETS[baseRunConfig.screeningPresetName];
    if (namedAgent && namedScreener) {
        candidates.push({ agentConfig: structuredClone(namedAgent), screenerConfig: structuredClone(namedScreener) });
    }

    for (const name of Object.keys(AGENT_PRESETS).sort()) {
        const agentPreset = AGENT_PRESETS[name];
        const screenerPreset = SCREENER_PRESETS[name];
        if (!agentPreset || !screenerPreset) continue;
        candidates.push({ agentConfig: structuredClone(agentPreset), screenerConfig: structuredClone(screenerPreset) });
    }
    return candidates;
}

async function evaluateGeneration(
    runner: BacktestRunner,
    baseRunConfig: BacktestRunConfig,
    candidates: CandidateConfigPair[],
    generation: number,
    gates: OptimizerScoreGates,
    options: AdaptiveOptimizerOptions,
    onProgress?: OptimizerRunOptions["onProgress"]
): Promise<GenerationEvaluationResult> {
    if (!options.successiveHalving || candidates.length <= 1) {
        const fullResults = await evaluateFullCandidates(runner, baseRunConfig, candidates, generation, gates, options, onProgress, 0, candidates.length);
        return { fullResults, cheapResults: [], fullEvaluationCount: fullResults.length, cheapEvaluationCount: 0 };
    }

    const slices = buildEvaluationSlices(baseRunConfig, options.sliceCount);
    const cheapTasks = candidates.map((candidate, i) => {
        const hash = configHash(candidate.agentConfig, candidate.screenerConfig);
        const slice = slices[hashToSliceIndex(hash, slices.length)];
        return {
            trialIndex: i,
            runConfig: {
                ...baseRunConfig,
                start: slice.start,
                end: slice.end,
                runId: `${baseRunConfig.runId ?? "adaptive"}_g${generation}_slice_${i}_${hash}`
            },
            candidate,
            gates: scaleGatesForSlice(gates, slice.start, slice.end, baseRunConfig.start, baseRunConfig.end)
        };
    });
    const cheapResults = await evaluateCandidateTasks(runner, cheapTasks, options, onProgress, 0, candidates.length);

    const keepCount = Math.max(1, Math.ceil(candidates.length * clampRatio(options.halvingKeepRatio)));
    const survivors = cheapResults
        .map((result, index) => ({ result, candidate: candidates[index] }))
        .sort((a, b) => fullRankingScore(b.result) - fullRankingScore(a.result))
        .slice(0, keepCount)
        .map(entry => entry.candidate);
    const fullResults = await evaluateFullCandidates(runner, baseRunConfig, survivors, generation, gates, options, onProgress, 0, survivors.length);
    return {
        fullResults,
        cheapResults,
        fullEvaluationCount: fullResults.length,
        cheapEvaluationCount: cheapResults.length
    };
}

async function evaluateFullCandidates(
    runner: BacktestRunner,
    baseRunConfig: BacktestRunConfig,
    candidates: CandidateConfigPair[],
    generation: number,
    gates: OptimizerScoreGates,
    options: AdaptiveOptimizerOptions,
    onProgress: OptimizerRunOptions["onProgress"] | undefined,
    completedOffset: number,
    total: number
): Promise<ScoredConfig[]> {
    const tasks = candidates.map((candidate, i) => {
        const hash = configHash(candidate.agentConfig, candidate.screenerConfig);
        return {
            trialIndex: i,
            runConfig: {
                ...baseRunConfig,
                runId: `${baseRunConfig.runId ?? "adaptive"}_g${generation}_full_${i}_${hash}`
            },
            candidate,
            gates
        };
    });
    const results = await evaluateCandidateTasks(runner, tasks, options, onProgress, completedOffset, total);
    return sortScoredConfigs(results);
}

async function evaluateCandidateTasks(
    runner: BacktestRunner,
    tasks: CandidateEvaluationTask[],
    options: OptimizerRunOptions,
    onProgress: OptimizerRunOptions["onProgress"] | undefined,
    completedOffset: number,
    total: number
): Promise<ScoredConfig[]> {
    const concurrency = positiveInt(options.concurrency, 1);
    if (shouldUseCandidateWorkers(runner, concurrency, tasks.length)) {
        return runCandidateTasksInWorkers(tasks, concurrency, onProgress, completedOffset, total);
    }

    const results = new Array<ScoredConfig>(tasks.length);
    let completed = 0;
    for (const task of tasks) {
        const result = await evaluateConfigPair(runner, task.runConfig, task.candidate, task.gates);
        results[task.trialIndex] = result;
        completed++;
        onProgress?.({ completed: completedOffset + completed, total, trialIndex: task.trialIndex, result });
    }
    return results;
}

function shouldUseCandidateWorkers(runner: BacktestRunner, concurrency: number, taskCount: number): boolean {
    return concurrency > 1 && taskCount > 1 && runner.constructor === BacktestRunner;
}

function runCandidateTasksInWorkers(
    tasks: CandidateEvaluationTask[],
    concurrency: number,
    onProgress: OptimizerRunOptions["onProgress"] | undefined,
    completedOffset: number,
    total: number
): Promise<ScoredConfig[]> {
    const workerCount = Math.min(positiveInt(concurrency, 1), tasks.length);
    const results = new Array<ScoredConfig>(tasks.length);
    const workers: Worker[] = [];
    let nextTask = 0;
    let completed = 0;
    let settled = false;

    return new Promise((resolve, reject) => {
        const cleanup = () => {
            for (const worker of workers) void worker.terminate();
        };
        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        const maybeResolve = () => {
            if (completed < tasks.length || settled) return;
            settled = true;
            cleanup();
            resolve(results);
        };
        const assign = (worker: Worker) => {
            if (settled) return;
            const task = tasks[nextTask++];
            if (!task) {
                worker.postMessage({ type: "close" } satisfies OptimizerTrialWorkerMessage);
                return;
            }
            worker.postMessage({
                type: "evaluate",
                trialIndex: task.trialIndex,
                runConfig: task.runConfig,
                candidate: task.candidate,
                gates: task.gates
            } satisfies OptimizerTrialWorkerMessage);
        };

        for (let i = 0; i < workerCount; i++) {
            const worker = new Worker(new URL("./OptimizerTrialWorker.cjs", import.meta.url));
            workers.push(worker);
            worker.on("message", (message: OptimizerTrialWorkerResult) => {
                if (message?.type !== "result") return;
                results[message.trialIndex] = message.result;
                completed++;
                onProgress?.({
                    completed: completedOffset + completed,
                    total,
                    trialIndex: message.trialIndex,
                    result: message.result
                });
                maybeResolve();
                assign(worker);
            });
            worker.on("error", fail);
            worker.on("exit", code => {
                if (!settled && code !== 0) fail(new Error(`optimizer worker exited with code ${code}`));
            });
            assign(worker);
        }
    });
}

async function evaluateConfigPair(
    runner: BacktestRunner,
    runConfig: BacktestRunConfig,
    candidate: CandidateConfigPair,
    gates: OptimizerScoreGates
): Promise<ScoredConfig> {
    return runOptimizerCandidate(runner, runConfig, candidate, gates);
}

function selectMutationParents(results: ScoredConfig[], options: AdaptiveOptimizerOptions): {
    elites: ScoredConfig[];
    nearMisses: ScoredConfig[];
} {
    const uniqueResults = dedupeResultsByHash(results);
    const elites = sortScoredConfigs(uniqueResults.filter(result => !result.rejected))
        .slice(0, Math.max(0, Math.floor(options.eliteCount)));
    const nearMisses = uniqueResults
        .filter(result => result.rejected && isNearMissRejection(result.rejection_reason) && !isHardOptimizerReject(result.rejection_reason))
        .sort((a, b) => fullRankingScore(b) - fullRankingScore(a))
        .slice(0, Math.max(0, Math.floor(options.nearMissCount)));
    return { elites, nearMisses };
}

export function isNearMissRejection(reason: string | undefined): boolean {
    return !!reason && (
        reason.startsWith("min_trades") ||
        reason.startsWith("min_profit_factor") ||
        reason.startsWith("max_symbol_concentration") ||
        reason.startsWith("max_regime_concentration")
    );
}

export function isHardOptimizerReject(reason: string | undefined): boolean {
    return !!reason && (
        reason.startsWith("runner_error") ||
        reason.startsWith("no_feature_timestamps") ||
        reason.startsWith("missing_execution_candles") ||
        reason.startsWith("missing_execution_candles_for_traded_symbols") ||
        reason.startsWith("synthetic_execution_candles")
    );
}

function positiveInt(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value as number));
}

function scoreConfigRun(
    agentConfig: AgentConfig,
    screenerConfig: ScreenerConfig,
    metrics: BacktestMetrics,
    coverage: CoverageReport,
    trades: SimTrade[],
    gates: OptimizerScoreGates
): ScoredConfig {
    const tradedSymbols = trades.map(trade => trade.symbol);
    const rejection = optimizerRejectionReason(metrics, coverage, gates, tradedSymbols);
    return {
        config_hash: configHash(agentConfig, screenerConfig),
        agentConfig,
        screenerConfig,
        metrics,
        coverage,
        score: rejection ? REJECTED_SCORE : scoreMetrics(metrics, coverage),
        rejected: !!rejection,
        rejection_reason: rejection ?? undefined
    };
}

function sample(rng: () => number, range: readonly [number, number]): number {
    return range[0] + (range[1] - range[0]) * rng();
}

function sampleInt(rng: () => number, range: readonly [number, number]): number {
    return Math.round(sample(rng, range));
}

function sampleParamValue(rng: () => number, param: OptimizerParamSchema): unknown {
    if (param.type === "bool") return rng() >= 0.5;
    if (param.type === "enum") {
        const values = param.values ?? [];
        return values[Math.floor(rng() * values.length) % values.length];
    }
    return param.type === "int"
        ? sampleInt(rng, [param.min ?? 0, param.max ?? 0])
        : sample(rng, [param.min ?? 0, param.max ?? 0]);
}

function mutateParamValue(rng: () => number, param: OptimizerParamSchema, current: unknown, noiseScale: number): unknown {
    if (param.type === "bool") {
        return rng() < param.mutateScale * noiseScale ? !Boolean(current) : Boolean(current);
    }
    if (param.type === "enum") {
        const values = param.values ?? [];
        if (values.length === 0 || rng() >= param.mutateScale * noiseScale) return current;
        return values[Math.floor(rng() * values.length) % values.length];
    }

    const min = param.min ?? 0;
    const max = param.max ?? min;
    const base = typeof current === "number" && Number.isFinite(current) ? current : (min + max) / 2;
    const width = max - min;
    return clampParamValue(base + gaussian(rng) * width * param.mutateScale * noiseScale, param);
}

function gaussian(rng: () => number): number {
    const u = Math.max(Number.EPSILON, rng());
    const v = Math.max(Number.EPSILON, rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function dedupeConfigPairs(candidates: CandidateConfigPair[]): CandidateConfigPair[] {
    const seen = new Set<string>();
    const out: CandidateConfigPair[] = [];
    for (const candidate of candidates) {
        const hash = configHash(candidate.agentConfig, candidate.screenerConfig);
        if (seen.has(hash)) continue;
        seen.add(hash);
        out.push(candidate);
    }
    return out;
}

function dedupeResultsByHash(results: ScoredConfig[]): ScoredConfig[] {
    const bestByHash = new Map<string, ScoredConfig>();
    for (const result of results) {
        const current = bestByHash.get(result.config_hash);
        if (!current || fullRankingScore(result) > fullRankingScore(current)) {
            bestByHash.set(result.config_hash, result);
        }
    }
    return Array.from(bestByHash.values());
}

function sortScoredConfigs(results: ScoredConfig[]): ScoredConfig[] {
    return results.slice().sort((a, b) => fullRankingScore(b) - fullRankingScore(a));
}

function fullRankingScore(result: ScoredConfig): number {
    if (!result.rejected) return result.score;
    if (isNearMissRejection(result.rejection_reason) && !isHardOptimizerReject(result.rejection_reason)) {
        return scoreMetrics(result.metrics, result.coverage) - 500_000_000;
    }
    return REJECTED_SCORE;
}

function buildEvaluationSlices(baseRunConfig: BacktestRunConfig, sliceCount: number): Array<{ start: Date; end: Date }> {
    const count = Math.max(1, Math.floor(sliceCount));
    const totalMs = Math.max(baseRunConfig.intervalSeconds * 1000, baseRunConfig.end.getTime() - baseRunConfig.start.getTime());
    const sliceMs = Math.max(baseRunConfig.intervalSeconds * 1000, Math.floor(totalMs / count));
    return Array.from({ length: count }, (_, index) => {
        const start = new Date(baseRunConfig.start.getTime() + index * sliceMs);
        const end = index === count - 1
            ? new Date(Math.min(baseRunConfig.end.getTime(), start.getTime() + sliceMs))
            : new Date(Math.min(baseRunConfig.end.getTime(), start.getTime() + sliceMs));
        return end > start ? { start, end } : { start: baseRunConfig.start, end: baseRunConfig.end };
    });
}

function hashToSliceIndex(hash: string, sliceCount: number): number {
    if (sliceCount <= 1) return 0;
    const numeric = Number.parseInt(hash.slice(0, 8), 16);
    return Number.isFinite(numeric) ? numeric % sliceCount : 0;
}

function scaleGatesForSlice(
    gates: OptimizerScoreGates,
    sliceStart: Date,
    sliceEnd: Date,
    fullStart: Date,
    fullEnd: Date
): OptimizerScoreGates {
    const fullMs = Math.max(1, fullEnd.getTime() - fullStart.getTime());
    const sliceMs = Math.max(1, sliceEnd.getTime() - sliceStart.getTime());
    return {
        ...gates,
        minTrades: Math.max(1, Math.floor(gates.minTrades * (sliceMs / fullMs)))
    };
}

function clampRatio(value: number): number {
    if (!Number.isFinite(value)) return 0.5;
    return Math.min(1, Math.max(0.01, value));
}

function buildGenerationSummary(
    generation: number,
    candidateCount: number,
    evaluation: GenerationEvaluationResult,
    eliteHashes: string[],
    nearMissHashes: string[]
): OptimizerGenerationSummary {
    return {
        generation,
        candidate_count: candidateCount,
        evaluated_count: evaluation.fullResults.length,
        cheap_evaluation_count: evaluation.cheapEvaluationCount,
        full_evaluation_count: evaluation.fullEvaluationCount,
        accepted_count: evaluation.fullResults.filter(result => !result.rejected).length,
        rejected_count: evaluation.fullResults.filter(result => result.rejected).length,
        elite_config_hashes: eliteHashes,
        near_miss_config_hashes: nearMissHashes,
        rejection_counts: rejectionCounts(evaluation.fullResults),
        score_distribution: distribution(evaluation.fullResults.map(result => result.score)),
        trade_count_distribution: distribution(evaluation.fullResults.map(result => result.metrics.trade_count))
    };
}

function buildOptimizerTrace(
    mode: OptimizerMode,
    generationSummaries: OptimizerGenerationSummary[],
    results: ScoredConfig[]
): OptimizerTrace {
    return {
        mode,
        generation_summaries: generationSummaries,
        elite_config_hashes: unique(generationSummaries.flatMap(summary => summary.elite_config_hashes)),
        near_miss_config_hashes: unique(generationSummaries.flatMap(summary => summary.near_miss_config_hashes)),
        rejection_counts: rejectionCounts(results),
        score_distribution: distribution(results.map(result => result.score)),
        trade_count_distribution: distribution(results.map(result => result.metrics.trade_count))
    };
}

function rejectionCounts(results: ScoredConfig[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const result of results) {
        if (!result.rejected) continue;
        const reason = result.rejection_reason ?? "unknown";
        counts[reason] = (counts[reason] ?? 0) + 1;
    }
    return counts;
}

function distribution(values: number[]): DistributionSummary {
    const finite = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
    if (finite.length === 0) return { min: null, p25: null, median: null, p75: null, max: null, mean: null };
    return {
        min: round(finite[0]),
        p25: round(percentile(finite, 0.25)),
        median: round(percentile(finite, 0.50)),
        p75: round(percentile(finite, 0.75)),
        max: round(finite[finite.length - 1]),
        mean: round(sum(finite) / finite.length)
    };
}

function percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 1) return sortedValues[0];
    const index = (sortedValues.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sortedValues[lower];
    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function mulberry32(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60_000);
}

function failedScoredConfig(agentConfig: AgentConfig, screenerConfig: ScreenerConfig, reason: string): ScoredConfig {
    return {
        config_hash: configHash(agentConfig, screenerConfig),
        agentConfig,
        screenerConfig,
        metrics: emptyMetrics(),
        coverage: emptyCoverage(),
        score: REJECTED_SCORE,
        rejected: true,
        rejection_reason: reason
    };
}

function emptyCoverage(): CoverageReport {
    return {
        expected_timestamps: 0,
        available_timestamps: 0,
        candle_source: "real_1m",
        synthetic_execution_candles: false,
        missing_feature_rows_by_symbol: {},
        missing_execution_books_by_symbol: {},
        missing_candle_intervals: [],
        symbols_dropped_insufficient_history: [],
        skipped_timestamps: []
    };
}

function emptyMetrics(): BacktestMetrics {
    return {
        net_pnl_usd: 0,
        net_pnl_bps: 0,
        max_drawdown_usd: 0,
        max_drawdown_bps: 0,
        trade_count: 0,
        win_rate: 0,
        profit_factor: 0,
        avg_win_usd: 0,
        avg_loss_usd: 0,
        avg_trade_net_bps: 0,
        expectancy_per_trade_usd: 0,
        max_consecutive_losses: 0,
        avg_slippage_bps: 0,
        avg_fees_usd_per_trade: 0,
        avg_mfe_bps: 0,
        avg_mae_bps: 0,
        pnl_by_hour_utc: {},
        pnl_by_weekday: {},
        confidence_buckets: {},
        turnover_usd: 0,
        turnover_cost_usd: 0,
        stop_hit_rate: 0,
        take_profit_hit_rate: 0,
        time_stop_rate: 0,
        avg_holding_minutes: 0,
        one_symbol_concentration: 0,
        one_regime_concentration: 0,
        breakdowns: {}
    };
}

function aggregateMetrics(metrics: BacktestMetrics[]): BacktestMetrics {
    if (metrics.length === 0) return emptyMetrics();
    const tradeCount = sum(metrics.map(metric => metric.trade_count));
    const netPnlUsd = sum(metrics.map(metric => metric.net_pnl_usd));
    const netPnlBps = sum(metrics.map(metric => metric.net_pnl_bps));
    const turnoverUsd = sum(metrics.map(metric => metric.turnover_usd));
    const turnoverCostUsd = sum(metrics.map(metric => metric.turnover_cost_usd));
    return {
        net_pnl_usd: round(netPnlUsd),
        net_pnl_bps: round(netPnlBps),
        max_drawdown_usd: round(Math.max(...metrics.map(metric => metric.max_drawdown_usd))),
        max_drawdown_bps: round(Math.max(...metrics.map(metric => metric.max_drawdown_bps))),
        trade_count: tradeCount,
        win_rate: weightedAverage(metrics, metric => metric.win_rate),
        profit_factor: aggregateProfitFactor(metrics),
        avg_win_usd: weightedAverage(metrics, metric => metric.avg_win_usd),
        avg_loss_usd: weightedAverage(metrics, metric => metric.avg_loss_usd),
        avg_trade_net_bps: weightedAverage(metrics, metric => metric.avg_trade_net_bps),
        expectancy_per_trade_usd: tradeCount > 0 ? round(netPnlUsd / tradeCount) : 0,
        max_consecutive_losses: Math.max(...metrics.map(metric => metric.max_consecutive_losses)),
        avg_slippage_bps: weightedAverage(metrics, metric => metric.avg_slippage_bps),
        avg_fees_usd_per_trade: weightedAverage(metrics, metric => metric.avg_fees_usd_per_trade),
        avg_mfe_bps: weightedAverage(metrics, metric => metric.avg_mfe_bps),
        avg_mae_bps: weightedAverage(metrics, metric => metric.avg_mae_bps),
        pnl_by_hour_utc: sumRecords(metrics.map(metric => metric.pnl_by_hour_utc)),
        pnl_by_weekday: sumRecords(metrics.map(metric => metric.pnl_by_weekday)),
        confidence_buckets: aggregateConfidenceBuckets(metrics),
        turnover_usd: round(turnoverUsd),
        turnover_cost_usd: round(turnoverCostUsd),
        stop_hit_rate: weightedAverage(metrics, metric => metric.stop_hit_rate),
        take_profit_hit_rate: weightedAverage(metrics, metric => metric.take_profit_hit_rate),
        time_stop_rate: weightedAverage(metrics, metric => metric.time_stop_rate),
        avg_holding_minutes: weightedAverage(metrics, metric => metric.avg_holding_minutes),
        one_symbol_concentration: round(Math.max(...metrics.map(metric => metric.one_symbol_concentration))),
        one_regime_concentration: round(Math.max(...metrics.map(metric => metric.one_regime_concentration))),
        candle_source: aggregateCandleSource(metrics.map(metric => metric.candle_source).filter((source): source is CoverageReport["candle_source"] => !!source)),
        synthetic_execution_candles: metrics.some(metric => metric.synthetic_execution_candles),
        warnings: unique(metrics.flatMap(metric => metric.warnings ?? [])),
        breakdowns: {}
    };
}

function aggregateCoverage(coverages: CoverageReport[]): CoverageReport {
    if (coverages.length === 0) return emptyCoverage();
    return {
        expected_timestamps: sum(coverages.map(coverage => coverage.expected_timestamps)),
        available_timestamps: sum(coverages.map(coverage => coverage.available_timestamps)),
        candle_source: aggregateCandleSource(coverages.map(coverage => coverage.candle_source)),
        synthetic_execution_candles: coverages.some(coverage => coverage.synthetic_execution_candles),
        missing_feature_rows_by_symbol: sumRecordValues(coverages.map(coverage => coverage.missing_feature_rows_by_symbol)),
        missing_execution_books_by_symbol: sumRecordValues(coverages.map(coverage => coverage.missing_execution_books_by_symbol ?? {})),
        missing_candle_intervals: coverages.flatMap(coverage => coverage.missing_candle_intervals).slice(0, 1000),
        symbols_dropped_insufficient_history: unique(coverages.flatMap(coverage => coverage.symbols_dropped_insufficient_history)),
        skipped_timestamps: coverages.flatMap(coverage => coverage.skipped_timestamps).slice(0, 1000)
    };
}

function aggregateCandleSource(sources: CoverageReport["candle_source"][]): CoverageReport["candle_source"] {
    if (sources.includes("mixed")) return "mixed";
    if (sources.includes("real_1m") && sources.includes("synthetic_from_features")) return "mixed";
    if (sources.includes("synthetic_from_features")) return "synthetic_from_features";
    return "real_1m";
}

function isHardFoldRejection(reason: string | undefined): boolean {
    return !!reason && (
        reason.startsWith("runner_error") ||
        reason.startsWith("no_feature_timestamps") ||
        reason.startsWith("missing_execution_candles_for_traded_symbols")
    );
}

function aggregateProfitFactor(metrics: BacktestMetrics[]): number {
    const weighted = metrics.filter(metric => Number.isFinite(metric.profit_factor));
    if (weighted.length > 0) return weightedAverage(weighted, metric => metric.profit_factor);
    return metrics.some(metric => metric.profit_factor === Infinity) ? Infinity : 0;
}

function aggregateConfidenceBuckets(metrics: BacktestMetrics[]): BacktestMetrics["confidence_buckets"] {
    const grouped = new Map<string, { trades: number; pnl: number; wins: number }>();
    for (const metric of metrics) {
        for (const [bucket, value] of Object.entries(metric.confidence_buckets)) {
            const current = grouped.get(bucket) ?? { trades: 0, pnl: 0, wins: 0 };
            current.trades += value.trade_count;
            current.pnl += value.net_pnl_usd;
            current.wins += value.win_rate * value.trade_count;
            grouped.set(bucket, current);
        }
    }
    return Object.fromEntries(Array.from(grouped.entries()).map(([bucket, value]) => [bucket, {
        trade_count: value.trades,
        net_pnl_usd: round(value.pnl),
        win_rate: value.trades > 0 ? round(value.wins / value.trades) : 0
    }]));
}

function weightedAverage(metrics: BacktestMetrics[], valueFn: (metric: BacktestMetrics) => number): number {
    const totalTrades = sum(metrics.map(metric => metric.trade_count));
    if (totalTrades <= 0) return round(sum(metrics.map(valueFn)) / metrics.length);
    return round(sum(metrics.map(metric => valueFn(metric) * metric.trade_count)) / totalTrades);
}

function sumRecordValues(records: Array<Record<string, number>>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const record of records) {
        for (const [key, value] of Object.entries(record)) {
            out[key] = (out[key] ?? 0) + value;
        }
    }
    return out;
}

function sumRecords(records: Array<Record<string, number>>): Record<string, number> {
    return Object.fromEntries(Object.entries(sumRecordValues(records)).map(([key, value]) => [key, round(value)]));
}

function sumValues(record: Record<string, number>): number {
    return sum(Object.values(record));
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function unique<T>(values: T[]): T[] {
    return Array.from(new Set(values));
}

function round(value: number): number {
    if (!Number.isFinite(value)) return value;
    return Math.round(value * 10000) / 10000;
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

function toPerpSymbol(symbol: string): string {
    return symbol.endsWith("-PERP") ? symbol : `${symbol}-PERP`;
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function challengerRejectionReason(
    championScore: number,
    challengerScore: number,
    championMetrics: BacktestMetrics,
    challengerMetrics: BacktestMetrics
): string {
    if (challengerScore <= championScore * 1.15) return "challenger score does not improve by at least 15%";
    if (challengerMetrics.max_drawdown_bps > championMetrics.max_drawdown_bps * 1.10) return "challenger drawdown is worse by more than 10%";
    if (challengerMetrics.trade_count < 30) return "challenger trade count is insufficient";
    if (challengerMetrics.one_symbol_concentration >= 0.35) return "challenger performance is too concentrated in one symbol";
    if (challengerMetrics.one_regime_concentration >= 0.70) return "challenger performance is too concentrated in one regime";
    return "challenger does not pass acceptance gates";
}
