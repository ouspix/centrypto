import fs from "fs/promises";
import os from "os";
import path from "path";
import { AGENT_PRESETS } from "@/lib/agent-config";
import { SCREENER_PRESETS } from "@/lib/screener-config";
import { assertOptimizerCandlePreflight, hydrateBacktestDataForRun } from "@/src/backtest/BacktestHydration";
import { BacktestRunConfig } from "@/src/backtest/BacktestTypes";
import {
    AdaptiveOptimizerOptions,
    DEFAULT_OPTIMIZER_SCORE_GATES,
    OptimizerMode,
    OptimizerScoreGates,
    WalkForwardOptimizer
} from "@/src/backtest/WalkForwardOptimizer";

type SlTpExecution = NonNullable<BacktestRunConfig["slTpExecution"]>;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const agentPresetName = args["base-agent"] ?? args.agent ?? "Momentum Moderate";
    const screeningPresetName = args.screening ?? "Momentum Moderate";
    const base = AGENT_PRESETS[agentPresetName];
    const screeningPreset = SCREENER_PRESETS[screeningPresetName];
    if (!base || !screeningPreset) throw new Error("Unknown preset");
    if (args.symbols) throw new Error("--symbols was removed from optimizer runs. Hydration automatically selects the top historical universe; use --top-symbols to change the default 15.");
    const screening = buildScreeningConfig(screeningPreset, args);
    const trials = Number(args.trials ?? 200);
    const optimizerMode = (args["optimizer-mode"] ?? "random") as OptimizerMode;
    if (optimizerMode !== "random" && optimizerMode !== "adaptive") throw new Error("--optimizer-mode must be random or adaptive");
    const optimizerConcurrency = parseConcurrency(args["optimizer-concurrency"] ?? args["trial-concurrency"], defaultOptimizerConcurrency());
    const optimizer = new WalkForwardOptimizer();
    const start = new Date(required(args.start, "--start is required"));
    const end = new Date(required(args.end, "--end is required"));
    const intervalSeconds = Number(args["interval-seconds"] ?? 10);
    const policyName = (args.policy ?? "take_top_rank") as any;
    if (policyName === "real_llm") throw new Error("real_llm is disabled for optimizer search. Use deterministic or recorded_llm policies.");
    const scoreGates = buildScoreGates(args);
    const hydrateArchive = args["hydrate-archive"] === "true" || args.hydrate === "true";
    const hydrateRealCandles = args["hydrate-real-candles"] === "true";
    const hydration = await hydrateBacktestDataForRun({
        hydrateArchive,
        hydrateRealCandles,
        network: (args.network ?? "mainnet") as "mainnet" | "testnet",
        realCandleConcurrency: Number(args["candle-concurrency"] ?? args["download-concurrency"] ?? 4),
        preferNodeFillArchiveForRealCandles: args["prefer-node-fill-archive"] === "true",
        archive: {
            start,
            end,
            intervalSeconds,
            dbPath: args.db,
            universeSize: Number(args["universe-size"] ?? args["top-symbols"] ?? 15),
            downloadConcurrency: Number(args["download-concurrency"] ?? 6),
            lookbackHours: Number(args["lookback-hours"] ?? 1),
            tmpRoot: args["tmp-root"],
            keepTmp: args["keep-tmp"] === "true"
        }
    });
    await assertOptimizerCandlePreflight({
        dbPath: args.db,
        start,
        end,
        symbols: hydration.archive?.symbols,
        scoreGates,
        hydrateRealCandlesRequested: hydrateRealCandles
    });
    const runConfig: BacktestRunConfig = {
        network: (args.network ?? "mainnet") as "mainnet" | "testnet",
        start,
        end,
        intervalSeconds,
        initialCapitalUsd: Number(args.capital ?? 10000),
        screeningPresetName,
        agentPresetName,
        screeningConfig: screening,
        agentConfig: base,
        policyName,
        managementPolicyName: (args.management ?? "playbook_aware") as any,
        seed: Number(args.seed ?? 1),
        featureDbPath: args.db,
        runId: args["run-id"] ?? "optimize",
        writeArtifacts: args["write-trial-artifacts"] === "true",
        suppressConsoleWarnings: true,
        cacheDataSource: true,
        llm: buildLlmConfig(args, policyName),
        slTpExecution: buildSlTpExecution(args, base, (args.network ?? "mainnet") as "mainnet" | "testnet")
    };

    const outDir = args["output-dir"] ?? path.join("data", "backtests", args["run-id"] ?? "optimize");
    const out = args.output ?? path.join(outDir, "optimizer_results.json");
    await fs.mkdir(path.dirname(out), { recursive: true });

    console.log(`[backtest:optimize] Running ${optimizerMode} optimizer with ${optimizerMode === "random" ? `${trials} trials` : `${args.generations ?? 4} generations`} and optimizer concurrency ${optimizerConcurrency}`);
    const progress = buildProgressLogger("backtest:optimize");
    const results = optimizerMode === "adaptive"
        ? await optimizer.adaptiveSearch(runConfig, buildAdaptiveOptions(args, path.dirname(out), progress, optimizerConcurrency), scoreGates)
        : await optimizer.randomSearch(runConfig, trials, scoreGates, {
            concurrency: optimizerConcurrency,
            onProgress: progress
        });
    await fs.writeFile(out, JSON.stringify(results, null, 2));
    await fs.writeFile(path.join(path.dirname(out), "top_configs.json"), JSON.stringify(results.filter(r => !r.rejected).slice(0, 20), null, 2));
    const adaptiveTrace = optimizer.getLastAdaptiveTrace();
    await fs.writeFile(path.join(path.dirname(out), "optimizer_trace.json"), JSON.stringify(adaptiveTrace ?? buildRandomOptimizerTrace(results), null, 2));
    await fs.writeFile(path.join(path.dirname(out), "coverage_summary.json"), JSON.stringify(buildCoverageSummary(results), null, 2));
    await fs.writeFile(path.join(path.dirname(out), "in_sample_summary.json"), JSON.stringify(buildInSampleSummary(results, scoreGates, optimizerMode), null, 2));
    console.log(JSON.stringify(results.slice(0, 10).map(r => ({
        config_hash: r.config_hash,
        score: r.score,
        rejected: r.rejected,
        rejection_reason: r.rejection_reason,
        metrics: r.metrics
    })), null, 2));
}

function defaultOptimizerConcurrency(): number {
    const available = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Math.min(4, available - 1));
}

function parseConcurrency(value: string | undefined, fallback: number): number {
    if (!value || value === "auto") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) throw new Error("--optimizer-concurrency must be a positive number or auto");
    return Math.floor(parsed);
}

function buildAdaptiveOptions(
    args: Record<string, string>,
    outputDir: string,
    onProgress: (progress: { completed: number; total: number }) => void,
    concurrency: number
): Partial<AdaptiveOptimizerOptions> {
    return {
        explorationTrials: Number(args["exploration-trials"] ?? 80),
        generationTrials: Number(args["generation-trials"] ?? 40),
        generations: Number(args.generations ?? 4),
        eliteCount: Number(args["elite-count"] ?? 8),
        nearMissCount: Number(args["near-miss-count"] ?? 8),
        noiseDecay: Number(args["noise-decay"] ?? 0.65),
        initialNoiseScale: Number(args["initial-noise-scale"] ?? 0.35),
        successiveHalving: args["successive-halving"] !== "false",
        halvingKeepRatio: Number(args["halving-keep-ratio"] ?? 0.35),
        sliceCount: Number(args["slice-count"] ?? 4),
        finalists: Number(args.finalists ?? 20),
        concurrency,
        outputDir,
        onProgress
    };
}

function buildProgressLogger(label: string): (progress: { completed: number; total: number }) => void {
    let lastLog = 0;
    const started = Date.now();
    return progress => {
        const now = Date.now();
        if (progress.completed < progress.total && now - lastLog < 5000) return;
        lastLog = now;
        const elapsedSeconds = Math.max(1, Math.round((now - started) / 1000));
        const trialsPerSecond = progress.completed / elapsedSeconds;
        const etaSeconds = trialsPerSecond > 0
            ? Math.round((progress.total - progress.completed) / trialsPerSecond)
            : null;
        console.log(
            `[${label}] completed ${progress.completed}/${progress.total} trials` +
            ` (${trialsPerSecond.toFixed(2)}/s${etaSeconds === null ? "" : `, eta ${etaSeconds}s`})`
        );
    };
}

function parseArgs(argv: string[]): Record<string, string> {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        args[token.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
    return args;
}

function required(value: string | undefined, message: string): string {
    if (!value) throw new Error(message);
    return value;
}

function buildLlmConfig(args: Record<string, string>, policyName: string) {
    if (policyName !== "recorded_llm") return undefined;
    if (args["llm-enabled"] !== "true") throw new Error("recorded_llm requires --llm-enabled true");
    return {
        enabled: true,
        model: args["llm-model"] ?? "recorded",
        decisionsPath: required(args["llm-decisions"], "--llm-decisions is required for recorded_llm"),
        tracePath: args["llm-trace"],
        ollamaBaseUrl: args["ollama-url"]
    };
}

function buildScreeningConfig(baseConfig: typeof SCREENER_PRESETS[string], args: Record<string, string>): typeof SCREENER_PRESETS[string] {
    const clone = structuredClone(baseConfig);
    clone.topN = Number(args["screening-top-n"] ?? args["top-symbols"] ?? 15);
    return clone;
}

function buildSlTpExecution(args: Record<string, string>, agentConfig: typeof AGENT_PRESETS[string], network: "mainnet" | "testnet"): SlTpExecution {
    return {
        ordering: (args["sl-tp-ordering"] ?? "stop_first") as SlTpExecution["ordering"],
        slippageMode: (args["sl-tp-slippage-mode"] ?? "fallback") as SlTpExecution["slippageMode"],
        fallbackSlippageBps: Number(args["sl-tp-fallback-slippage-bps"] ?? agentConfig.network_profiles[network].slippage_model.min_bps)
    };
}

function buildScoreGates(args: Record<string, string>): OptimizerScoreGates {
    return {
        ...DEFAULT_OPTIMIZER_SCORE_GATES,
        minTrades: Number(args["min-trades"] ?? DEFAULT_OPTIMIZER_SCORE_GATES.minTrades),
        maxDrawdownBps: Number(args["max-drawdown-bps"] ?? DEFAULT_OPTIMIZER_SCORE_GATES.maxDrawdownBps),
        minProfitFactor: Number(args["min-profit-factor"] ?? DEFAULT_OPTIMIZER_SCORE_GATES.minProfitFactor),
        maxStopHitRate: Number(args["max-stop-hit-rate"] ?? DEFAULT_OPTIMIZER_SCORE_GATES.maxStopHitRate),
        maxSymbolConcentration: Number(args["max-symbol-concentration"] ?? DEFAULT_OPTIMIZER_SCORE_GATES.maxSymbolConcentration),
        maxRegimeConcentration: Number(args["max-regime-concentration"] ?? DEFAULT_OPTIMIZER_SCORE_GATES.maxRegimeConcentration),
        allowSyntheticCandles: args["allow-synthetic-candles"] === "true"
    };
}

function buildCoverageSummary(results: Array<{ rejected: boolean; rejection_reason?: string; coverage: unknown }>) {
    const rejectionCounts: Record<string, number> = {};
    for (const result of results) {
        if (!result.rejected) continue;
        const reason = result.rejection_reason ?? "unknown";
        rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    }
    return {
        trial_count: results.length,
        rejected_count: results.filter(result => result.rejected).length,
        accepted_count: results.filter(result => !result.rejected).length,
        rejection_counts: rejectionCounts,
        first_coverage: results[0]?.coverage ?? null
    };
}

function buildRandomOptimizerTrace(results: Awaited<ReturnType<WalkForwardOptimizer["randomSearch"]>>) {
    const rejection_counts = buildRejectionCounts(results);
    return {
        mode: "random" as OptimizerMode,
        generation_summaries: [{
            generation: 0,
            candidate_count: results.length,
            evaluated_count: results.length,
            cheap_evaluation_count: 0,
            full_evaluation_count: results.length,
            accepted_count: results.filter(result => !result.rejected).length,
            rejected_count: results.filter(result => result.rejected).length,
            elite_config_hashes: results.filter(result => !result.rejected).slice(0, 20).map(result => result.config_hash),
            near_miss_config_hashes: [],
            rejection_counts,
            score_distribution: distribution(results.map(result => result.score)),
            trade_count_distribution: distribution(results.map(result => result.metrics.trade_count))
        }],
        elite_config_hashes: results.filter(result => !result.rejected).slice(0, 20).map(result => result.config_hash),
        near_miss_config_hashes: [],
        rejection_counts,
        score_distribution: distribution(results.map(result => result.score)),
        trade_count_distribution: distribution(results.map(result => result.metrics.trade_count))
    };
}

function buildRejectionCounts(results: Array<{ rejected: boolean; rejection_reason?: string }>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const result of results) {
        if (!result.rejected) continue;
        const reason = result.rejection_reason ?? "unknown";
        counts[reason] = (counts[reason] ?? 0) + 1;
    }
    return counts;
}

function distribution(values: number[]) {
    const finite = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
    if (finite.length === 0) return { min: null, p25: null, median: null, p75: null, max: null, mean: null };
    return {
        min: round(finite[0]),
        p25: round(percentile(finite, 0.25)),
        median: round(percentile(finite, 0.50)),
        p75: round(percentile(finite, 0.75)),
        max: round(finite[finite.length - 1]),
        mean: round(finite.reduce((total, value) => total + value, 0) / finite.length)
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

function round(value: number): number {
    if (!Number.isFinite(value)) return value;
    return Math.round(value * 10000) / 10000;
}

function buildInSampleSummary(
    results: Awaited<ReturnType<WalkForwardOptimizer["randomSearch"]>>,
    scoreGates: OptimizerScoreGates,
    optimizerMode: OptimizerMode
) {
    const best = results.find(result => !result.rejected) ?? null;
    return {
        mode: optimizerMode === "adaptive" ? "in_sample_adaptive_search" : "in_sample_random_search",
        note: "backtest_optimize searches and ranks on the same window. It does not emit champion/challenger recommendations; use backtest_walkforward for out-of-sample aggregation.",
        score_gates: scoreGates,
        best_config_hash: best?.config_hash ?? null,
        best_score: best?.score ?? null,
        best_metrics: best?.metrics ?? null,
        best_agent_config: best?.agentConfig ?? null,
        best_screener_config: best?.screenerConfig ?? null
    };
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
