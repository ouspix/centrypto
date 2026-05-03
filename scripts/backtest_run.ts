import { AGENT_PRESETS } from "@/lib/agent-config";
import { SCREENER_PRESETS } from "@/lib/screener-config";
import { selectTopBacktestSymbolsFromDb } from "@/src/backtest/ArchiveHydrator";
import { hydrateBacktestDataForRun } from "@/src/backtest/BacktestHydration";
import { BacktestRunner } from "@/src/backtest/BacktestRunner";
import { BacktestRunConfig } from "@/src/backtest/BacktestTypes";

type SlTpExecution = NonNullable<BacktestRunConfig["slTpExecution"]>;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const agentPresetName = args.agent ?? args["base-agent"] ?? "Momentum Moderate";
    const screeningPresetName = args.screening ?? "Momentum Moderate";
    const agentConfig = AGENT_PRESETS[agentPresetName];
    const screeningPreset = SCREENER_PRESETS[screeningPresetName];
    if (!agentConfig) throw new Error(`Unknown agent preset: ${agentPresetName}`);
    if (!screeningPreset) throw new Error(`Unknown screening preset: ${screeningPresetName}`);
    if (args.symbols) throw new Error("--symbols was removed from backtest runs. Hydration automatically selects the top historical universe; use --top-symbols to change the default 15.");
    const screeningConfig = buildScreeningConfig(screeningPreset, args);

    const start = new Date(required(args.start, "--start is required"));
    const end = new Date(required(args.end, "--end is required"));
    const intervalSeconds = Number(args["interval-seconds"] ?? 10);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
        throw new Error("Invalid --start/--end window");
    }

    const policyName = (args.policy ?? "main_app_deterministic") as any;
    const decisionMode = parseDecisionMode(args["decision-mode"], policyName);
    const llm = buildLlmConfig(args, decisionMode);
    const hydrateArchive = args["hydrate-archive"] === "true" || args.hydrate === "true";
    const hydrateRealCandles = args["hydrate-real-candles"] === "true";
    const hydration = await hydrateBacktestDataForRun({
        hydrateArchive,
        hydrateRealCandles,
        network: (args.network ?? "mainnet") as "mainnet" | "testnet",
        realCandleConcurrency: Number(args["candle-concurrency"] ?? args["download-concurrency"] ?? 4),
        archive: {
            start,
            end,
            intervalSeconds,
            dbPath: args.db,
            universeSize: Number(args["universe-size"] ?? args["top-symbols"] ?? 15),
            downloadConcurrency: Number(args["download-concurrency"] ?? 6),
            lookbackHours: Number(args["lookback-hours"] ?? 1),
            tmpRoot: args["tmp-root"],
            keepTmp: args["keep-tmp"] === "true",
            skipSyntheticCandles: args["skip-synthetic-candles"] === "true"
        }
    });
    const universeSymbols = await resolveRunUniverse(args, hydration.archive?.symbols, start, end, intervalSeconds);

    const result = await new BacktestRunner().run({
        network: (args.network ?? "mainnet") as "mainnet" | "testnet",
        start,
        end,
        intervalSeconds,
        initialCapitalUsd: Number(args.capital ?? 10000),
        screeningPresetName,
        agentPresetName,
        screeningConfig,
        agentConfig,
        policyName,
        decisionMode,
        managementPolicyName: (args.management ?? "never_close") as any,
        seed: Number(args.seed ?? 1),
        universeSymbols,
        featureDbPath: args.db,
        runId: args["run-id"],
        loadExecutionBooks: shouldLoadExecutionBooks(args),
        llm,
        slTpExecution: buildSlTpExecution(args, agentConfig, (args.network ?? "mainnet") as "mainnet" | "testnet")
    });

    console.log(JSON.stringify({
        run_id: result.run_id,
        metrics: result.metrics,
        coverage: result.coverage
    }, null, 2));
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

function parseDecisionMode(value: string | undefined, policyName: string): "deterministic" | "recorded_llm" | "real_llm" {
    if (value === "deterministic" || value === "recorded_llm" || value === "real_llm") return value;
    if (value) throw new Error("--decision-mode must be deterministic, recorded_llm, or real_llm");
    if (policyName === "real_llm" || policyName === "recorded_llm") return policyName;
    return "deterministic";
}

function buildLlmConfig(args: Record<string, string>, decisionMode: string) {
    if (decisionMode !== "real_llm" && decisionMode !== "recorded_llm") return undefined;
    if (args["llm-enabled"] !== "true") {
        throw new Error(`${decisionMode} requires --llm-enabled true`);
    }
    if (decisionMode === "recorded_llm" && !args["llm-decisions"]) {
        throw new Error("recorded_llm requires --llm-decisions");
    }
    return {
        enabled: true,
        model: args["llm-model"] ?? args.model ?? "llama3.1",
        decisionsPath: args["llm-decisions"],
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

async function resolveRunUniverse(
    args: Record<string, string>,
    hydratedSymbols: string[] | undefined,
    start: Date,
    end: Date,
    intervalSeconds: number
): Promise<string[]> {
    const hydrated = hydratedSymbols?.filter(Boolean) ?? [];
    const requestedSize = Number(args["universe-size"] ?? args["top-symbols"] ?? 15);
    const symbols = hydrated.length > 0
        ? hydrated
        : await selectTopBacktestSymbolsFromDb({
            dbPath: args.db,
            start,
            end,
            intervalSeconds,
            limit: requestedSize
        });
    if (symbols.length === 0) {
        throw new Error("Unable to select backtest universe from existing backtest DB. Run with --hydrate-archive true or hydrate the requested window first.");
    }
    console.log(`[backtest:run] Using universe (${symbols.length}): ${symbols.join(",")}`);
    return symbols;
}

function shouldLoadExecutionBooks(args: Record<string, string>): boolean {
    return args["load-execution-books"] === "true" || args["sl-tp-slippage-mode"] === "book_or_fallback";
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
