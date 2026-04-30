import fs from "fs/promises";
import path from "path";
import { AGENT_PRESETS } from "@/lib/agent-config";
import { SCREENER_PRESETS } from "@/lib/screener-config";
import { BacktestRunConfig } from "@/src/backtest/BacktestTypes";
import { WalkForwardOptimizer } from "@/src/backtest/WalkForwardOptimizer";

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const agentPresetName = args["base-agent"] ?? args.agent ?? "Momentum Moderate";
    const screeningPresetName = args.screening ?? "Momentum Moderate";
    const base = AGENT_PRESETS[agentPresetName];
    const screening = SCREENER_PRESETS[screeningPresetName];
    if (!base || !screening) throw new Error("Unknown preset");
    const optimizer = new WalkForwardOptimizer();
    const start = new Date(required(args.start, "--start is required"));
    const end = new Date(required(args.end, "--end is required"));
    const policyName = (args.policy ?? "take_top_rank") as any;
    if (policyName === "real_llm") throw new Error("real_llm is disabled for walk-forward search. Use deterministic or recorded_llm policies.");
    const runConfig: BacktestRunConfig = {
        network: (args.network ?? "mainnet") as "mainnet" | "testnet",
        start,
        end,
        intervalSeconds: Number(args["interval-seconds"] ?? 10),
        initialCapitalUsd: Number(args.capital ?? 10000),
        screeningPresetName,
        agentPresetName,
        screeningConfig: screening,
        agentConfig: base,
        policyName,
        managementPolicyName: (args.management ?? "playbook_aware") as any,
        seed: Number(args.seed ?? 1),
        featureDbPath: args.db,
        runId: args["run-id"] ?? "walkforward",
        hydration: args["hydrate-archive"] === "true" || args.hydrate === "true"
            ? {
                enabled: true,
                symbols: parseSymbols(required(args.symbols, "--symbols BTC,ETH,SOL is required when --hydrate-archive true")),
                lookbackHours: Number(args["lookback-hours"] ?? 1),
                tmpRoot: args["tmp-root"],
                keepTmp: args["keep-tmp"] === "true"
            }
            : undefined,
        llm: buildLlmConfig(args, policyName)
    };

    const results = await optimizer.walkForward(runConfig, Number(args["train-days"] ?? 30), Number(args["test-days"] ?? 7), Number(args.trials ?? 100));
    const outDir = args["output-dir"] ?? path.join("data", "backtests", args["run-id"] ?? "walkforward");
    const out = args.output ?? path.join(outDir, "walkforward_results.json");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(results, null, 2));
    await fs.writeFile(path.join(path.dirname(out), "top_configs.json"), JSON.stringify(results.filter(r => !r.rejected).slice(0, 20), null, 2));
    await fs.writeFile(path.join(path.dirname(out), "coverage_summary.json"), JSON.stringify(buildCoverageSummary(results), null, 2));
    await fs.writeFile(path.join(path.dirname(out), "champion_challenger.json"), JSON.stringify(buildWalkForwardRecommendation(runConfig, results), null, 2));
    console.log(JSON.stringify(results.slice(0, 10).map(r => ({ score: r.score, rejected: r.rejected, rejection_reason: r.rejection_reason, metrics: r.metrics })), null, 2));
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

function parseSymbols(value: string): string[] {
    return value.split(",").map(symbol => symbol.trim()).filter(Boolean);
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

function buildWalkForwardRecommendation(runConfig: BacktestRunConfig, results: Awaited<ReturnType<WalkForwardOptimizer["walkForward"]>>) {
    const challenger = results.find(result => !result.rejected) ?? null;
    if (!challenger) {
        return {
            accepted: false,
            reason: "no viable out-of-sample challenger configs",
            challenger_score: null,
            challenger_metrics: null,
            challenger_config: null
        };
    }

    const accepted = challenger.score > 0 &&
        challenger.metrics.trade_count >= 30 &&
        challenger.metrics.one_symbol_concentration < 0.35 &&
        challenger.metrics.one_regime_concentration < 0.70;

    return {
        champion: runConfig.agentConfig,
        challenger: challenger.config,
        accepted,
        reason: accepted
            ? "challenger passes out-of-sample trade count and concentration gates"
            : "challenger does not pass positive-score/trade-count/concentration gates",
        challenger_score: challenger.score,
        challenger_metrics: challenger.metrics,
        challenger_config: challenger.config,
        note: "Recommendation only. This script never mutates production preset files."
    };
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
