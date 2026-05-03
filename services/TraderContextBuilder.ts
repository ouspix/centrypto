import { AgentConfig } from "@/lib/agent-config";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { computeRiskPlan, inferSideFromPlaybook } from "@/lib/risk/shared";
import {
    CandidateRejectionDiagnostic,
    EligibleCandidate,
    ManagedPosition,
    Playbook,
    TraderContext,
    TraderContextDiagnostics,
    TradeSide
} from "@/types/trading";
import { GlobalRegime, MarketEntry, Position, StateSnapshot } from "@/types/snapshot";

const V1_PLAYBOOKS = new Set<Playbook>([
    "Momentum:long",
    "Momentum:short",
    "Breakout:long",
    "Breakout:short",
    "Mean Reversion:long",
    "Mean Reversion:short"
]);

type CandidateBuildResult = {
    context: TraderContext;
    candidateMap: Map<string, EligibleCandidate>;
    diagnostics: TraderContextDiagnostics;
};

type CandidateSelectionResult = {
    candidates: EligibleCandidate[];
    diagnostics: TraderContextDiagnostics;
};

export type CorrelationProvider = (symbolA: string, symbolB: string, isTestnet: boolean) => Promise<number>;

export class TraderContextBuilder {
    constructor(private readonly correlationProvider?: CorrelationProvider) {}

    public async build(
        snapshot: StateSnapshot,
        config: AgentConfig,
        isTestnet: boolean,
        profile = "active"
    ): Promise<CandidateBuildResult> {
        const existingPositions = this.buildManagedPositions(snapshot);
        const selection = await this.buildEligibleCandidates(snapshot, config, isTestnet, profile, existingPositions.length);
        const eligibleCandidates = selection.candidates;
        const candidateMap = new Map(eligibleCandidates.map(candidate => [candidate.candidate_id, candidate]));

        return {
            context: {
                snapshot_id: snapshot.meta?.snapshot_id ?? null,
                timestamp: snapshot.timestamp,
                global_regime: snapshot.global_regime.current,
                profile,
                portfolio: {
                    equity_usd: snapshot.account.equity_usd,
                    gross_exposure_fraction: snapshot.account.derived_portfolio?.total_exposure_fraction ?? 0,
                    remaining_capacity_fraction: snapshot.account.derived_portfolio?.remaining_capacity ?? 0,
                    daily_pnl_pct: snapshot.account.equity_usd > 0
                        ? (snapshot.account.daily_total_pnl_usd ?? 0) / snapshot.account.equity_usd
                        : 0,
                    kill_switch: snapshot.constraints.kill_switch
                },
                existing_positions: existingPositions,
                eligible_candidates: eligibleCandidates,
                max_new_trades_allowed: selection.diagnostics.max_new_trades_allowed
            },
            candidateMap,
            diagnostics: selection.diagnostics
        };
    }

    private async buildEligibleCandidates(
        snapshot: StateSnapshot,
        config: AgentConfig,
        isTestnet: boolean,
        profile: string,
        heldPositionCount: number
    ): Promise<CandidateSelectionResult> {
        const markets = Object.values(snapshot.markets || {})
            .sort((a, b) => (a.derived?.rank ?? Number.POSITIVE_INFINITY) - (b.derived?.rank ?? Number.POSITIVE_INFINITY));
        const rejectionCounts: Record<string, number> = {};
        const rejections: CandidateRejectionDiagnostic[] = [];
        const maxNewTrades = snapshot.constraints.max_new_trades_allowed ?? snapshot.constraints.max_new_positions_per_cycle;

        const reject = (market: MarketEntry, reasons: string[]) => {
            const uniqueReasons = Array.from(new Set(reasons.length ? reasons : ["UNKNOWN_FILTER"]));
            uniqueReasons.forEach(reason => {
                rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
            });
            rejections.push(this.buildRejectionDiagnostic(market, uniqueReasons));
        };

        if (snapshot.constraints.kill_switch) {
            markets.forEach(market => reject(market, ["KILL_SWITCH"]));
            return {
                candidates: [],
                diagnostics: this.buildDiagnostics(markets.length, heldPositionCount, 0, maxNewTrades, rejectionCounts, rejections)
            };
        }

        const heldSymbols = new Set((snapshot.account.current_positions || []).map(position => position.symbol));
        const candidates: EligibleCandidate[] = [];

        for (const market of markets) {
            if (heldSymbols.has(market.symbol)) {
                reject(market, ["HELD_POSITION"]);
                continue;
            }
            if (market.news_blocked) {
                reject(market, ["NEWS_BLOCKED"]);
                continue;
            }
            if (!market.derived) {
                reject(market, ["DERIVED_DATA_MISSING"]);
                continue;
            }

            const baseReasons: string[] = [];
            if (!market.derived.entry?.entry_ok) {
                baseReasons.push(...(market.derived.entry?.reasons_failed?.length ? market.derived.entry.reasons_failed : ["ENTRY_GATE"]));
            }
            if (!market.derived.liquidity?.tradeable) baseReasons.push("TRADEABLE_GATE");
            if (!market.derived.risk?.eligible) {
                const playbooks = market.derived.risk?.eligible_playbooks ?? [];
                baseReasons.push(playbooks.length > 0 ? "RISK_NOT_ELIGIBLE" : "NO_PLAYBOOK_TRIGGER");
            }
            if (baseReasons.length > 0) {
                reject(market, baseReasons);
                continue;
            }

            const playbooks = (market.derived.risk?.eligible_playbooks || [])
                .filter((playbook): playbook is Playbook => V1_PLAYBOOKS.has(playbook as Playbook));
            if (playbooks.length === 0) {
                reject(market, ["NO_V1_PLAYBOOK"]);
                continue;
            }

            const playbooksBySide = this.groupPlaybooksBySide(playbooks);
            let addedForMarket = false;
            const sideRejections: string[] = [];
            for (const [side, sidePlaybooks] of Object.entries(playbooksBySide) as [TradeSide, Playbook[]][]) {
                if (sidePlaybooks.length === 0) continue;
                const regime = this.applyRegimePolicy(snapshot.global_regime.current, side, sidePlaybooks, market, config);
                if (!regime.allowed) {
                    sideRejections.push(`${side.toUpperCase()}_REGIME_BLOCK`);
                    continue;
                }

                const primaryPlaybook = sidePlaybooks[0];
                const riskPlan = computeRiskPlan(primaryPlaybook, market, config, snapshot.global_regime.current, config.risk.max_effective_leverage);
                if (!riskPlan) {
                    sideRejections.push("RISK_PLAN_MISSING");
                    continue;
                }

                const risk = this.buildRiskFields(riskPlan, market);
                if (!this.costSanityOk(primaryPlaybook, risk, market, config)) {
                    sideRejections.push("COST_SANITY_GATE");
                    continue;
                }

                const correlation = await this.buildCorrelation(snapshot, market.symbol, side, isTestnet, config);
                const sizing = this.buildSizing(snapshot, config, market, side, riskPlan.stop_loss_pct, regime.multiplier, correlation);
                if (sizing.max_allowed_size_fraction <= 0 || sizing.suggested_size_fraction <= 0) {
                    sideRejections.push("SIZE_GATE");
                    continue;
                }

                const triggerMargin = {
                    ...(market.derived.risk?.trigger_diagnostics?.trigger_margin ?? {}),
                    regime_size_multiplier: regime.multiplier
                };

                const candidate: EligibleCandidate = {
                    candidate_id: this.buildCandidateId(market.symbol, side, primaryPlaybook),
                    symbol: market.symbol,
                    side,
                    eligible_playbooks: sidePlaybooks,
                    has_hard_trigger: true,
                    trigger_diagnostics: {
                        trigger_profile: profile,
                        triggered_playbooks: sidePlaybooks,
                        trigger_margin: triggerMargin
                    },
                    market_quality: {
                        rank: market.derived.rank ?? null,
                        cost_bps: market.derived.costs.cost_bps,
                        edge_bps: market.derived.edge.edge_bps,
                        edge_to_cost_mult: market.derived.entry?.edge_to_cost_mult ?? 0,
                        book_pressure: market.orderbook.book_pressure,
                        vol_ratio_5m_vs_1h: market.derived.normalized.vol_ratio_5m_vs_1h,
                        ret_sigma_5m_vs_1h: market.derived.normalized.ret_sigma_5m_vs_1h,
                        trend_aligned: market.derived.triggers.trend_aligned,
                        min_depth_usd: market.derived.liquidity.min_depth_usd
                    },
                    risk,
                    sizing,
                    correlation,
                    warnings: this.buildCandidateWarnings(snapshot.global_regime.current, side, correlation, regime.warnings)
                };

                candidates.push(candidate);
                addedForMarket = true;
            }

            if (!addedForMarket) {
                reject(market, sideRejections.length ? sideRejections : ["NO_SIDE_CANDIDATE"]);
            }
        }

        const limitedCandidates = candidates.slice(0, Math.max(0, maxNewTrades));
        return {
            candidates: limitedCandidates,
            diagnostics: this.buildDiagnostics(
                markets.length,
                heldPositionCount,
                limitedCandidates.length,
                maxNewTrades,
                rejectionCounts,
                rejections
            )
        };
    }

    private buildDiagnostics(
        screenedMarketCount: number,
        heldPositionCount: number,
        eligibleCandidateCount: number,
        maxNewTradesAllowed: number,
        rejectionCounts: Record<string, number>,
        rejections: CandidateRejectionDiagnostic[]
    ): TraderContextDiagnostics {
        return {
            screened_market_count: screenedMarketCount,
            held_position_count: heldPositionCount,
            eligible_candidate_count: eligibleCandidateCount,
            max_new_trades_allowed: maxNewTradesAllowed,
            rejection_counts: rejectionCounts,
            top_rejections: rejections
        };
    }

    private buildRejectionDiagnostic(market: MarketEntry, reasons: string[]): CandidateRejectionDiagnostic {
        return {
            symbol: market.symbol,
            rank: Number.isFinite(market.derived?.rank) ? market.derived!.rank! : null,
            reasons,
            edge_bps: market.derived?.edge?.edge_bps ?? null,
            cost_bps: market.derived?.costs?.cost_bps ?? null,
            edge_to_cost_mult: market.derived?.entry?.edge_to_cost_mult ?? null,
            min_depth_usd: market.derived?.liquidity?.min_depth_usd ?? null,
            tradeable: market.derived?.liquidity?.tradeable ?? null,
            eligible_playbooks: market.derived?.risk?.eligible_playbooks ?? [],
            triggered_playbooks: market.derived?.risk?.trigger_diagnostics?.triggered_playbooks ?? []
        };
    }

    private buildManagedPositions(snapshot: StateSnapshot): ManagedPosition[] {
        return (snapshot.account.current_positions || []).map(position => {
            const market = snapshot.markets[position.symbol];
            const marketSignal = this.buildPositionMarketSignal(position, market, snapshot.global_regime.current);
            const failureSignals = this.buildFailureSignals(position, marketSignal);
            const supportSignals = this.buildSupportSignals(marketSignal);
            const managementBias = this.computeManagementBias(position, marketSignal);

            return {
                symbol: position.symbol,
                side: position.side,
                exposure_fraction: position.fraction_of_equity,
                size_usd: position.size_usd,
                entry_price: position.entry_price,
                unrealized_pnl_usd: position.unrealized_pnl,
                market_signal: marketSignal,
                management_limits: {
                    can_hold: true,
                    can_reduce: true,
                    can_close: true,
                    can_increase: false,
                    max_increase_to_fraction: 0
                },
                management_bias: managementBias,
                failure_signals: failureSignals,
                support_signals: supportSignals
            };
        });
    }

    private buildPositionMarketSignal(position: Position, market: MarketEntry | undefined, regime: GlobalRegime["current"]): ManagedPosition["market_signal"] {
        if (!market?.derived) {
            return {
                edge_ok: false,
                entry_ok: false,
                risk_eligible: false,
                reasons_failed: ["market_data_missing"],
                book_pressure: null,
                book_pressure_side_alignment: "unknown",
                ret_sigma_5m_vs_1h: null,
                vol_ratio_5m_vs_1h: null,
                trend_aligned: false,
                regime_conflict: regime === "RISK_OFF" && position.side === "long"
            };
        }

        return {
            edge_ok: market.derived.edge.edge_ok,
            entry_ok: market.derived.entry?.entry_ok ?? false,
            risk_eligible: market.derived.risk?.eligible ?? false,
            reasons_failed: market.derived.entry?.reasons_failed ?? [],
            book_pressure: market.orderbook.book_pressure,
            book_pressure_side_alignment: this.bookPressureAlignment(position.side, market.orderbook.book_pressure),
            ret_sigma_5m_vs_1h: market.derived.normalized.ret_sigma_5m_vs_1h,
            vol_ratio_5m_vs_1h: market.derived.normalized.vol_ratio_5m_vs_1h,
            trend_aligned: market.derived.triggers.trend_aligned,
            regime_conflict: regime === "RISK_OFF" && position.side === "long"
        };
    }

    private buildFailureSignals(position: Position, signal: ManagedPosition["market_signal"]): string[] {
        const failures: string[] = [];
        if (!signal.edge_ok) failures.push("edge_ok_false");
        if (!signal.entry_ok) failures.push("entry_ok_false");
        if (!signal.risk_eligible) failures.push("risk_not_eligible");
        if (signal.book_pressure_side_alignment === "opposite") failures.push("book_pressure_opposite");
        if (signal.regime_conflict) failures.push("regime_conflict");
        if (position.side === "long" && signal.regime_conflict && (!signal.edge_ok || signal.book_pressure_side_alignment === "opposite")) {
            failures.push("risk_off_weak_long");
        }
        return failures;
    }

    private buildSupportSignals(signal: ManagedPosition["market_signal"]): string[] {
        const supports: string[] = [];
        if (signal.edge_ok) supports.push("edge_ok_true");
        if (signal.entry_ok) supports.push("entry_ok_true");
        if (signal.book_pressure_side_alignment === "supportive") supports.push("book_pressure_supportive");
        if (signal.trend_aligned) supports.push("trend_aligned");
        return supports;
    }

    private computeManagementBias(position: Position, signal: ManagedPosition["market_signal"]): ManagedPosition["management_bias"] {
        if (!signal.edge_ok && !signal.entry_ok) return "CLOSE";
        if (!signal.edge_ok || !signal.entry_ok) return "REDUCE";
        if (signal.book_pressure_side_alignment === "opposite" && signal.regime_conflict) return "REDUCE";
        if (position.side === "long" && signal.regime_conflict && (!signal.edge_ok || signal.book_pressure_side_alignment === "opposite")) return "REDUCE";
        return "HOLD";
    }

    private groupPlaybooksBySide(playbooks: Playbook[]): Record<TradeSide, Playbook[]> {
        return playbooks.reduce<Record<TradeSide, Playbook[]>>((acc, playbook) => {
            const side = inferSideFromPlaybook(playbook);
            if (side) acc[side].push(playbook);
            return acc;
        }, { long: [], short: [] });
    }

    private applyRegimePolicy(
        regime: GlobalRegime["current"],
        side: TradeSide,
        playbooks: Playbook[],
        market: MarketEntry,
        config: AgentConfig
    ): { allowed: boolean; multiplier: number; warnings: string[] } {
        const warnings: string[] = [];
        const hasStrongMargin = this.hasStrongTriggerMargin(playbooks, market, config);

        if (regime === "RISK_ON") {
            if (playbooks.some(p => p.startsWith("Mean Reversion"))) {
                warnings.push("RISK_ON mean reversion reduced");
                return { allowed: true, multiplier: 0.5, warnings };
            }
            return { allowed: true, multiplier: 1.0, warnings };
        }

        if (regime === "CHOP") {
            if (playbooks.some(p => p.startsWith("Mean Reversion"))) return { allowed: true, multiplier: 0.5, warnings };
            if (playbooks.some(p => p.startsWith("Breakout")) && hasStrongMargin) {
                warnings.push("CHOP breakout requires strong trigger margin");
                return { allowed: true, multiplier: 0.5, warnings };
            }
            return { allowed: false, multiplier: 0, warnings };
        }

        if (regime === "RISK_OFF") {
            warnings.push("RISK_OFF regime");
            if (side === "short" && playbooks.some(p => p.startsWith("Momentum") || p.startsWith("Breakout"))) {
                return { allowed: true, multiplier: 0.75, warnings };
            }
            if (side === "long" && playbooks.some(p => p.startsWith("Momentum") || p.startsWith("Breakout")) && hasStrongMargin) {
                warnings.push("RISK_OFF hard-trigger long heavily reduced");
                return { allowed: true, multiplier: 0.25, warnings };
            }
            return { allowed: false, multiplier: 0, warnings };
        }

        return { allowed: true, multiplier: 0.5, warnings };
    }

    private hasStrongTriggerMargin(playbooks: Playbook[], market: MarketEntry, config: AgentConfig): boolean {
        const volRatio = market.derived?.normalized.vol_ratio_5m_vs_1h ?? 0;
        const bookPressure = Math.abs(market.orderbook?.book_pressure ?? 0);
        const retSigma = Math.abs(market.derived?.normalized.ret_sigma_5m_vs_1h ?? 0);

        if (playbooks.some(p => p.startsWith("Breakout"))) {
            return volRatio >= config.triggers.breakout.vol_ratio_min + 0.25 &&
                bookPressure >= config.triggers.breakout.book_pressure_min + 0.1;
        }

        if (playbooks.some(p => p.startsWith("Momentum"))) {
            return volRatio >= config.triggers.momentum.vol_ratio_min + 0.25 &&
                bookPressure >= config.triggers.momentum.book_pressure_min + 0.1;
        }

        if (playbooks.some(p => p.startsWith("Mean Reversion"))) {
            return retSigma >= config.triggers.mean_reversion.ret_sigma_threshold + 0.5 &&
                bookPressure >= config.triggers.mean_reversion.book_pressure_min + 0.05;
        }

        return false;
    }

    private buildRiskFields(
        riskPlan: { stop_loss_pct: number; take_profit_pct_primary: number },
        market: MarketEntry
    ): EligibleCandidate["risk"] {
        const stopBps = Math.abs(riskPlan.stop_loss_pct) * 10000;
        const takeProfitBps = Math.abs(riskPlan.take_profit_pct_primary) * 10000;
        const costBps = market.derived?.costs.cost_bps ?? 0;

        return {
            stop_loss_pct: Math.abs(riskPlan.stop_loss_pct),
            take_profit_pct_primary: Math.abs(riskPlan.take_profit_pct_primary),
            stop_bps: parseFloat(stopBps.toFixed(2)),
            take_profit_bps: parseFloat(takeProfitBps.toFixed(2)),
            cost_to_stop_ratio: stopBps > 0 ? parseFloat((costBps / stopBps).toFixed(4)) : 999,
            cost_to_tp_ratio: takeProfitBps > 0 ? parseFloat((costBps / takeProfitBps).toFixed(4)) : 999
        };
    }

    private costSanityOk(_playbook: Playbook, risk: EligibleCandidate["risk"], market: MarketEntry, config: AgentConfig): boolean {
        const costBps = market.derived?.costs.cost_bps ?? Infinity;
        const edgeToCost = market.derived?.entry?.edge_to_cost_mult ?? 0;
        return edgeToCost >= config.cost_sanity.min_edge_to_cost_mult &&
            risk.stop_bps >= costBps * config.cost_sanity.min_stop_to_cost_mult &&
            risk.take_profit_bps >= costBps * config.cost_sanity.min_tp_to_cost_mult;
    }

    private buildSizing(
        snapshot: StateSnapshot,
        config: AgentConfig,
        market: MarketEntry,
        side: TradeSide,
        stopLossPct: number,
        regimeMultiplier: number,
        correlation: EligibleCandidate["correlation"]
    ): EligibleCandidate["sizing"] {
        const equity = snapshot.account.equity_usd;
        const minSizeFraction = equity > 0 ? snapshot.constraints.min_trade_notional_usd / equity : Infinity;
        const riskBasedSize = stopLossPct > 0 ? config.risk.risk_per_trade_pct / stopLossPct : 0;
        const perTradeCap = Math.min(config.risk.max_position_fraction, config.risk.max_position_fraction_per_symbol);
        const remainingCapacity = Math.max(0, snapshot.account.derived_portfolio?.remaining_capacity ?? 0);
        const symbolExposure = snapshot.account.current_positions
            .filter(position => position.symbol === market.symbol)
            .reduce((sum, position) => sum + position.fraction_of_equity, 0);
        const symbolRemaining = Math.max(0, config.risk.max_position_fraction_per_symbol - symbolExposure);
        const groupRemaining = Math.max(0, correlation.max_group_exposure - correlation.same_direction_group_exposure);
        const effectiveLeverageCeiling = Math.max(0, config.risk.max_effective_leverage || config.risk.exchange_max_leverage_allowed || 1);
        const exchangeCeiling = Math.max(0, config.risk.exchange_max_leverage_allowed || effectiveLeverageCeiling);

        const rawCap = Math.min(
            riskBasedSize,
            perTradeCap,
            remainingCapacity,
            symbolRemaining,
            groupRemaining,
            effectiveLeverageCeiling
        );

        const maxAllowed = Math.max(0, rawCap * regimeMultiplier * correlation.correlation_size_multiplier);
        const feasibleMax = maxAllowed >= minSizeFraction ? maxAllowed : 0;
        const triggerQualityMultiplier = this.triggerQualityMultiplier(market);
        const costQualityMultiplier = this.costQualityMultiplier(market);
        const suggestedRaw = feasibleMax * triggerQualityMultiplier * costQualityMultiplier;
        const suggested = suggestedRaw >= minSizeFraction ? Math.min(suggestedRaw, feasibleMax) : 0;

        return {
            risk_based_size_fraction: parseFloat(riskBasedSize.toFixed(6)),
            max_allowed_size_fraction: parseFloat(feasibleMax.toFixed(6)),
            suggested_size_fraction: parseFloat(suggested.toFixed(6)),
            min_size_fraction: Number.isFinite(minSizeFraction) ? parseFloat(minSizeFraction.toFixed(6)) : 0,
            risk_at_suggested_size_pct_equity: parseFloat((suggested * stopLossPct).toFixed(8)),
            effective_leverage_at_suggested_size: parseFloat(suggested.toFixed(6)),
            max_effective_leverage_allowed: effectiveLeverageCeiling,
            exchange_max_leverage_allowed: exchangeCeiling
        };
    }

    private triggerQualityMultiplier(market: MarketEntry): number {
        const margins = market.derived?.risk?.trigger_diagnostics?.trigger_margin ?? {};
        const weakestMargin = Math.min(
            margins.vol_ratio_margin ?? Number.POSITIVE_INFINITY,
            margins.book_pressure_margin ?? Number.POSITIVE_INFINITY,
            margins.ret_sigma_margin ?? Number.POSITIVE_INFINITY
        );

        if (!Number.isFinite(weakestMargin)) return 0.6;
        if (weakestMargin >= 0.5) return 1.0;
        if (weakestMargin >= 0.1) return 0.6;
        return 0.3;
    }

    private costQualityMultiplier(market: MarketEntry): number {
        const edgeToCost = market.derived?.entry?.edge_to_cost_mult ?? 0;
        if (edgeToCost >= 6) return 1.0;
        if (edgeToCost >= 4) return 0.7;
        if (edgeToCost >= 3) return 0.5;
        return 0.3;
    }

    private async buildCorrelation(
        snapshot: StateSnapshot,
        symbol: string,
        side: TradeSide,
        isTestnet: boolean,
        config: AgentConfig
    ): Promise<EligibleCandidate["correlation"]> {
        const sameDirectionPositions = snapshot.account.current_positions.filter(position => position.side === side);
        const sameDirectionGroupExposure = sameDirectionPositions.reduce((sum, position) => sum + position.fraction_of_equity, 0);
        let highest: EligibleCandidate["correlation"]["highest_corr_existing_position"] = null;
        let multiplier = 1.0;

        for (const position of snapshot.account.current_positions) {
            const corr = await this.computeRecentCorrelation(symbol, position.symbol, isTestnet);
            const sameDirection = position.side === side;
            const effectiveCorr = snapshot.global_regime.current === "RISK_OFF"
                ? Math.min(1, corr + config.correlation.risk_off_corr_addon)
                : corr;
            const positionMultiplier = this.correlationMultiplier(effectiveCorr, sameDirection, config);

            if (sameDirection) multiplier = Math.min(multiplier, positionMultiplier);
            if (!highest || corr > highest.correlation) {
                highest = {
                    symbol: position.symbol,
                    correlation: parseFloat(corr.toFixed(4)),
                    same_direction: sameDirection
                };
            }
        }

        if (sameDirectionGroupExposure >= config.risk.max_correlation_group_exposure_fraction) {
            multiplier = 0;
        }

        return {
            group: config.correlation.default_group,
            same_direction_group_exposure: parseFloat(sameDirectionGroupExposure.toFixed(6)),
            max_group_exposure: config.risk.max_correlation_group_exposure_fraction,
            highest_corr_existing_position: highest,
            correlation_size_multiplier: multiplier
        };
    }

    private async computeRecentCorrelation(symbolA: string, symbolB: string, isTestnet: boolean): Promise<number> {
        if (symbolA === symbolB) return 1;
        if (this.correlationProvider) {
            return this.correlationProvider(symbolA, symbolB, isTestnet);
        }

        try {
            const db = isTestnet ? marketDbTest : marketDbMain;
            const [candlesA, candlesB] = await Promise.all([
                db.marketCandle.findMany({
                    where: { symbol: this.baseSymbol(symbolA), timeframe: "1m" },
                    orderBy: { openTime: "desc" },
                    take: 120
                }),
                db.marketCandle.findMany({
                    where: { symbol: this.baseSymbol(symbolB), timeframe: "1m" },
                    orderBy: { openTime: "desc" },
                    take: 120
                })
            ]);

            const returnsA = this.closeReturns(candlesA.reverse());
            const returnsB = this.closeReturns(candlesB.reverse());
            return this.pearson(returnsA, returnsB);
        } catch {
            return 0;
        }
    }

    private closeReturns(candles: Array<{ close: number }>): number[] {
        const returns: number[] = [];
        for (let i = 1; i < candles.length; i++) {
            const prev = candles[i - 1].close;
            const curr = candles[i].close;
            if (prev > 0 && curr > 0) returns.push((curr - prev) / prev);
        }
        return returns;
    }

    private pearson(a: number[], b: number[]): number {
        const n = Math.min(a.length, b.length);
        if (n < 10) return 0;

        const xs = a.slice(a.length - n);
        const ys = b.slice(b.length - n);
        const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
        const meanY = ys.reduce((sum, value) => sum + value, 0) / n;

        let numerator = 0;
        let denomX = 0;
        let denomY = 0;
        for (let i = 0; i < n; i++) {
            const dx = xs[i] - meanX;
            const dy = ys[i] - meanY;
            numerator += dx * dy;
            denomX += dx * dx;
            denomY += dy * dy;
        }

        const denom = Math.sqrt(denomX * denomY);
        if (denom === 0) return 0;
        return Math.max(-1, Math.min(1, numerator / denom));
    }

    private correlationMultiplier(corr: number, sameDirection: boolean, config: AgentConfig): number {
        if (!sameDirection) return 1.0;
        if (corr >= 0.85) return config.correlation.corr_gt_085_multiplier;
        if (corr >= 0.70) return config.correlation.corr_gt_070_multiplier;
        if (corr >= 0.50) return config.correlation.corr_gt_050_multiplier;
        return 1.0;
    }

    private buildCandidateWarnings(
        regime: GlobalRegime["current"],
        side: TradeSide,
        correlation: EligibleCandidate["correlation"],
        regimeWarnings: string[]
    ): string[] {
        const warnings = [...regimeWarnings];
        if (regime === "RISK_OFF" && side === "long") warnings.push("new long in RISK_OFF requires reduced size");
        if (correlation.same_direction_group_exposure > 0) warnings.push("existing same-direction CRYPTO_BETA exposure");
        if (correlation.correlation_size_multiplier < 1) warnings.push("same-direction correlation reduced size");
        return Array.from(new Set(warnings));
    }

    private bookPressureAlignment(side: TradeSide, bookPressure: number | null | undefined): ManagedPosition["market_signal"]["book_pressure_side_alignment"] {
        if (bookPressure === null || bookPressure === undefined) return "unknown";
        if (Math.abs(bookPressure) < 0.05) return "neutral";
        if (side === "long") return bookPressure > 0 ? "supportive" : "opposite";
        return bookPressure < 0 ? "supportive" : "opposite";
    }

    private buildCandidateId(symbol: string, side: TradeSide, playbook: Playbook): string {
        return `${symbol}:${side}:${playbook.split(":")[0].replace(/\s+/g, "_")}`;
    }

    private baseSymbol(symbol: string): string {
        return symbol.replace(/-PERP$/, "");
    }
}
