import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { selectTopBacktestSymbolsFromDb } from "@/src/backtest/ArchiveHydrator";
import { hydrateBacktestDataForRun } from "@/src/backtest/BacktestHydration";

const PYTHON_ONLY_ARGS = new Set([
    "data",
    "symbols",
    "fold-universe-file"
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
    "python",
    "symbols-file",
    "universe-mode",
    "universe-size"
]);

type UniverseMode = "train_only" | "fixed_file" | "in_sample_auto" | "full_window_audit";

type WalkForwardFold = {
    fold_index: number;
    train_start: string;
    train_end: string;
    test_start: string;
    test_end: string;
    universe_selection_start: string;
    universe_selection_end: string;
    symbols: string[];
};

type UniverseRequest = {
    mode: UniverseMode;
    symbols?: string[];
    foldPlan?: WalkForwardFold[];
    requiresFullWindowSelectionAfterHydration: boolean;
};

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
    const outputDir = args["output-dir"]
        ? args["output-dir"]
        : args.output
            ? path.dirname(args.output)
            : path.join("data", "backtests", args["run-id"] ?? "optimize_py");
    const intervalSeconds = Number(args["interval-seconds"] ?? 10);
    const topSymbols = Number(args["universe-size"] ?? args["top-symbols"] ?? 30);
    const network = (args.network ?? "mainnet") as "mainnet" | "testnet";
    const hydrateArchive = args["hydrate-archive"] !== "false" && args.hydrate !== "false";
    const hydrateRealCandles = args["hydrate-real-candles"] === "true";
    const skipSyntheticCandles = args["skip-synthetic-candles"] !== "false";
    const prepareParquet = args["prepare-parquet"] !== "false";
    const isHoldout = parseBool(args.holdout, false);
    const isWalkForward = parseBool(args["walk-forward"], false);

    if (args.symbols) {
        throw new Error("--symbols is selected by the hydration/export preflight. Use --top-symbols, --universe-mode, or --symbols-file.");
    }

    const universeRequest = await buildUniverseRequest({
        args,
        dbPath,
        start,
        end,
        intervalSeconds,
        topSymbols,
        isHoldout,
        isWalkForward
    });

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
            symbols: universeRequest.requiresFullWindowSelectionAfterHydration ? undefined : universeRequest.symbols,
            universeSize: topSymbols,
            downloadConcurrency: Number(args["download-concurrency"] ?? 6),
            lookbackHours: Number(args["lookback-hours"] ?? 1),
            tmpRoot: args["tmp-root"],
            keepTmp: args["keep-tmp"] === "true",
            skipSyntheticCandles
        }
    });

    const finalizedUniverse = await finalizeUniverseRequest({
        request: universeRequest,
        hydratedSymbols: hydration.archive?.symbols,
        args,
        dbPath,
        start,
        end,
        intervalSeconds,
        topSymbols,
        isWalkForward,
        outputDir
    });
    const symbols = finalizedUniverse.symbols;
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
    if (finalizedUniverse.foldUniverseFile) {
        pythonArgs.push("--fold-universe-file", finalizedUniverse.foldUniverseFile);
    }
    await runCommand(python, ["scripts/backtest_optimize_polars.py", ...pythonArgs]);
}

async function buildUniverseRequest(options: {
    args: Record<string, string>;
    dbPath: string;
    start: Date;
    end: Date;
    intervalSeconds: number;
    topSymbols: number;
    isHoldout: boolean;
    isWalkForward: boolean;
}): Promise<UniverseRequest> {
    const defaultMode: UniverseMode = options.isHoldout || options.isWalkForward ? "train_only" : "in_sample_auto";
    const mode = parseUniverseMode(options.args["universe-mode"] ?? defaultMode);
    if ((options.isHoldout || options.isWalkForward) && mode === "in_sample_auto") {
        throw new Error("--universe-mode in_sample_auto is only allowed for plain in-sample Python optimize runs.");
    }

    if (mode === "fixed_file") {
        const symbolsFile = options.args["symbols-file"];
        if (!symbolsFile) throw new Error("--universe-mode fixed_file requires --symbols-file");
        const symbols = await readSymbolsFile(symbolsFile);
        if (symbols.length === 0) throw new Error(`No symbols found in ${symbolsFile}`);
        return {
            mode,
            symbols,
            foldPlan: options.isWalkForward ? buildFixedWalkForwardPlan(options.start, options.end, options.args, symbols) : undefined,
            requiresFullWindowSelectionAfterHydration: false
        };
    }

    if (mode === "train_only") {
        if (options.isWalkForward) {
            const foldPlan = await buildTrainOnlyWalkForwardPlan(options);
            return {
                mode,
                symbols: unionFoldSymbols(foldPlan),
                foldPlan,
                requiresFullWindowSelectionAfterHydration: false
            };
        }

        const selectionEnd = options.isHoldout
            ? addDays(options.start, Number(options.args["train-days"] ?? 10))
            : addDays(options.start, Number(options.args["train-days"] ?? 10));
        const symbols = await selectSymbolsFromDbOrFail({
            dbPath: options.dbPath,
            start: options.start,
            end: minDate(selectionEnd, options.end),
            intervalSeconds: options.intervalSeconds,
            limit: options.topSymbols,
            context: "train-only Python optimizer universe"
        });
        return { mode, symbols, requiresFullWindowSelectionAfterHydration: false };
    }

    return {
        mode,
        requiresFullWindowSelectionAfterHydration: true
    };
}

async function finalizeUniverseRequest(options: {
    request: UniverseRequest;
    hydratedSymbols?: string[];
    args: Record<string, string>;
    dbPath: string;
    start: Date;
    end: Date;
    intervalSeconds: number;
    topSymbols: number;
    isWalkForward: boolean;
    outputDir: string;
}): Promise<{ symbols: string[]; foldUniverseFile?: string }> {
    let symbols = options.request.symbols ?? [];
    let foldPlan = options.request.foldPlan;
    if (options.request.requiresFullWindowSelectionAfterHydration) {
        symbols = (options.hydratedSymbols?.filter(Boolean).map(normalizeBaseSymbol) ?? []);
        if (symbols.length === 0) {
            symbols = await selectSymbolsFromDbOrFail({
                dbPath: options.dbPath,
                start: options.start,
                end: options.end,
                intervalSeconds: options.intervalSeconds,
                limit: options.topSymbols,
                context: `${options.request.mode} Python optimizer universe`
            });
        }
        if (options.isWalkForward) {
            foldPlan = buildFixedWalkForwardPlan(options.start, options.end, options.args, symbols, {
                selectionStart: options.start,
                selectionEnd: options.end
            });
        }
    }

    let foldUniverseFile: string | undefined;
    if (foldPlan) {
        await fs.mkdir(options.outputDir, { recursive: true });
        foldUniverseFile = path.join(options.outputDir, "fold_universes.json");
        await fs.writeFile(
            foldUniverseFile,
            JSON.stringify({
                universe_mode: options.request.mode,
                union_symbols: unionFoldSymbols(foldPlan),
                folds: foldPlan
            }, null, 2)
        );
        for (const fold of foldPlan) {
            console.log(JSON.stringify({
                fold_index: fold.fold_index,
                universe_selection_start: fold.universe_selection_start,
                universe_selection_end: fold.universe_selection_end,
                test_start: fold.test_start,
                test_end: fold.test_end,
                symbols: fold.symbols
            }));
        }
    }

    return {
        symbols: normalizeSymbolList(symbols),
        foldUniverseFile
    };
}

async function buildTrainOnlyWalkForwardPlan(options: {
    args: Record<string, string>;
    dbPath: string;
    start: Date;
    end: Date;
    intervalSeconds: number;
    topSymbols: number;
}): Promise<WalkForwardFold[]> {
    const folds = buildWalkForwardFolds(options.start, options.end, Number(options.args["train-days"] ?? 10), Number(options.args["test-days"] ?? 3));
    if (folds.length === 0) {
        throw new Error("Walk-forward produced no folds. Reduce --train-days/--test-days or extend --start/--end.");
    }

    const out: WalkForwardFold[] = [];
    for (const fold of folds) {
        const symbols = await selectSymbolsFromDbOrFail({
            dbPath: options.dbPath,
            start: fold.trainStart,
            end: fold.trainEnd,
            intervalSeconds: options.intervalSeconds,
            limit: options.topSymbols,
            context: `walk-forward fold ${fold.foldIndex} train-only universe`
        });
        out.push({
            fold_index: fold.foldIndex,
            train_start: fold.trainStart.toISOString(),
            train_end: fold.trainEnd.toISOString(),
            test_start: fold.testStart.toISOString(),
            test_end: fold.testEnd.toISOString(),
            universe_selection_start: fold.trainStart.toISOString(),
            universe_selection_end: fold.trainEnd.toISOString(),
            symbols
        });
    }
    return out;
}

function buildFixedWalkForwardPlan(
    start: Date,
    end: Date,
    args: Record<string, string>,
    symbols: string[],
    selectionWindow?: { selectionStart: Date; selectionEnd: Date }
): WalkForwardFold[] {
    const folds = buildWalkForwardFolds(start, end, Number(args["train-days"] ?? 10), Number(args["test-days"] ?? 3));
    if (folds.length === 0) {
        throw new Error("Walk-forward produced no folds. Reduce --train-days/--test-days or extend --start/--end.");
    }
    const selectionStart = selectionWindow?.selectionStart ?? start;
    const selectionEnd = selectionWindow?.selectionEnd ?? start;
    return folds.map(fold => ({
        fold_index: fold.foldIndex,
        train_start: fold.trainStart.toISOString(),
        train_end: fold.trainEnd.toISOString(),
        test_start: fold.testStart.toISOString(),
        test_end: fold.testEnd.toISOString(),
        universe_selection_start: selectionStart.toISOString(),
        universe_selection_end: selectionEnd.toISOString(),
        symbols: normalizeSymbolList(symbols)
    }));
}

function buildWalkForwardFolds(start: Date, end: Date, trainDays: number, testDays: number): Array<{
    foldIndex: number;
    trainStart: Date;
    trainEnd: Date;
    testStart: Date;
    testEnd: Date;
}> {
    const folds = [];
    let trainStart = new Date(start);
    let foldIndex = 0;
    while (true) {
        const trainEnd = addDays(trainStart, trainDays);
        const testEnd = addDays(trainEnd, testDays);
        if (testEnd > end) break;
        folds.push({ foldIndex, trainStart, trainEnd, testStart: trainEnd, testEnd });
        trainStart = addDays(trainStart, testDays);
        foldIndex++;
    }
    return folds;
}

async function selectSymbolsFromDbOrFail(options: {
    dbPath: string;
    start: Date;
    end: Date;
    intervalSeconds: number;
    limit: number;
    context: string;
}): Promise<string[]> {
    const symbols = await selectTopBacktestSymbolsFromDb({
        dbPath: options.dbPath,
        start: options.start,
        end: options.end,
        intervalSeconds: options.intervalSeconds,
        limit: options.limit
    });
    const normalized = normalizeSymbolList(symbols);
    if (normalized.length === 0) {
        throw new Error(
            `Unable to select ${options.context} from ${options.start.toISOString()}..${options.end.toISOString()}. ` +
            "Train-only universe selection does not fall back to full-window hydration."
        );
    }
    return normalized;
}

async function readSymbolsFile(file: string): Promise<string[]> {
    const text = await fs.readFile(file, "utf8");
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return normalizeSymbolList(parsed.map(String));
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.symbols)) {
            return normalizeSymbolList(parsed.symbols.map(String));
        }
    } catch {
        // Fall through to comma/newline parsing.
    }
    return normalizeSymbolList(text.split(/[,\n\r\t ]+/).filter(Boolean));
}

function parseUniverseMode(value: string): UniverseMode {
    if (value === "train_only" || value === "fixed_file" || value === "in_sample_auto" || value === "full_window_audit") {
        return value;
    }
    throw new Error("--universe-mode must be train_only, fixed_file, in_sample_auto, or full_window_audit");
}

function normalizeSymbolList(symbols: string[]): string[] {
    return Array.from(new Set(symbols.map(normalizeBaseSymbol).filter(Boolean))).sort();
}

function normalizeBaseSymbol(symbol: string): string {
    return symbol.trim().replace(/-PERP$/i, "");
}

function unionFoldSymbols(folds: WalkForwardFold[]): string[] {
    return normalizeSymbolList(folds.flatMap(fold => fold.symbols));
}

function minDate(a: Date, b: Date): Date {
    return a <= b ? a : b;
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60_000);
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

function parseBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(text)) return true;
    if (["0", "false", "no", "n", "off"].includes(text)) return false;
    return fallback;
}

function isMainModule(): boolean {
    return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}
