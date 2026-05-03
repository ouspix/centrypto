import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";
import { RegimeService } from "@/services/RegimeService";
import { MarketDerivedMetricsService } from "@/services/MarketDerivedMetricsService";
import { TraderContextBuilder } from "@/services/TraderContextBuilder";
import { TraderDecisionValidator } from "@/lib/trader/TraderDecisionValidator";
import { RiskCheckModule } from "@/lib/risk/RiskCheckModule";
import { assessDecisionsForRisk, buildBackendDecisions } from "@/lib/trader/TraderWorkflow";
import { CandidateRejectionDiagnostic, TraderContext, TraderContextDiagnostics, TraderDecision } from "@/types/trading";
import { hydrateArchiveForBacktest } from "./ArchiveHydrator";
import { BacktestDataSource } from "./BacktestDataSource";
import { BacktestPortfolio } from "./BacktestPortfolio";
import { BacktestRunConfig, BacktestRunResult, CoverageReport, ExecutionResult, ForwardOutcome } from "./BacktestTypes";
import { ExecutionSimulator } from "./ExecutionSimulator";
import { MetricsReporter } from "./MetricsReporter";
import { buildDecisionProvider, buildManagementPolicy } from "./TraderPolicies";

export class BacktestRunner {
    private readonly regimeService = new RegimeService();
    private readonly derivedMetrics = new MarketDerivedMetricsService();
    private readonly contextBuilder = new TraderContextBuilder(async () => 0);
    private readonly validator = new TraderDecisionValidator();
    private readonly risk = new RiskCheckModule();

    public async run(config: BacktestRunConfig): Promise<BacktestRunResult> {
        if (config.hydration?.enabled) {
            await hydrateArchiveForBacktest({
                start: config.start,
                end: config.end,
                symbols: config.hydration.symbols,
                universeSize: config.hydration.universeSize,
                downloadConcurrency: config.hydration.downloadConcurrency,
                intervalSeconds: config.intervalSeconds,
                dbPath: config.featureDbPath,
                lookbackHours: config.hydration.lookbackHours,
                tmpRoot: config.hydration.tmpRoot,
                keepTmp: config.hydration.keepTmp
            });
        }

        const runId = config.runId ?? buildRunId(config);
        const writeArtifacts = config.writeArtifacts !== false;
        const outDir = path.join(process.cwd(), "data", "backtests", runId);
        if (writeArtifacts) await fs.mkdir(outDir, { recursive: true });

        const dataSource = await BacktestDataSource.create({
            network: config.network,
            start: config.start,
            end: config.end,
            intervalSeconds: config.intervalSeconds,
            agentConfig: config.agentConfig,
            screenerConfig: config.screeningConfig,
            featureDbPath: config.featureDbPath,
            cache: config.cacheDataSource === true && !config.hydration?.enabled,
            universeSymbols: config.universeSymbols,
            loadExecutionBooks: config.loadExecutionBooks ?? (
                config.slTpExecution
                    ? config.slTpExecution.slippageMode === "book_or_fallback"
                    : true
            )
        });
        const coverage = dataSource.getCoverageReport();
        if (writeArtifacts) await writeJson(path.join(outDir, "coverage.json"), coverage);
        if (coverage.synthetic_execution_candles && !config.suppressConsoleWarnings) {
            console.warn(`[backtest] Execution candles are ${coverage.candle_source}; SL/TP path simulation is approximate.`);
        }
        assertCoverageUsable(coverage);

        const portfolio = new BacktestPortfolio(config.initialCapitalUsd, config.agentConfig);
        const execution = new ExecutionSimulator(config.agentConfig, config.network, config.slTpExecution ?? {
            ordering: "stop_first",
            slippageMode: "fallback",
            fallbackSlippageBps: config.agentConfig.network_profiles[config.network].slippage_model.min_bps
        });
        const management = buildManagementPolicy(config.managementPolicyName, config.agentConfig);
        const llmConfig = config.llm
            ? {
                ...config.llm,
                tracePath: config.llm.tracePath ?? path.join(outDir, "llm_decisions.jsonl")
            }
            : undefined;
        if (!writeArtifacts && llmConfig?.tracePath) {
            await fs.mkdir(path.dirname(llmConfig.tracePath), { recursive: true });
        }
        const policy = buildDecisionProvider({
            decisionMode: config.decisionMode,
            policyName: config.policyName,
            managementPolicy: management,
            positions: portfolio.positions,
            llmConfig,
            agentConfig: config.agentConfig
        });
        const timestamps = dataSource.getTimestamps();

        if (writeArtifacts) await writeJson(path.join(outDir, "config.json"), {
            ...serializableConfig(config),
            run_id: runId,
            git_commit: gitCommit(),
            execution_candles: {
                candle_source: coverage.candle_source,
                synthetic_execution_candles: coverage.synthetic_execution_candles
            },
            sl_tp_execution: config.slTpExecution ?? {
                ordering: "stop_first",
                slippageMode: "fallback",
                fallbackSlippageBps: config.agentConfig.network_profiles[config.network].slippage_model.min_bps
            }
        });

        let previousTs = new Date(config.start.getTime() - config.intervalSeconds * 1000);
        for (const ts of timestamps) {
            if (ts < config.start || ts > config.end) continue;

            for (const position of [...portfolio.positions.values()]) {
                const candles = dataSource.getCandles(position.symbol, previousTs, ts);
                execution.advancePositionWithCandles(position, candles, portfolio, (symbol, timestamp) => dataSource.getExecutionBook(symbol, timestamp));
            }

            const heldSymbols = Array.from(portfolio.positions.keys());
            const markets = dataSource.getMarkets(ts, heldSymbols);
            const account = portfolio.buildAccountState(markets, ts);
            const backtestSnapshot = dataSource.getSnapshot(ts, account, markets);
            const snapshot = backtestSnapshot.state;
            snapshot.global_regime = this.regimeService.infer(snapshot.markets);
            this.derivedMetrics.applyDerivedMetrics(snapshot.markets, config.agentConfig, snapshot.global_regime.current, config.network === "testnet");

            const { context, diagnostics } = await this.contextBuilder.build(
                snapshot,
                config.agentConfig,
                config.network === "testnet",
                config.agentPresetName
            );
            const traderDecisions = await policy.decide(context);
            const validation = this.validator.validateBatch(traderDecisions, context);
            if ((config.decisionMode ?? config.policyName) === "real_llm" && llmConfig?.tracePath) {
                await appendJsonl(path.join(outDir, "llm_validation.jsonl"), {
                    ts: ts.toISOString(),
                    timestamp: Math.floor(ts.getTime() / 1000),
                    snapshot_id: context.snapshot_id,
                    accepted: validation.accepted,
                    reason: validation.reason,
                    decision_count: traderDecisions.length
                });
            }
            const executable = validation.accepted ? buildBackendDecisions(traderDecisions, context, "accepted") : [];
            const { approvedDecisions } = assessDecisionsForRisk(executable, snapshot, this.risk);

            const executionResults = execution.apply(approvedDecisions, snapshot.markets, portfolio, ts, (symbol, timestamp) => dataSource.getExecutionBook(symbol, timestamp));
            portfolio.markToMarket(ts, snapshot.markets);
            if (writeArtifacts) {
                await appendJsonl(path.join(outDir, "equity.jsonl"), { ts: ts.toISOString(), equity_usd: portfolio.equityUsd });
                await appendCandidateJournal(path.join(outDir, "candidates.jsonl"), {
                    context,
                    decisions: traderDecisions,
                    validatorReason: validation.reason,
                    validationAccepted: validation.accepted,
                    executionResults,
                    diagnostics,
                    config,
                    dataSource,
                    ts
                });
            }

            previousTs = ts;
        }

        if (writeArtifacts) await writeJsonl(path.join(outDir, "trades.jsonl"), portfolio.trades.map(serializeTrade));
        const metrics = MetricsReporter.build(config.initialCapitalUsd, portfolio.equityCurve, portfolio.trades, {
            screeningPresetName: config.screeningPresetName,
            agentPresetName: config.agentPresetName,
            traderPolicyName: config.decisionMode ?? config.policyName
        });
        metrics.candle_source = coverage.candle_source;
        metrics.synthetic_execution_candles = coverage.synthetic_execution_candles;
        if (coverage.missing_candle_intervals.length > 0) {
            metrics.warnings = [
                ...(metrics.warnings ?? []),
                `Execution candle coverage has ${coverage.missing_candle_intervals.length} missing interval(s); SL/TP advancement may miss exits for affected symbols.`
            ];
        }
        if (coverage.synthetic_execution_candles) {
            metrics.warnings = [
                ...(metrics.warnings ?? []),
                "Execution candles include synthetic candles derived from feature rows; SL/TP path results are approximate."
            ];
        }
        if (writeArtifacts) await writeJson(path.join(outDir, "metrics.json"), metrics);

        return {
            run_id: runId,
            config,
            coverage,
            metrics,
            trades: portfolio.trades,
            equity_curve: portfolio.equityCurve
        };
    }

}

function assertCoverageUsable(coverage: CoverageReport): void {
    if (coverage.available_timestamps === 0) {
        throw new Error("No MarketFeature timestamps available for requested run window.");
    }
}

async function appendCandidateJournal(
    filePath: string,
    args: {
        context: TraderContext;
        decisions: TraderDecision[];
        validatorReason: string;
        validationAccepted: boolean;
        executionResults: ExecutionResult[];
        diagnostics: TraderContextDiagnostics;
        config: BacktestRunConfig;
        dataSource: BacktestDataSource;
        ts: Date;
    }
): Promise<void> {
    const { context, decisions, validatorReason, validationAccepted, executionResults, diagnostics, config, dataSource, ts } = args;
    const rows = context.eligible_candidates.map(candidate => {
        const decision = decisions.find(d => d.candidate_id === candidate.candidate_id);
        const execution = executionResults.find(result => result.candidate_id === candidate.candidate_id);
        const outcome = dataSource.getForwardOutcome(candidate.symbol, ts, candidate.side);
        return {
            ts: new Date(context.timestamp * 1000).toISOString(),
            symbol: candidate.symbol,
            screening_preset: config.screeningPresetName,
            agent_preset: config.agentPresetName,
            trading_mode: config.network,
            regime_current: context.global_regime,
            regime_bias: null,
            regime_activity: null,
            regime_structure: null,
            screened: true,
            eligible: true,
            economic_review: false,
            near_miss: false,
            candidate_id: candidate.candidate_id,
            playbook: candidate.eligible_playbooks[0],
            side: candidate.side,
            reject_reason: null,
            closest_playbook: candidate.eligible_playbooks[0],
            rank: candidate.market_quality.rank,
            edge_bps: candidate.market_quality.edge_bps,
            cost_bps: candidate.market_quality.cost_bps,
            edge_to_cost_mult: candidate.market_quality.edge_to_cost_mult,
            cost_to_stop_ratio: candidate.risk.cost_to_stop_ratio,
            cost_to_tp_ratio: candidate.risk.cost_to_tp_ratio,
            depth_usd: candidate.market_quality.min_depth_usd,
            spread_bps: null,
            book_pressure: candidate.market_quality.book_pressure,
            vol_ratio: candidate.market_quality.vol_ratio_5m_vs_1h,
            ret_sigma: candidate.market_quality.ret_sigma_5m_vs_1h,
            trend_aligned: candidate.market_quality.trend_aligned,
            warnings: candidate.warnings,
            llm_action: null,
            baseline_action: decision?.action ?? null,
            validator_status: validationAccepted ? "accepted" : "rejected",
            validator_reason: validatorReason,
            execution_status: resolveExecutionStatus(decision, execution, validationAccepted),
            execution_reason: execution?.reason ?? null,
            fill_price: execution?.fill_price ?? null,
            requested_notional_usd: execution?.requested_notional_usd ?? null,
            filled_notional_usd: execution?.filled_notional_usd ?? null,
            fees_usd: execution?.fees_usd ?? null,
            slippage_bps: execution?.slippage_bps ?? null,
            used_book_fill: execution?.used_book ?? null,
            trade_id: execution?.trade_id ?? null,
            ...outcome
        };
    });

    for (const rejection of diagnostics.top_rejections) {
        rows.push(buildRejectedCandidateJournalRow({
            rejection,
            context,
            config,
            outcome: dataSource.getForwardOutcome(rejection.symbol, ts, inferSideFromDiagnostic(rejection))
        }) as any);
    }

    rows.push({
        ts: new Date(context.timestamp * 1000).toISOString(),
        type: "diagnostics",
        screening_preset: config.screeningPresetName,
        agent_preset: config.agentPresetName,
        trading_mode: config.network,
        diagnostics
    } as any);
    for (const row of rows) await appendJsonl(filePath, row);
}

function resolveExecutionStatus(
    decision: TraderDecision | undefined,
    execution: ExecutionResult | undefined,
    validationAccepted: boolean
): string {
    if (!decision) return "no_policy_decision";
    if (!validationAccepted) return "validator_rejected";
    if (decision.action === "SKIP" || decision.action === "HOLD_POSITION") return "policy_no_execution";
    if (!execution) return "not_attempted";
    if (execution.success) return "executed";
    return execution.attempted ? "execution_failed" : "not_attempted";
}

function buildRejectedCandidateJournalRow(args: {
    rejection: CandidateRejectionDiagnostic;
    context: TraderContext;
    config: BacktestRunConfig;
    outcome: ForwardOutcome;
}): Record<string, unknown> {
    const { rejection, context, config, outcome } = args;
    const closestPlaybook = rejection.triggered_playbooks[0] ?? rejection.eligible_playbooks[0] ?? null;
    return {
        ts: new Date(context.timestamp * 1000).toISOString(),
        symbol: rejection.symbol,
        screening_preset: config.screeningPresetName,
        agent_preset: config.agentPresetName,
        trading_mode: config.network,
        regime_current: context.global_regime,
        regime_bias: null,
        regime_activity: null,
        regime_structure: null,
        screened: true,
        eligible: false,
        economic_review: false,
        near_miss: isNearMissRejection(rejection),
        candidate_id: null,
        playbook: null,
        side: inferSideFromDiagnostic(rejection),
        reject_reason: rejection.reasons.join("|"),
        closest_playbook: closestPlaybook,
        rank: rejection.rank,
        edge_bps: rejection.edge_bps,
        cost_bps: rejection.cost_bps,
        edge_to_cost_mult: rejection.edge_to_cost_mult,
        cost_to_stop_ratio: null,
        cost_to_tp_ratio: null,
        depth_usd: rejection.min_depth_usd,
        spread_bps: null,
        book_pressure: null,
        vol_ratio: null,
        ret_sigma: null,
        trend_aligned: null,
        llm_action: null,
        baseline_action: null,
        validator_status: null,
        execution_status: "rejected_before_policy",
        ...outcome
    };
}

function inferSideFromDiagnostic(rejection: CandidateRejectionDiagnostic): "long" | "short" | null {
    const playbook = rejection.triggered_playbooks[0] ?? rejection.eligible_playbooks[0] ?? "";
    if (playbook.endsWith(":long")) return "long";
    if (playbook.endsWith(":short")) return "short";
    return null;
}

function isNearMissRejection(rejection: CandidateRejectionDiagnostic): boolean {
    const nearMissReasons = new Set(["COST_SANITY_GATE", "SIZE_GATE", "RISK_NOT_ELIGIBLE", "LONG_REGIME_BLOCK", "SHORT_REGIME_BLOCK"]);
    return rejection.reasons.some(reason => nearMissReasons.has(reason));
}

function buildRunId(config: BacktestRunConfig): string {
    const policy = config.decisionMode ?? config.policyName;
    return `${policy}_${config.start.toISOString().replace(/[:.]/g, "")}_${config.end.toISOString().replace(/[:.]/g, "")}_${config.seed}`;
}

function gitCommit(): string | null {
    try {
        return execSync("git rev-parse HEAD", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
        return null;
    }
}

function serializableConfig(config: BacktestRunConfig): Record<string, unknown> {
    return {
        ...config,
        start: config.start.toISOString(),
        end: config.end.toISOString()
    };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
    await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeJsonl(filePath: string, values: unknown[]): Promise<void> {
    await fs.writeFile(filePath, values.map(value => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""), "utf8");
}

function serializeTrade(trade: any): unknown {
    return {
        ...trade,
        entry_ts: trade.entry_ts.toISOString(),
        exit_ts: trade.exit_ts.toISOString()
    };
}
