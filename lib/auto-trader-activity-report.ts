import { buildActiveScreenerSummary, normalizeAutoTraderConfigOverride } from "@/lib/auto-trader-config";

type ReportInput = {
    generatedAt?: Date;
    settingsConfig?: unknown;
    latestSnapshotData?: unknown;
};

function safeParseJson(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function formatOptional(value: unknown): string {
    return value === null || value === undefined || value === "" ? "-" : String(value);
}

export function extractSnapshotScreenerConfig(snapshotData: unknown): unknown {
    const parsed = safeParseJson(snapshotData);
    if (!parsed || typeof parsed !== "object") return undefined;
    return (parsed as any).presets?.screening;
}

export function buildAutoTraderActivityReport(input: ReportInput): string {
    const settingsConfig = normalizeAutoTraderConfigOverride(safeParseJson(input.settingsConfig));
    const activeSummary = buildActiveScreenerSummary(settingsConfig);
    const snapshotScreener = extractSnapshotScreenerConfig(input.latestSnapshotData);
    const snapshotSummary = snapshotScreener
        ? buildActiveScreenerSummary({ screener: snapshotScreener })
        : null;
    const generatedAt = input.generatedAt ?? new Date();

    return [
        "# Auto-Trader Activity Report",
        "",
        `Generated: ${generatedAt.toISOString()}`,
        "",
        "## Active Server Screener",
        "",
        "| Field | Value |",
        "| --- | ---: |",
        `| Screener maxSpreadBps | ${formatOptional(activeSummary.maxSpreadBps)} |`,
        `| Screener minDepthUsd | ${formatOptional(activeSummary.minDepthUsd)} |`,
        `| Screener maxCostBps | ${formatOptional(activeSummary.maxCostBps)} |`,
        `| Screener topN | ${formatOptional(activeSummary.topN)} |`,
        `| Screener discoveryMaxSymbols | ${formatOptional(activeSummary.discoveryMaxSymbols)} |`,
        `| Screener hotMoverTopN | ${formatOptional(activeSummary.hotMoverTopN)} |`,
        `| Screener volumeSpikeTopN | ${formatOptional(activeSummary.volumeSpikeTopN)} |`,
        `| Screener rangeExpansionTopN | ${formatOptional(activeSummary.rangeExpansionTopN)} |`,
        `| Screener includeExecutionBlockedForDiagnostics | ${formatOptional(activeSummary.includeExecutionBlockedForDiagnostics)} |`,
        "",
        "## Latest Snapshot Screener",
        "",
        "| Field | Value |",
        "| --- | ---: |",
        `| Snapshot discoveryMaxSymbols | ${formatOptional(snapshotSummary?.discoveryMaxSymbols)} |`,
        `| Snapshot topN | ${formatOptional(snapshotSummary?.topN)} |`
    ].join("\n");
}
