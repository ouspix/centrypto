import { createHash } from "crypto";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig } from "@/lib/screener-config";
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
        topN: [8, 30],
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

export const DEFAULT_OPTIMIZER_SCORE_GATES: OptimizerScoreGates = {
    minTrades: 30,
    maxDrawdownBps: 2_000,
    minProfitFactor: 1.0,
    maxStopHitRate: 0.60,
    maxSymbolConcentration: 0.35,
    maxRegimeConcentration: 0.70,
    allowSyntheticCandles: false
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
    clone.triggers.mean_reversion.ret_sigma_threshold = sample(rng, PARAM_RANGES.mean_reversion.ret_sigma_threshold);
    clone.triggers.mean_reversion.book_pressure_min = sample(rng, PARAM_RANGES.mean_reversion.book_pressure_min);
    clone.triggers.momentum.vol_ratio_min = sample(rng, PARAM_RANGES.momentum.vol_ratio_min);
    clone.triggers.momentum.book_pressure_min = sample(rng, PARAM_RANGES.momentum.book_pressure_min);
    clone.triggers.breakout.vol_ratio_min = sample(rng, PARAM_RANGES.breakout.vol_ratio_min);
    clone.triggers.breakout.book_pressure_min = sample(rng, PARAM_RANGES.breakout.book_pressure_min);
    const minEdgeToCost = sample(rng, PARAM_RANGES.cost_sanity.min_edge_to_cost_mult);
    clone.cost_sanity.min_edge_to_cost_mult = minEdgeToCost;
    clone.gates.edge_to_cost_mult_by_regime = {
        RISK_ON: minEdgeToCost,
        RISK_OFF: minEdgeToCost,
        CHOP: minEdgeToCost
    };
    clone.cost_sanity.min_stop_to_cost_mult = sample(rng, PARAM_RANGES.cost_sanity.min_stop_to_cost_mult);
    clone.cost_sanity.min_tp_to_cost_mult = sample(rng, PARAM_RANGES.cost_sanity.min_tp_to_cost_mult);

    clone.management_policy.hold_confidence = sample(rng, PARAM_RANGES.management_policy.hold_confidence);
    clone.management_policy.close_confidence = sample(rng, PARAM_RANGES.management_policy.close_confidence);
    clone.management_policy.playbook_aware.momentum.opposite_pressure_threshold = sample(rng, PARAM_RANGES.management_policy.momentum_opposite_pressure_threshold);
    clone.management_policy.playbook_aware.momentum.opposite_pressure_cycles = sampleInt(rng, PARAM_RANGES.management_policy.momentum_opposite_pressure_cycles);
    clone.management_policy.playbook_aware.momentum.unprofitable_max_age_minutes = sampleInt(rng, PARAM_RANGES.management_policy.momentum_unprofitable_max_age_minutes);
    clone.management_policy.playbook_aware.breakout.opposite_pressure_threshold = sample(rng, PARAM_RANGES.management_policy.breakout_opposite_pressure_threshold);
    clone.management_policy.playbook_aware.breakout.unprofitable_max_age_minutes = sampleInt(rng, PARAM_RANGES.management_policy.breakout_unprofitable_max_age_minutes);
    clone.management_policy.playbook_aware.mean_reversion.sigma_worsening_threshold = sample(rng, PARAM_RANGES.management_policy.mean_reversion_sigma_worsening_threshold);
    clone.management_policy.playbook_aware.mean_reversion.opposite_pressure_threshold = sample(rng, PARAM_RANGES.management_policy.mean_reversion_opposite_pressure_threshold);
    clone.management_policy.playbook_aware.mean_reversion.unprofitable_max_age_minutes = sampleInt(rng, PARAM_RANGES.management_policy.mean_reversion_unprofitable_max_age_minutes);
    clone.management_policy.playbook_aware.fallback.opposite_pressure_threshold = sample(rng, PARAM_RANGES.management_policy.fallback_opposite_pressure_threshold);
    clone.management_policy.playbook_aware.fallback.unprofitable_max_age_minutes = sampleInt(rng, PARAM_RANGES.management_policy.fallback_unprofitable_max_age_minutes);
    return clone;
}

export function sampleRandomScreenerConfig(baseConfig: ScreenerConfig, seed = 1): ScreenerConfig {
    const rng = mulberry32(seed);
    const clone = structuredClone(baseConfig);
    clone.maxSpreadBps = sample(rng, PARAM_RANGES.screener.maxSpreadBps);
    clone.minDepthUsd = sample(rng, PARAM_RANGES.screener.minDepthUsd);
    clone.maxCostBps = sample(rng, PARAM_RANGES.screener.maxCostBps);
    clone.minRecentVolume = sample(rng, PARAM_RANGES.screener.minRecentVolume);
    clone.recentVolumeMinutes = sampleInt(rng, PARAM_RANGES.screener.recentVolumeMinutes);
    clone.minRealizedVol = sample(rng, PARAM_RANGES.screener.minRealizedVol);
    clone.minVolume24h = sample(rng, PARAM_RANGES.screener.minVolume24h);
    clone.topN = sampleInt(rng, PARAM_RANGES.screener.topN);
    clone.quality_weights = {
        vol_score: sample(rng, PARAM_RANGES.screener.qualityWeight),
        move_score: sample(rng, PARAM_RANGES.screener.qualityWeight),
        trend_align: sample(rng, PARAM_RANGES.screener.qualityWeight),
        spread_penalty: sample(rng, PARAM_RANGES.screener.qualityWeight),
        illiquidity_penalty: sample(rng, PARAM_RANGES.screener.qualityWeight),
        cost_to_edge_penalty: sample(rng, PARAM_RANGES.screener.qualityWeight)
    };
    return clone;
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
    constructor(private readonly runner = new BacktestRunner()) {}

    public async randomSearch(
        baseRunConfig: BacktestRunConfig,
        trials: number,
        gates: OptimizerScoreGates = DEFAULT_OPTIMIZER_SCORE_GATES
    ): Promise<ScoredConfig[]> {
        const results: ScoredConfig[] = [];
        for (let i = 0; i < trials; i++) {
            const agentConfig = sampleRandomConfig(baseRunConfig.agentConfig, baseRunConfig.seed + i);
            const screenerConfig = sampleRandomScreenerConfig(baseRunConfig.screeningConfig, baseRunConfig.seed + 10_000 + i);
            try {
                const run = await this.runner.run({
                    ...baseRunConfig,
                    agentConfig,
                    screeningConfig: screenerConfig,
                    runId: `${baseRunConfig.runId ?? "opt"}_${i}`
                });
                results.push(scoreConfigRun(agentConfig, screenerConfig, run.metrics, run.coverage, run.trades, gates));
            } catch (error) {
                results.push(failedScoredConfig(agentConfig, screenerConfig, `runner_error:${formatError(error)}`));
            }
        }
        return results.sort((a, b) => b.score - a.score);
    }

    public async walkForward(
        baseRunConfig: BacktestRunConfig,
        trainDays: number,
        testDays: number,
        trials: number,
        gates: OptimizerScoreGates = DEFAULT_OPTIMIZER_SCORE_GATES
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
            }, trials, gates);
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
