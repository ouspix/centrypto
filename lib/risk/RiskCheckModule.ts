import { StateSnapshot } from "@/services/SnapshotBuilder";
import { AgentConfig } from "@/lib/agent-config";
import { TradeDecision, RiskAssessment, RiskContext, ApprovedOrder } from "@/types/trading";
import {
    computeSizeFraction as sharedComputeSizeFraction,
    clampRiskPlan as sharedClampRiskPlan,
    resolveAnchor as sharedResolveAnchor,
    getValueByPath as sharedGetValueByPath,
    computeRiskPlan as sharedComputeRiskPlan
} from "@/lib/risk/shared";

// Re-export types for backward compatibility
export type { TradeDecision, RiskAssessment, RiskContext } from "@/types/trading";

export class RiskCheckModule {

    public assess(decision: TradeDecision, snapshot: StateSnapshot, context: RiskContext = { newPositionsCount: 0 }): RiskAssessment {
        // --- A) Output/Accounting Invariants ---

        // 1. Check Kill Switch (Manual or Daily Loss)
        if (snapshot.constraints.kill_switch) {
            return { approved: false, reason: "Kill Switch Active (Manual)" };
        }

        // Check Daily Loss Kill Switch
        // daily_loss_kill_switch_fraction is a positive number (e.g. 0.03 for 3%)
        // daily_realized_pnl is negative when losing
        // If daily_realized_pnl < -(equity * fraction), kill it.
        const maxDailyLossAmount = snapshot.account.equity_usd * snapshot.constraints.daily_loss_kill_switch_fraction;
        const dailyTotal = snapshot.account.daily_total_pnl_usd ?? snapshot.account.daily_realized_pnl ?? 0;
        if (dailyTotal <= -maxDailyLossAmount) {
            return { approved: false, reason: `Kill Switch Active: Max Daily Loss Exceeded (${dailyTotal.toFixed(2)} < -${maxDailyLossAmount.toFixed(2)})` };
        }

        // 2. Validate Action Enum
        const allowedActions = snapshot.allowed_actions;
        if (!allowedActions.includes(decision.action) && decision.action !== "DO_NOTHING") {
            if ((decision.action === "HOLD" || decision.action === "HOLD_POSITION") && allowedActions.includes("HOLD_POSITION")) {
                // Strict check: User said "Reject anything else"
                return { approved: false, reason: `Invalid action: ${decision.action}. Must be one of ${allowedActions.join(", ")}` };
            }
            if (decision.action !== "HOLD") {
                return { approved: false, reason: `Invalid action: ${decision.action}` };
            }
        }

        if (decision.action === "DO_NOTHING" || decision.action === "HOLD" || decision.action === "HOLD_POSITION" || decision.action === "SKIP") {
            return { approved: true, reason: "No Trade Proposed" };
        }

        if (!decision.symbol) {
            return { approved: false, reason: "No symbol provided" };
        }

        // 3. Post-LLM Validator: Drop if symbol not in current_positions for CLOSE/REDUCE
        const currentPosition = snapshot.account.current_positions.find(p => p.symbol === decision.symbol);
        if ((decision.action === "CLOSE_POSITION" || decision.action === "REDUCE_POSITION") && !currentPosition) {
            return { approved: false, reason: `Cannot ${decision.action} for ${decision.symbol}: No open position found.` };
        }

        // 4. No Same-Tick Flip
        if (snapshot.constraints.no_flip_same_tick && currentPosition) {
            const isFlip = (decision.target_side === "long" && currentPosition.side === "short") ||
                (decision.target_side === "short" && currentPosition.side === "long");

            if (isFlip && decision.action !== "CLOSE_POSITION") {
                return { approved: false, reason: "Cannot flip position in same tick. Must CLOSE_POSITION first." };
            }
        }

        // Dispatch based on action
        if (decision.action === "INCREASE_POSITION") {
            return { approved: false, reason: "INCREASE_POSITION disabled in trader-only v1" };
        }

        if (decision.action === "OPEN_POSITION") {
            return this.assessOpenPosition(decision, snapshot, context);
        }

        if (decision.action === "CLOSE_POSITION" || decision.action === "REDUCE_POSITION") {
            return this.assessClosePosition(decision, snapshot);
        }

        return { approved: false, reason: `Action ${decision.action} logic not implemented` };
    }

    private assessOpenPosition(decision: TradeDecision, snapshot: StateSnapshot, context: RiskContext): RiskAssessment {
        const market = snapshot.markets[decision.symbol!];
        if (!market) {
            return { approved: false, reason: `Market data not found for ${decision.symbol}` };
        }

        const riskMeta = market.derived?.risk;
        if (riskMeta) {
            if (!riskMeta.eligible) {
                return { approved: false, reason: "Market not eligible per backend gates" };
            }

            if (riskMeta.eligible_playbooks?.length) {
                const normalizedPlaybook = (decision.playbook || "").toLowerCase().trim();
                const allowed = riskMeta.eligible_playbooks.some(p => p.toLowerCase().trim() === normalizedPlaybook);
                if (!allowed) {
                    return { approved: false, reason: `Playbook ${decision.playbook} not allowed for ${decision.symbol}` };
                }
            }
        }

        // --- B) Trade Permission Gates ---

        // 5. Tradeable Gate
        if (market.derived && !market.derived.liquidity.tradeable) {
            return { approved: false, reason: "Market not tradeable (Liquidity or Cost gate failed)" };
        }

        // 6. Edge Check
        if (market.derived) {
            const edgeBps = market.derived.edge.edge_bps;
            const costBps = market.derived.costs.cost_bps;
            if (edgeBps <= 0 || edgeBps < 0.5 * costBps) {
                return { approved: false, reason: `Insufficient edge (Edge: ${edgeBps} bps vs Cost: ${costBps} bps)` };
            }
        }

        // 7. Max New Positions Per Cycle
        // If this is a NEW position (not increasing existing), check limit
        const isNewPosition = !snapshot.account.current_positions.find(p => p.symbol === decision.symbol);
        const maxNewTrades = snapshot.constraints.max_new_trades_allowed ?? snapshot.constraints.max_new_positions_per_cycle;
        if (isNewPosition) {
            if (context.newPositionsCount >= maxNewTrades) {
                return { approved: false, reason: `Max new positions per cycle reached (${maxNewTrades})` };
            }
        }

        // 8. Max Positions (Total Slots)
        // Check slots using derived portfolio if available
        const slotsRemaining = snapshot.account.derived_portfolio?.slots_remaining;
        if (isNewPosition && slotsRemaining !== undefined && slotsRemaining <= 0) {
            return { approved: false, reason: "Max position slots reached" };
        }

        // --- C) Risk Plan Enforcement ---

        if (!decision.risk_plan && snapshot.presets?.agent) {
            decision.risk_plan = this.buildRiskPlanFromSnapshot(decision, market, snapshot);
        }

        // 9. Risk Plan Required
        if (!decision.risk_plan) {
            return { approved: false, reason: "Missing Risk Plan (SL/TP required)" };
        }

        // Apply bounds to risk plan (min SL/TP + RR floor)
        this.clampRiskPlan(decision);

        // 10. Bounds
        const slPct = Math.abs(decision.risk_plan.stop_loss_pct);
        const tpPct = Math.abs(decision.risk_plan.take_profit_pct_primary);

        if (slPct < 0.001 || slPct > 0.05) {
            return { approved: false, reason: `Stop Loss ${slPct} out of bounds (0.1% - 5%)` };
        }

        if (tpPct < 1.5 * slPct) {
            return { approved: false, reason: `Risk/Reward too low (TP must be >= 1.5x SL)` };
        }

        // --- Accounting Checks & Clamping ---

        let sizeFraction = decision.target_size_fraction_of_equity ?? (decision as any).target_size_fraction_of_1h ?? decision.size_fraction_of_equity;
        if ((sizeFraction === null || sizeFraction === undefined) && snapshot.presets?.agent) {
            sizeFraction = this.computeSizeFraction(decision.confidence, snapshot.presets.agent, snapshot.account.equity_usd);
            if (sizeFraction !== null) {
                decision.target_size_fraction_of_equity = sizeFraction;
                decision.size_fraction_of_equity = sizeFraction;
            }
        }
        if (sizeFraction === null || sizeFraction === undefined) {
            return { approved: false, reason: "Missing target size" };
        }

        const equity = snapshot.account.equity_usd;

        const perTradeCap = snapshot.constraints.max_position_pct_equity ?? snapshot.constraints.max_position_pct_equity_per_symbol;
        const perSymbolCap = snapshot.constraints.max_position_pct_equity_per_symbol;

        const maxPerSymbolUsd = equity * perSymbolCap;
        const maxPerTradeUsd = equity * (perTradeCap ?? perSymbolCap);

        // If venue/UI minimum notional cannot fit within caps, fail early with a clear message
        const minTradeUsd = snapshot.constraints.min_trade_notional_usd;
        if (minTradeUsd > maxPerSymbolUsd || minTradeUsd > maxPerTradeUsd) {
            return {
                approved: false,
                reason: `Min trade $${minTradeUsd} exceeds cap (${(perSymbolCap * 100).toFixed(2)}% of equity = $${maxPerSymbolUsd.toFixed(2)})`
            };
        }

        if (perTradeCap !== undefined && sizeFraction > perTradeCap) {
            return { approved: false, reason: `Size exceeds per-trade cap (${sizeFraction} > ${perTradeCap})` };
        }
        if (sizeFraction > perSymbolCap) {
            return { approved: false, reason: `Size exceeds per-symbol cap (${sizeFraction} > ${perSymbolCap})` };
        }

        let proposedSizeUsd = equity * sizeFraction;

        const currentPositions = snapshot.account.current_positions;
        const currentExposure = currentPositions.reduce((sum, p) => sum + p.size_usd, 0);
        const maxTotal = equity * snapshot.constraints.max_total_exposure_pct_equity;

        // 11. If below min notional, attempt to bump up within caps and exposure (with small buffer for rounding)
        const bufferedMinTradeUsd = minTradeUsd * 1.02;
        if (proposedSizeUsd < bufferedMinTradeUsd) {
            const bumpFraction = bufferedMinTradeUsd / equity;
            const allowedFraction = Math.min(perSymbolCap, perTradeCap);
            let candidateFraction = Math.max(sizeFraction, bumpFraction);

            if (candidateFraction > allowedFraction) {
                return { approved: false, reason: "Trade size too small after caps" };
            }

            let candidateUsd = equity * candidateFraction;
            const remainingExposure = maxTotal - currentExposure;
            if (candidateUsd > remainingExposure) {
                if (remainingExposure >= bufferedMinTradeUsd) {
                    candidateFraction = remainingExposure / equity;
                    candidateUsd = remainingExposure;
                } else {
                    return { approved: false, reason: "Trade size too small (exposure limit)" };
                }
            }

            sizeFraction = candidateFraction;
            proposedSizeUsd = candidateUsd;
            decision.target_size_fraction_of_equity = candidateFraction;
            decision.size_fraction_of_equity = candidateFraction;
        }

        // 12. Max Total Exposure (after potential bump)
        if (currentExposure + proposedSizeUsd > maxTotal) {
            const remainingExposure = maxTotal - currentExposure;
            if (remainingExposure < minTradeUsd) {
                return { approved: false, reason: `Total exposure limit reached (${snapshot.constraints.max_total_exposure_pct_equity * 100}%)` };
            }
            return { approved: false, reason: `Size exceeds remaining total exposure (${proposedSizeUsd.toFixed(2)} > ${remainingExposure.toFixed(2)})` };
        }

        // 13. Final min trade guard
        if (proposedSizeUsd < minTradeUsd) {
            return { approved: false, reason: "Trade size too small" };
        }

        // Construct ApprovedOrder
        const isLong = decision.target_side === "long";
        const orderSide = isLong ? "buy" : "sell";
        const entryPx = market.price;

        let sizeToExecute = proposedSizeUsd;
        let clientTag = "AI_TRADER";

        if (decision.action === "INCREASE_POSITION") {
            const currentPosition = snapshot.account.current_positions.find(p => p.symbol === decision.symbol);
            if (currentPosition) {
                const increaseAmount = proposedSizeUsd - currentPosition.size_usd;

                if (increaseAmount <= 0) {
                    return { approved: false, reason: `Position already at or above target size (Current: ${currentPosition.size_usd.toFixed(2)}, Target: ${proposedSizeUsd.toFixed(2)})` };
                }
                sizeToExecute = increaseAmount;
                clientTag = "AI_TRADER_INCREASE";
            } else {
                clientTag = "AI_TRADER_INCREASE_NEW";
            }
        }

        const approvedOrder: ApprovedOrder = {
            symbol: decision.symbol!,
            side: orderSide,
            sizeUsd: sizeToExecute,
            clientTag: clientTag
        };

        return { approved: true, reason: "Risk Checks Passed", modifiedOrder: approvedOrder };
    }

    private assessClosePosition(decision: TradeDecision, snapshot: StateSnapshot): RiskAssessment {
        const position = snapshot.account.current_positions.find(p => p.symbol === decision.symbol);
        if (!position) {
            return { approved: false, reason: "No open position to close" };
        }

        const market = snapshot.markets[decision.symbol!];
        const markPrice = market?.price && market.price > 0 ? market.price : position.entry_price;
        const positionSizeCoin = position.size_coin ?? (markPrice > 0 ? position.size_usd / markPrice : 0);
        const currentPositionUsd = markPrice > 0 ? positionSizeCoin * markPrice : position.size_usd;
        const minTradeUsd = snapshot.constraints.min_trade_notional_usd;
        let sizeUsdToExecute = currentPositionUsd;
        let sizeCoinToExecute = positionSizeCoin;
        let clientTag = "AI_TRADER_CLOSE";
        let reason = "Close Approved";

        if (decision.action === "REDUCE_POSITION") {
            const targetFraction = decision.target_size_fraction_of_equity ?? 0;
            const targetSizeUsd = snapshot.account.equity_usd * targetFraction;
            const reduceAmount = currentPositionUsd - targetSizeUsd;

            if (reduceAmount <= 0) {
                return { approved: false, reason: `Position already below target size (Current: ${currentPositionUsd.toFixed(2)}, Target: ${targetSizeUsd.toFixed(2)})` };
            }

            const remainingAfterReduce = currentPositionUsd - reduceAmount;
            sizeUsdToExecute = Math.min(reduceAmount, currentPositionUsd);
            sizeCoinToExecute = markPrice > 0 ? Math.min(sizeUsdToExecute / markPrice, positionSizeCoin) : positionSizeCoin;
            clientTag = "AI_TRADER_REDUCE";
            reason = "Reduce Approved";

            if (remainingAfterReduce > 0 && remainingAfterReduce < minTradeUsd) {
                sizeUsdToExecute = currentPositionUsd;
                sizeCoinToExecute = positionSizeCoin;
                clientTag = "AI_TRADER_CLOSE_DUST_REMAINDER";
                reason = `Reduce converted to close: remainder $${remainingAfterReduce.toFixed(2)} is below minimum notional $${minTradeUsd}`;
            } else if (sizeUsdToExecute < minTradeUsd && currentPositionUsd > minTradeUsd) {
                const remainderAfterMinReduce = currentPositionUsd - minTradeUsd;
                if (remainderAfterMinReduce > 0 && remainderAfterMinReduce < minTradeUsd) {
                    sizeUsdToExecute = currentPositionUsd;
                    sizeCoinToExecute = positionSizeCoin;
                    clientTag = "AI_TRADER_CLOSE_DUST_REMAINDER";
                    reason = `Reduce converted to close: minimum reduce would leave $${remainderAfterMinReduce.toFixed(2)} below minimum notional $${minTradeUsd}`;
                } else {
                    sizeUsdToExecute = minTradeUsd;
                    sizeCoinToExecute = markPrice > 0 ? Math.min(minTradeUsd / markPrice, positionSizeCoin) : positionSizeCoin;
                    clientTag = "AI_TRADER_REDUCE_MIN_NOTIONAL";
                    reason = `Reduce size increased to $${minTradeUsd} minimum notional`;
                }
            }
        }

        if (decision.action === "CLOSE_POSITION" && currentPositionUsd < minTradeUsd) {
            clientTag = "AI_TRADER_CLOSE_DUST";
            reason = `${reason}; exact reduce-only dust close below $${minTradeUsd} minimum notional`;
        }

        const approvedOrder: ApprovedOrder = {
            symbol: decision.symbol!,
            side: position.side === "long" ? "sell" : "buy",
            sizeUsd: sizeUsdToExecute,
            sizeCoin: sizeCoinToExecute,
            clientTag: clientTag
        };

        return { approved: true, reason, modifiedOrder: approvedOrder };
    }

    private clampRiskPlan(decision: TradeDecision) {
        sharedClampRiskPlan(decision);
    }

    private computeSizeFraction(confidence: number, config: AgentConfig, equity: number): number | null {
        return sharedComputeSizeFraction(confidence, config, equity);
    }

    private buildRiskPlanFromSnapshot(decision: TradeDecision, market: any, snapshot: StateSnapshot) {
        const config = snapshot.presets?.agent;
        if (!config) return null;

        const currentPosition = snapshot.account.current_positions.find(p => p.symbol === decision.symbol);
        const effectiveLeverage = currentPosition?.leverage && currentPosition.leverage > 0
            ? currentPosition.leverage
            : (config.risk.default_leverage ?? 1);

        return sharedComputeRiskPlan(decision.playbook, market, config, snapshot.global_regime.current, effectiveLeverage);
    }
}
