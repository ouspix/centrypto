import { AgentConfig } from "@/lib/agent-config";
import { computeExecutionCostBps } from "@/lib/trading/execution-cost";
import { GlobalRegime, MarketEntry } from "@/types/snapshot";
import { MarketStructureService } from "./MarketStructureService";

export class MarketDerivedMetricsService {
    private readonly marketStructureService = new MarketStructureService();

    public applyDerivedMetrics(
        markets: Record<string, MarketEntry>,
        config: AgentConfig,
        regime: GlobalRegime["current"],
        isTestnet: boolean
    ): void {
        const costBpsMax = config.gates.cost_bps_max_by_regime[regime];
        const networkProfile = isTestnet ? config.network_profiles.testnet : config.network_profiles.mainnet;
        const feesBps = networkProfile.fees_bps;
        const slippageModel = networkProfile.slippage_model;

        for (const key of Object.keys(markets)) {
            const m = markets[key];

            const spreadBps = m.spread_bps || 0;
            const cost = computeExecutionCostBps({
                spreadBps,
                feesBps,
                slippageModel
            });
            const slippageEst = cost.slippageBps;
            const costBps = cost.totalCostBps;

            const symbolBase = key.replace("-PERP", "");
            const overrideMax = config.gates.per_symbol_cost_override?.[symbolBase];
            const effectiveCostMax = overrideMax !== undefined ? overrideMax : costBpsMax;
            const costOk = costBps <= effectiveCostMax;

            const expectedMoveBps = 10000 * Math.max(Math.abs(m.returns?.m15 ?? 0), Math.abs(m.returns?.h1 ?? 0));
            const edgeBps = expectedMoveBps - costBps;
            const edgeMult = config.gates.edge_to_cost_mult_by_regime[regime];
            const edgeOk = edgeBps >= (edgeMult * costBps) && edgeBps > 10;

            const edgeToCostMult = costBps > 0 ? edgeBps / costBps : 0;
            const entryReasonsFailed: string[] = [];

            const dirM15 = Math.sign(m.returns?.m15 ?? 0);
            const dirH1 = Math.sign(m.returns?.h1 ?? 0);

            const strictTrend = (dirM15 === dirH1) && (dirM15 !== 0);
            const trendAligned = strictTrend || (isTestnet && dirM15 !== 0);

            const retSigma = m.vol_zscores?.ret_5m_vs_1h ?? 0;
            const volRatio = m.vol_zscores?.vol_5m_vs_1h ?? 0;

            const bp = m.orderbook?.book_pressure ?? 0;
            const trendOkForMomentum = config.triggers.momentum.trend_aligned_required === false || trendAligned;
            const momOkLong = trendOkForMomentum &&
                retSigma > 0 &&
                bp >= config.triggers.momentum.book_pressure_min &&
                volRatio >= config.triggers.momentum.vol_ratio_min;
            const momOkShort = trendOkForMomentum &&
                retSigma < 0 &&
                bp <= -config.triggers.momentum.book_pressure_min &&
                volRatio >= config.triggers.momentum.vol_ratio_min;

            const meanReversionRegimeOk = this.meanReversionRegimeOk(
                regime,
                Math.abs(retSigma),
                config.triggers.mean_reversion.ret_sigma_threshold,
                config.triggers.mean_reversion.chop_regime
            );
            const mrOkLong = meanReversionRegimeOk &&
                retSigma <= -config.triggers.mean_reversion.ret_sigma_threshold &&
                bp >= config.triggers.mean_reversion.book_pressure_min;
            const mrOkShort = meanReversionRegimeOk &&
                retSigma >= config.triggers.mean_reversion.ret_sigma_threshold &&
                bp <= -config.triggers.mean_reversion.book_pressure_min;

            const volSpike = volRatio >= config.triggers.breakout.vol_ratio_min;
            const breakoutOkLong = volSpike &&
                retSigma > 0 &&
                bp >= config.triggers.breakout.book_pressure_min;
            const breakoutOkShort = volSpike &&
                retSigma < 0 &&
                bp <= -config.triggers.breakout.book_pressure_min;
            const breakoutOk = breakoutOkLong || breakoutOkShort;

            const minDepth = Math.min(m.orderbook?.bid_liquidity_usd ?? 0, m.orderbook?.ask_liquidity_usd ?? 0);
            const depthOk = minDepth >= config.gates.depth_usd_min;
            const tradeable = depthOk && costOk;
            const structure = this.marketStructureService.compute(m);

            const entryOk = edgeOk && tradeable && costOk && edgeToCostMult >= edgeMult;
            if (!edgeOk) entryReasonsFailed.push("EDGE_GATE");
            if (!costOk) entryReasonsFailed.push("COST_GATE");
            if (!depthOk) entryReasonsFailed.push("DEPTH_GATE");
            if (edgeToCostMult < edgeMult) entryReasonsFailed.push("EDGE_TO_COST_BELOW_MULT");

            const { bestAnchorKey, bestAnchorValue } = this.findBestAnchor(m, config, {
                "edge.expected_move_bps": expectedMoveBps,
                "edge.edge_bps": edgeBps
            });
            const eligiblePlaybooks = this.buildEligiblePlaybooks({
                breakoutOkLong,
                breakoutOkShort,
                momOkLong,
                momOkShort,
                mrOkLong,
                mrOkShort
            });
            const eligible = entryOk && eligiblePlaybooks.length > 0;
            const triggerMargins = this.buildTriggerMargins({
                volRatio,
                bookPressure: bp,
                retSigma,
                config,
                playbooks: eligiblePlaybooks
            });

            m.derived = {
                costs: {
                    fees_bps: feesBps,
                    slippage_bps_est: parseFloat(slippageEst.toFixed(1)),
                    cost_bps: parseFloat(costBps.toFixed(1)),
                    cost_ok: costOk
                },
                edge: {
                    expected_move_bps: parseFloat(expectedMoveBps.toFixed(1)),
                    edge_bps: parseFloat(edgeBps.toFixed(1)),
                    edge_ok: edgeOk
                },
                technicals: {
                    high_low: m.high_low || { is_new_high_1h: false, is_new_low_1h: false },
                    bb_width_m5: m.bbands?.m5?.width || 0
                },
                triggers: {
                    direction_m15: dirM15,
                    direction_h1: dirH1,
                    trend_aligned: trendAligned,
                    momentum_ok_long: momOkLong,
                    momentum_ok_short: momOkShort,
                    mr_ok_long: mrOkLong,
                    mr_ok_short: mrOkShort,
                    breakout_ok: breakoutOk,
                    breakout_ok_long: breakoutOkLong,
                    breakout_ok_short: breakoutOkShort
                },
                liquidity: {
                    min_depth_usd: minDepth,
                    depth_ok: depthOk,
                    tradeable
                },
                normalized: {
                    ret_sigma_5m_vs_1h: retSigma,
                    vol_ratio_5m_vs_1h: volRatio
                },
                entry: {
                    entry_ok: entryOk,
                    edge_to_cost_mult: parseFloat(edgeToCostMult.toFixed(3)),
                    reasons_failed: entryReasonsFailed
                },
                risk: {
                    eligible,
                    eligible_playbooks: eligiblePlaybooks,
                    best_anchor_key: bestAnchorKey,
                    best_anchor_value: bestAnchorValue,
                    trigger_diagnostics: {
                        has_hard_trigger: eligiblePlaybooks.length > 0,
                        triggered_playbooks: eligiblePlaybooks,
                        trigger_profile: config.preset_name ?? "active",
                        trigger_margin: triggerMargins
                    }
                },
                structure
            };
        }

        // --- Deterministic ranking: edge desc → vol_ratio → depth → assetIndex ---
        const rankedSymbols = Object.entries(markets)
            .sort(([, a], [, b]) => {
                const edgeDiff = (b.derived?.edge?.edge_bps ?? -Infinity) - (a.derived?.edge?.edge_bps ?? -Infinity);
                if (edgeDiff !== 0) return edgeDiff;

                const volDiff = (b.derived?.normalized?.vol_ratio_5m_vs_1h ?? -Infinity) - (a.derived?.normalized?.vol_ratio_5m_vs_1h ?? -Infinity);
                if (volDiff !== 0) return volDiff;

                const depthDiff = (b.derived?.liquidity?.min_depth_usd ?? -Infinity) - (a.derived?.liquidity?.min_depth_usd ?? -Infinity);
                if (depthDiff !== 0) return depthDiff;

                return (a.assetIndex ?? Number.POSITIVE_INFINITY) - (b.assetIndex ?? Number.POSITIVE_INFINITY);
            });

        rankedSymbols.forEach(([symbol], idx) => {
            const market = markets[symbol];
            if (!market.derived) return;
            market.derived.rank = idx + 1;
        });
    }

    private getValueByPath(obj: any, path: string): number | null {
        const parts = path.split(".");
        let current: any = obj;

        for (const part of parts) {
            if (current && Object.prototype.hasOwnProperty.call(current, part)) {
                current = current[part];
            } else {
                return null;
            }
        }

        if (typeof current !== "number" || Number.isNaN(current)) return null;
        return current;
    }

    private findBestAnchor(
        market: MarketEntry,
        config: AgentConfig,
        computed: Record<string, number> = {}
    ): { bestAnchorKey: string | null, bestAnchorValue: number | null } {
        const priorities = config.risk_plan_model.vol_anchor_priority || [];

        for (const key of priorities) {
            const rawValue = computed[key] ?? this.getValueByPath(market, key) ?? this.getValueByPath(market.derived, key);
            if (rawValue === null) continue;

            // Convert bps anchors to decimal fraction of price move
            const value = key.includes("bps") ? rawValue / 10000 : rawValue;
            return { bestAnchorKey: key, bestAnchorValue: value };
        }

        return { bestAnchorKey: null, bestAnchorValue: null };
    }

    private buildEligiblePlaybooks(
        triggers: {
            breakoutOkLong: boolean;
            breakoutOkShort: boolean;
            momOkLong: boolean;
            momOkShort: boolean;
            mrOkLong: boolean;
            mrOkShort: boolean;
        }
    ): string[] {
        const playbooks = new Set<string>();

        if (triggers.momOkLong) playbooks.add("Momentum:long");
        if (triggers.momOkShort) playbooks.add("Momentum:short");
        if (triggers.mrOkLong) playbooks.add("Mean Reversion:long");
        if (triggers.mrOkShort) playbooks.add("Mean Reversion:short");
        if (triggers.breakoutOkLong) playbooks.add("Breakout:long");
        if (triggers.breakoutOkShort) playbooks.add("Breakout:short");

        return Array.from(playbooks);
    }

    private meanReversionRegimeOk(
        regime: GlobalRegime["current"],
        absRetSigma: number,
        threshold: number,
        chopRegime: "required" | "preferred" | "none" = "required"
    ): boolean {
        if (chopRegime === "none") return true;
        if (regime === "CHOP") return true;
        if (chopRegime === "preferred") return absRetSigma >= threshold + 0.75;
        return false;
    }

    private buildTriggerMargins(input: {
        volRatio: number;
        bookPressure: number;
        retSigma: number;
        config: AgentConfig;
        playbooks: string[];
    }): Record<string, number> {
        const margins: Record<string, number> = {};
        const { volRatio, bookPressure, retSigma, config, playbooks } = input;

        if (playbooks.some(p => p.startsWith("Momentum"))) {
            margins.vol_ratio_margin = parseFloat((volRatio - config.triggers.momentum.vol_ratio_min).toFixed(4));
            margins.book_pressure_margin = parseFloat((Math.abs(bookPressure) - config.triggers.momentum.book_pressure_min).toFixed(4));
        }

        if (playbooks.some(p => p.startsWith("Breakout"))) {
            margins.vol_ratio_margin = parseFloat((volRatio - config.triggers.breakout.vol_ratio_min).toFixed(4));
            margins.book_pressure_margin = parseFloat((Math.abs(bookPressure) - config.triggers.breakout.book_pressure_min).toFixed(4));
        }

        if (playbooks.some(p => p.startsWith("Mean Reversion"))) {
            margins.ret_sigma_margin = parseFloat((Math.abs(retSigma) - config.triggers.mean_reversion.ret_sigma_threshold).toFixed(4));
            margins.book_pressure_margin = parseFloat((Math.abs(bookPressure) - config.triggers.mean_reversion.book_pressure_min).toFixed(4));
        }

        return margins;
    }
}
