import { hydrateArchiveForBacktest, HydrateArchiveOptions, HydrateArchiveResult } from "./ArchiveHydrator";
import {
    assertNoDisallowedSyntheticCandles,
    getRealCandleCoverageReport,
    hydrateRealCandlesForBacktest,
    HydrateRealCandlesResult
} from "./RealCandleHydrator";
import { OptimizerScoreGates } from "./WalkForwardOptimizer";

export type BacktestHydrationOptions = {
    hydrateArchive: boolean;
    hydrateRealCandles: boolean;
    archive: HydrateArchiveOptions;
    network: "mainnet" | "testnet";
    realCandleConcurrency?: number;
    preferNodeFillArchiveForRealCandles?: boolean;
};

export type BacktestHydrationResult = {
    archive: HydrateArchiveResult | null;
    realCandles: HydrateRealCandlesResult | null;
};

export type BacktestHydrationDeps = {
    hydrateArchive: typeof hydrateArchiveForBacktest;
    hydrateRealCandles: typeof hydrateRealCandlesForBacktest;
};

export async function hydrateBacktestDataForRun(
    options: BacktestHydrationOptions,
    deps: BacktestHydrationDeps = {
        hydrateArchive: hydrateArchiveForBacktest,
        hydrateRealCandles: hydrateRealCandlesForBacktest
    }
): Promise<BacktestHydrationResult> {
    const shouldHydrateArchive = options.hydrateArchive || options.hydrateRealCandles;
    const archive = shouldHydrateArchive
        ? await deps.hydrateArchive(options.archive)
        : null;
    const realCandles = options.hydrateRealCandles
        ? await deps.hydrateRealCandles({
            symbols: requiredArchive(archive).symbols,
            network: options.network,
            start: options.archive.start,
            end: options.archive.end,
            dbPath: options.archive.dbPath,
            concurrency: options.realCandleConcurrency,
            preferNodeFillArchive: options.preferNodeFillArchiveForRealCandles,
            tmpRoot: options.archive.tmpRoot,
            keepTmp: options.archive.keepTmp
        })
        : null;

    if (realCandles && !realCandles.coverage.complete) {
        const sourceHint = realCandles.candlesFetched === 0
            ? "fetched 0 candles from candleSnapshot and node-fill archive"
            : `fetched ${realCandles.candlesFetched} candles but still has gaps`;
        throw new Error(
            `Real candle hydration incomplete (${sourceHint}) for ` +
            `${options.archive.start.toISOString()}..${options.archive.end.toISOString()}: ` +
            formatMissingRealCandles(realCandles.coverage.missingBySymbol)
        );
    }

    return { archive, realCandles };
}

export async function assertOptimizerCandlePreflight(options: {
    dbPath?: string;
    start: Date;
    end: Date;
    symbols?: string[];
    scoreGates: OptimizerScoreGates;
    hydrateRealCandlesRequested: boolean;
}): Promise<void> {
    if (options.hydrateRealCandlesRequested && options.symbols?.length) {
        const coverage = await getRealCandleCoverageReport({
            symbols: options.symbols,
            start: options.start,
            end: options.end,
            dbPath: options.dbPath
        });
        if (!coverage.complete) {
            throw new Error(`Real candle coverage missing after hydration: ${formatMissingRealCandles(coverage.missingBySymbol)}`);
        }
    }

    await assertNoDisallowedSyntheticCandles({
        symbols: options.symbols,
        start: options.start,
        end: options.end,
        dbPath: options.dbPath,
        allowSyntheticCandles: options.scoreGates.allowSyntheticCandles
    });
}

function requiredArchive(archive: HydrateArchiveResult | null): HydrateArchiveResult {
    if (!archive) throw new Error("--hydrate-real-candles true requires archive hydration to select the historical universe.");
    return archive;
}

function formatMissingRealCandles(missingBySymbol: Record<string, string[]>): string {
    return Object.entries(missingBySymbol)
        .map(([symbol, missing]) => `${symbol}:${missing.slice(0, 5).join(",")}${missing.length > 5 ? `,+${missing.length - 5} more` : ""}`)
        .join(" ");
}
