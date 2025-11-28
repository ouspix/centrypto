import { AgentConfig } from "@/lib/agent-config";
import { GlobalRegime, MarketEntry } from "@/types/snapshot";

export class MarketDerivedMetricsService {
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
            const slippageEst = Math.max(slippageModel.min_bps, spreadBps * slippageModel.spread_mult);
            const costBps = spreadBps + feesBps + slippageEst;

            const symbolBase = key.replace("-PERP", "");
            const overrideMax = config.gates.per_symbol_cost_override?.[symbolBase];
            const effectiveCostMax = overrideMax !== undefined ? overrideMax : costBpsMax;
            const costOk = costBps <= effectiveCostMax;

            const expectedMoveBps = 10000 * Math.max(Math.abs(m.returns?.m15 ?? 0), Math.abs(m.returns?.h1 ?? 0));
            const edgeBps = expectedMoveBps - costBps;
            const edgeMult = config.gates.edge_to_cost_mult_by_regime[regime];
            const edgeOk = edgeBps >= (edgeMult * costBps) && edgeBps > 10;

            const dirM15 = Math.sign(m.returns?.m15 ?? 0);
            const dirH1 = Math.sign(m.returns?.h1 ?? 0);

            const strictTrend = (dirM15 === dirH1) && (dirM15 !== 0);
            const trendAligned = strictTrend || (isTestnet && dirM15 !== 0);

            const retSigma = m.vol_zscores?.ret_5m_vs_1h ?? 0;
            const volRatio = m.vol_zscores?.vol_5m_vs_1h ?? 0;

            const bp = m.orderbook?.book_pressure ?? 0;
            const momOkLong = trendAligned && (dirH1 === 1 || (isTestnet && dirM15 === 1)) &&
                bp >= config.triggers.momentum.book_pressure_min &&
                volRatio >= config.triggers.momentum.vol_ratio_min;
            const momOkShort = trendAligned && (dirH1 === -1 || (isTestnet && dirM15 === -1)) &&
                bp <= -config.triggers.momentum.book_pressure_min &&
                volRatio >= config.triggers.momentum.vol_ratio_min;

            const mrOkLong = retSigma <= -config.triggers.mean_reversion.ret_sigma_threshold &&
                bp >= config.triggers.mean_reversion.book_pressure_min;
            const mrOkShort = retSigma >= config.triggers.mean_reversion.ret_sigma_threshold &&
                bp <= -config.triggers.mean_reversion.book_pressure_min;

            const volSpike = volRatio >= config.triggers.breakout.vol_ratio_min;
            const breakoutOk = volSpike && Math.abs(bp) >= config.triggers.breakout.book_pressure_min;

            const minDepth = Math.min(m.orderbook?.bid_liquidity_usd ?? 0, m.orderbook?.ask_liquidity_usd ?? 0);
            const depthOk = minDepth >= config.gates.depth_usd_min;
            const tradeable = depthOk && costOk;

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
                    breakout_ok: breakoutOk
                },
                liquidity: {
                    min_depth_usd: minDepth,
                    depth_ok: depthOk,
                    tradeable
                },
                normalized: {
                    ret_sigma_5m_vs_1h: retSigma,
                    vol_ratio_5m_vs_1h: volRatio
                }
            };
        }
    }
}
