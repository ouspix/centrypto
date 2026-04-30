import { AgentConfig } from "@/lib/agent-config";
import { BacktestRunner } from "./BacktestRunner";
import { BacktestMetrics, BacktestRunConfig, CoverageReport } from "./BacktestTypes";

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
    }
} as const;

export type ScoredConfig = {
    config: AgentConfig;
    metrics: BacktestMetrics;
    score: number;
    coverage: CoverageReport;
    rejected: boolean;
    rejection_reason?: string;
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
    clone.triggers.mean_reversion.ret_sigma_threshold = sample(rng, PARAM_RANGES.mean_reversion.ret_sigma_threshold);
    clone.triggers.mean_reversion.book_pressure_min = sample(rng, PARAM_RANGES.mean_reversion.book_pressure_min);
    clone.triggers.momentum.vol_ratio_min = sample(rng, PARAM_RANGES.momentum.vol_ratio_min);
    clone.triggers.momentum.book_pressure_min = sample(rng, PARAM_RANGES.momentum.book_pressure_min);
    clone.triggers.breakout.vol_ratio_min = sample(rng, PARAM_RANGES.breakout.vol_ratio_min);
    clone.triggers.breakout.book_pressure_min = sample(rng, PARAM_RANGES.breakout.book_pressure_min);
    clone.cost_sanity.min_edge_to_cost_mult = sample(rng, PARAM_RANGES.cost_sanity.min_edge_to_cost_mult);
    clone.cost_sanity.min_stop_to_cost_mult = sample(rng, PARAM_RANGES.cost_sanity.min_stop_to_cost_mult);
    clone.cost_sanity.min_tp_to_cost_mult = sample(rng, PARAM_RANGES.cost_sanity.min_tp_to_cost_mult);
    return clone;
}

export function scoreMetrics(metrics: BacktestMetrics): number {
    let penalty = 0;
    if (metrics.trade_count < 30) penalty += 200;
    if (metrics.trade_count > 500) penalty += 100;
    if (metrics.one_symbol_concentration > 0.35) penalty += 100;
    if (metrics.one_regime_concentration > 0.70) penalty += 50;
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

    public async randomSearch(baseRunConfig: BacktestRunConfig, trials: number): Promise<ScoredConfig[]> {
        const results: ScoredConfig[] = [];
        for (let i = 0; i < trials; i++) {
            const agentConfig = sampleRandomConfig(baseRunConfig.agentConfig, baseRunConfig.seed + i);
            try {
                const run = await this.runner.run({
                    ...baseRunConfig,
                    agentConfig,
                    runId: `${baseRunConfig.runId ?? "opt"}_${i}`
                });
                const coverageRejection = coverageRejectionReason(run.coverage);
                results.push({
                    config: agentConfig,
                    metrics: run.metrics,
                    coverage: run.coverage,
                    score: coverageRejection ? REJECTED_SCORE : scoreMetrics(run.metrics),
                    rejected: !!coverageRejection,
                    rejection_reason: coverageRejection ?? undefined
                });
            } catch (error) {
                results.push(failedScoredConfig(agentConfig, `runner_error:${formatError(error)}`));
            }
        }
        return results.sort((a, b) => b.score - a.score);
    }

    public async walkForward(baseRunConfig: BacktestRunConfig, trainDays: number, testDays: number, trials: number): Promise<ScoredConfig[]> {
        const scored: ScoredConfig[] = [];
        let trainStart = new Date(baseRunConfig.start);
        while (true) {
            const trainEnd = addDays(trainStart, trainDays);
            const testEnd = addDays(trainEnd, testDays);
            if (testEnd > baseRunConfig.end) break;

            const top = await this.randomSearch({ ...baseRunConfig, start: trainStart, end: trainEnd }, trials);
            const viableTop = top.filter(result => !result.rejected);
            const keepSource = viableTop.length > 0 ? viableTop : top;
            const keep = keepSource.slice(0, Math.max(1, Math.ceil(keepSource.length * 0.2)));
            for (const candidate of keep) {
                try {
                    const testRun = await this.runner.run({
                        ...baseRunConfig,
                        start: trainEnd,
                        end: testEnd,
                        agentConfig: candidate.config,
                        runId: `${baseRunConfig.runId ?? "wf"}_${trainStart.toISOString()}`
                    });
                    const coverageRejection = coverageRejectionReason(testRun.coverage);
                    scored.push({
                        config: candidate.config,
                        metrics: testRun.metrics,
                        coverage: testRun.coverage,
                        score: coverageRejection ? REJECTED_SCORE : scoreMetrics(testRun.metrics),
                        rejected: !!coverageRejection,
                        rejection_reason: coverageRejection ?? undefined
                    });
                } catch (error) {
                    scored.push(failedScoredConfig(candidate.config, `runner_error:${formatError(error)}`));
                }
            }

            trainStart = addDays(trainStart, testDays);
        }
        return scored.sort((a, b) => b.score - a.score);
    }
}

export function coverageRejectionReason(coverage: CoverageReport): string | null {
    if (coverage.available_timestamps <= 0) return "no_feature_timestamps";
    const missingFeatures = Object.entries(coverage.missing_feature_rows_by_symbol)
        .filter(([, missing]) => missing > 0);
    if (missingFeatures.length > 0) return `missing_features:${missingFeatures.map(([symbol, count]) => `${symbol}:${count}`).join(",")}`;

    const missingBooks = Object.entries(coverage.missing_execution_books_by_symbol ?? {})
        .filter(([, missing]) => missing > 0);
    if (missingBooks.length > 0) return `missing_execution_books:${missingBooks.map(([symbol, count]) => `${symbol}:${count}`).join(",")}`;

    if (coverage.missing_candle_intervals.length > 0) return "missing_execution_candles";
    if (coverage.symbols_dropped_insufficient_history.length > 0) {
        return `insufficient_history:${coverage.symbols_dropped_insufficient_history.join(",")}`;
    }
    return null;
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

function sample(rng: () => number, range: readonly [number, number]): number {
    return range[0] + (range[1] - range[0]) * rng();
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

function failedScoredConfig(config: AgentConfig, reason: string): ScoredConfig {
    return {
        config,
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
