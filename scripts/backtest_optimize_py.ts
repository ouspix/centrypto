import { spawn } from "child_process";
import { selectTopBacktestSymbolsFromDb } from "@/src/backtest/ArchiveHydrator";
import { hydrateBacktestDataForRun } from "@/src/backtest/BacktestHydration";

const PYTHON_ONLY_ARGS = new Set([
    "data",
    "symbols"
]);

const ORCHESTRATOR_ONLY_ARGS = new Set([
    "db",
    "hydrate",
    "hydrate-archive",
    "hydrate-real-candles",
    "download-concurrency",
    "candle-concurrency",
    "prefer-node-fill-archive",
    "lookback-hours",
    "tmp-root",
    "keep-tmp",
    "skip-synthetic-candles",
    "prepare-parquet",
    "include-books",
    "python"
]);

async function main() {
    const rawArgv = process.argv.slice(2);
    const args = parseArgs(rawArgv);
    const start = new Date(required(args.start, "--start is required"));
    const end = new Date(required(args.end, "--end is required"));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
        throw new Error("Invalid --start/--end window");
    }

    const dbPath = args.db ?? "prisma/backtest.db";
    const dataRoot = args.data ?? "data/backtest_parquet";
    const intervalSeconds = Number(args["interval-seconds"] ?? 10);
    const topSymbols = Number(args["universe-size"] ?? args["top-symbols"] ?? 30);
    const network = (args.network ?? "mainnet") as "mainnet" | "testnet";
    const hydrateArchive = args["hydrate-archive"] !== "false" && args.hydrate !== "false";
    const hydrateRealCandles = args["hydrate-real-candles"] === "true";
    const prepareParquet = args["prepare-parquet"] !== "false";

    if (args.symbols) {
        throw new Error("--symbols is selected by the hydration/export preflight. Use --top-symbols to change the universe size.");
    }

    const hydration = await hydrateBacktestDataForRun({
        hydrateArchive,
        hydrateRealCandles,
        network,
        realCandleConcurrency: Number(args["candle-concurrency"] ?? args["download-concurrency"] ?? 4),
        preferNodeFillArchiveForRealCandles: args["prefer-node-fill-archive"] === "true",
        archive: {
            start,
            end,
            intervalSeconds,
            dbPath,
            universeSize: topSymbols,
            downloadConcurrency: Number(args["download-concurrency"] ?? 6),
            lookbackHours: Number(args["lookback-hours"] ?? 1),
            tmpRoot: args["tmp-root"],
            keepTmp: args["keep-tmp"] === "true",
            skipSyntheticCandles: args["skip-synthetic-candles"] === "true"
        }
    });

    const symbols = hydration.archive?.symbols?.filter(Boolean) ?? await selectTopBacktestSymbolsFromDb({
        dbPath,
        start,
        end,
        intervalSeconds,
        limit: topSymbols
    });
    if (symbols.length === 0) {
        throw new Error("Unable to select optimizer universe. Run with hydration enabled or hydrate the requested window first.");
    }
    if (symbols.length < topSymbols) {
        console.warn(`[backtest:optimize:py] Requested ${topSymbols} symbols but only ${symbols.length} are available: ${symbols.join(",")}`);
    } else {
        console.log(`[backtest:optimize:py] Using optimizer universe (${symbols.length}): ${symbols.join(",")}`);
    }

    const python = args.python ?? process.env.BACKTEST_PYTHON ?? ".venv-backtest/bin/python";
    if (prepareParquet) {
        await runCommand(python, [
            "scripts/backtest_parquet.py",
            "export",
            "--db", dbPath,
            "--out", dataRoot,
            "--start", args.start,
            "--end", args.end,
            "--interval-seconds", String(intervalSeconds),
            "--symbols", symbols.join(","),
            "--include-books", args["include-books"] ?? "meta",
            "--overwrite"
        ]);
    } else {
        console.log("[backtest:optimize:py] Skipping Parquet export because --prepare-parquet false was passed.");
    }

    const pythonArgs = filteredPythonArgs(rawArgv);
    pythonArgs.push("--data", dataRoot, "--symbols", symbols.join(","));
    await runCommand(python, ["scripts/backtest_optimize_polars.py", ...pythonArgs]);
}

function filteredPythonArgs(argv: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) {
            out.push(token);
            continue;
        }
        const key = token.slice(2);
        const hasValue = argv[i + 1] && !argv[i + 1].startsWith("--");
        if (ORCHESTRATOR_ONLY_ARGS.has(key) || PYTHON_ONLY_ARGS.has(key)) {
            if (hasValue) i++;
            continue;
        }
        out.push(token);
        if (hasValue) out.push(argv[++i]);
    }
    return out;
}

function runCommand(command: string, args: string[]): Promise<void> {
    console.log(`[backtest:optimize:py] $ ${[command, ...args].join(" ")}`);
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: "inherit", shell: false });
        child.on("error", reject);
        child.on("exit", code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} exited with code ${code}`));
            }
        });
    });
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

main().catch(error => {
    console.error(error);
    process.exit(1);
});
