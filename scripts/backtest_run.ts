import { AGENT_PRESETS } from "@/lib/agent-config";
import { SCREENER_PRESETS } from "@/lib/screener-config";
import { BacktestRunner } from "@/src/backtest/BacktestRunner";

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const agentPresetName = args.agent ?? args["base-agent"] ?? "Momentum Moderate";
    const screeningPresetName = args.screening ?? "Momentum Moderate";
    const agentConfig = AGENT_PRESETS[agentPresetName];
    const screeningConfig = SCREENER_PRESETS[screeningPresetName];
    if (!agentConfig) throw new Error(`Unknown agent preset: ${agentPresetName}`);
    if (!screeningConfig) throw new Error(`Unknown screening preset: ${screeningPresetName}`);

    const start = new Date(required(args.start, "--start is required"));
    const end = new Date(required(args.end, "--end is required"));
    const intervalSeconds = Number(args["interval-seconds"] ?? 10);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
        throw new Error("Invalid --start/--end window");
    }

    if (args["hydrate-archive"] === "true" || args.hydrate === "true") {
        required(args.symbols, "--symbols BTC,ETH,SOL is required when --hydrate-archive true");
    }
    const policyName = (args.policy ?? "take_top_rank") as any;
    const llm = buildLlmConfig(args, policyName);

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
        managementPolicyName: (args.management ?? "playbook_aware") as any,
        seed: Number(args.seed ?? 1),
        featureDbPath: args.db,
        runId: args["run-id"],
        hydration: args["hydrate-archive"] === "true" || args.hydrate === "true"
            ? {
                enabled: true,
                symbols: parseSymbols(args.symbols),
                lookbackHours: Number(args["lookback-hours"] ?? 1),
                tmpRoot: args["tmp-root"],
                keepTmp: args["keep-tmp"] === "true"
            }
            : undefined,
        llm
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

function parseSymbols(value: string): string[] {
    return value.split(",").map(symbol => symbol.trim()).filter(Boolean);
}

function buildLlmConfig(args: Record<string, string>, policyName: string) {
    if (policyName !== "real_llm" && policyName !== "recorded_llm") return undefined;
    if (args["llm-enabled"] !== "true") {
        throw new Error(`${policyName} requires --llm-enabled true`);
    }
    return {
        enabled: true,
        model: args["llm-model"] ?? args.model ?? "llama3.1",
        decisionsPath: args["llm-decisions"],
        tracePath: args["llm-trace"],
        ollamaBaseUrl: args["ollama-url"]
    };
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
