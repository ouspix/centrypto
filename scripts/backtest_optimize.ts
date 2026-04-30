import fs from "fs/promises";
import path from "path";
import { AGENT_PRESETS } from "@/lib/agent-config";
import { SCREENER_PRESETS } from "@/lib/screener-config";
import { assertOptimizerCandlePreflight, hydrateBacktestDataForRun } from "@/src/backtest/BacktestHydration";
import { BacktestRunConfig } from "@/src/backtest/BacktestTypes";
import { DEFAULT_OPTIMIZER_SCORE_GATES, OptimizerScoreGates, WalkForwardOptimizer } from "@/src/backtest/WalkForwardOptimizer";

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
        preferNodeFillArchiveForRealCandles: true,
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
        suppressConsoleWarnings: true,
        llm: buildLlmConfig(args, policyName),
        slTpExecution: buildSlTpExecution(args, base, (args.network ?? "mainnet") as "mainnet" | "testnet")
    };

    const results = await optimizer.randomSearch(runConfig, trials, scoreGates);
    const outDir = args["output-dir"] ?? path.join("data", "backtests", args["run-id"] ?? "optimize");
    const out = args.output ?? path.join(outDir, "optimizer_results.json");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(results, null, 2));
    await fs.writeFile(path.join(path.dirname(out), "top_configs.json"), JSON.stringify(results.filter(r => !r.rejected).slice(0, 20), null, 2));
    await fs.writeFile(path.join(path.dirname(out), "coverage_summary.json"), JSON.stringify(buildCoverageSummary(results), null, 2));
    await fs.writeFile(path.join(path.dirname(out), "in_sample_summary.json"), JSON.stringify(buildInSampleSummary(results, scoreGates), null, 2));
    console.log(JSON.stringify(results.slice(0, 10).map(r => ({
        config_hash: r.config_hash,
        score: r.score,
        rejected: r.rejected,
        rejection_reason: r.rejection_reason,
        metrics: r.metrics
    })), null, 2));
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

function buildInSampleSummary(results: Awaited<ReturnType<WalkForwardOptimizer["randomSearch"]>>, scoreGates: OptimizerScoreGates) {
    const best = results.find(result => !result.rejected) ?? null;
    return {
        mode: "in_sample_random_search",
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
