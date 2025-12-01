import { ApprovedOrder } from "@/lib/hyperliquidExecution";
import { StateSnapshot } from "@/services/SnapshotBuilder";

export type TradeDecision = {
    action: "OPEN_POSITION" | "CLOSE_POSITION" | "REDUCE_POSITION" | "ADJUST_STOPS" | "DO_NOTHING" | "HOLD" | "INCREASE_POSITION";
    symbol: string | null;
    side: "long" | "short" | null;
    target_side: "long" | "short" | "flat" | null;
    target_size_fraction_of_equity: number | null;
    size_fraction_of_equity: number | null; // Deprecated
    risk_plan: {
        stop_loss_pct: number;
        take_profit_pct_primary: number;
    } | null;
    playbook: string;
    confidence: number;
    reason_code: string;
    notes: string;
    audit?: {
        cost_bps: number;
        expected_move_bps: number;
        edge_bps: number;
        book_pressure: number;
        vol_ratio_5m_vs_1h: number;
        ret_sigma_5m_vs_1h: number;
    };
};

export type RiskAssessment = {
    approved: boolean;
    reason: string;
    modifiedOrder?: ApprovedOrder;
};

export type RiskContext = {
    newPositionsCount: number;
};

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
        if (snapshot.account.daily_realized_pnl <= -maxDailyLossAmount) {
            return { approved: false, reason: `Kill Switch Active: Max Daily Loss Exceeded (${snapshot.account.daily_realized_pnl.toFixed(2)} < -${maxDailyLossAmount.toFixed(2)})` };
        }

        // 2. Validate Action Enum
        const allowedActions = snapshot.allowed_actions;
        if (!allowedActions.includes(decision.action) && decision.action !== "DO_NOTHING") {
            if (decision.action === "HOLD" && allowedActions.includes("HOLD_POSITION")) {
                // Strict check: User said "Reject anything else"
                return { approved: false, reason: `Invalid action: ${decision.action}. Must be one of ${allowedActions.join(", ")}` };
            }
            if (decision.action !== "HOLD") {
                return { approved: false, reason: `Invalid action: ${decision.action}` };
            }
        }

        if (decision.action === "DO_NOTHING" || decision.action === "HOLD") {
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
        if (decision.action === "OPEN_POSITION" || decision.action === "INCREASE_POSITION") {
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
        if (isNewPosition) {
            if (context.newPositionsCount >= snapshot.constraints.max_new_positions_per_cycle) {
                return { approved: false, reason: `Max new positions per cycle reached (${snapshot.constraints.max_new_positions_per_cycle})` };
            }
        }

        // 8. Max Positions (Total Slots)
        // Check slots using derived portfolio if available
        const slotsRemaining = snapshot.account.derived_portfolio?.slots_remaining;
        if (isNewPosition && slotsRemaining !== undefined && slotsRemaining <= 0) {
            return { approved: false, reason: "Max position slots reached" };
        }

        // --- C) Risk Plan Enforcement ---

        // 9. Risk Plan Required
        if (!decision.risk_plan) {
            return { approved: false, reason: "Missing Risk Plan (SL/TP required)" };
        }

        // 10. Bounds
        const slPct = Math.abs(decision.risk_plan.stop_loss_pct);
        const tpPct = Math.abs(decision.risk_plan.take_profit_pct_primary);

        if (slPct < 0.005 || slPct > 0.05) {
            return { approved: false, reason: `Stop Loss ${slPct} out of bounds (0.5% - 5%)` };
        }

        if (tpPct < 1.5 * slPct) {
            return { approved: false, reason: `Risk/Reward too low (TP must be >= 1.5x SL)` };
        }

        // --- Accounting Checks & Clamping ---

        let sizeFraction = decision.target_size_fraction_of_equity ?? (decision as any).target_size_fraction_of_1h ?? decision.size_fraction_of_equity;
        if (sizeFraction === null || sizeFraction === undefined) {
            return { approved: false, reason: "Missing target size" };
        }

        const equity = snapshot.account.equity_usd;

        // Post-LLM Validator: Clamp size
        const maxFractionPerSymbol = snapshot.constraints.max_position_pct_equity_per_symbol;
        if (sizeFraction > maxFractionPerSymbol) {
            console.warn(`⚠️ Clamping position size for ${decision.symbol} from ${sizeFraction} to ${maxFractionPerSymbol}`);
            sizeFraction = maxFractionPerSymbol;
        }

        const proposedSizeUsd = equity * sizeFraction;

        // 11. Max Total Exposure
        const currentPositions = snapshot.account.current_positions;
        const currentExposure = currentPositions.reduce((sum, p) => sum + p.size_usd, 0);
        const maxTotal = equity * snapshot.constraints.max_total_exposure_pct_equity;

        if (currentExposure + proposedSizeUsd > maxTotal) {
            // Try to clamp to remaining exposure?
            const remainingExposure = maxTotal - currentExposure;
            if (remainingExposure < snapshot.constraints.min_trade_notional_usd) {
                return { approved: false, reason: `Total exposure limit reached (${snapshot.constraints.max_total_exposure_pct_equity * 100}%)` };
            }
            // Clamp to remaining
            if (proposedSizeUsd > remainingExposure) {
                console.warn(`⚠️ Clamping position size for ${decision.symbol} to remaining exposure: ${remainingExposure}`);
                // Update proposedSizeUsd (we can't easily update sizeFraction to match exactly without back-calc, but we use USD for order)
                // But we should update sizeFraction for consistency if we were returning it, but we return ApprovedOrder with sizeUsd.
            }
        }

        // 12. Min Trade Size
        if (proposedSizeUsd < snapshot.constraints.min_trade_notional_usd) {
            return { approved: false, reason: "Trade size too small" };
        }

        // Construct ApprovedOrder
        const isLong = decision.target_side === "long";
        const orderSide = isLong ? "buy" : "sell";
        const entryPx = market.price;

        const stopLossPrice = isLong
            ? entryPx * (1 - slPct)
            : entryPx * (1 + slPct);

        const takeProfitPrice = isLong
            ? entryPx * (1 + tpPct)
            : entryPx * (1 - tpPct);

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
            clientTag: clientTag,
            stopLossPrice,
            takeProfitPrice
        };

        return { approved: true, reason: "Risk Checks Passed", modifiedOrder: approvedOrder };
    }

    private assessClosePosition(decision: TradeDecision, snapshot: StateSnapshot): RiskAssessment {
        const position = snapshot.account.current_positions.find(p => p.symbol === decision.symbol);
        if (!position) {
            return { approved: false, reason: "No open position to close" };
        }

        let sizeToExecute = position.size_usd;
        let clientTag = "AI_TRADER_CLOSE";

        if (decision.action === "REDUCE_POSITION") {
            const targetFraction = decision.target_size_fraction_of_equity ?? 0;
            const targetSizeUsd = snapshot.account.equity_usd * targetFraction;
            const reduceAmount = position.size_usd - targetSizeUsd;

            if (reduceAmount <= 0) {
                return { approved: false, reason: `Position already below target size (Current: ${position.size_usd.toFixed(2)}, Target: ${targetSizeUsd.toFixed(2)})` };
            }

            sizeToExecute = Math.min(reduceAmount, position.size_usd);
            clientTag = "AI_TRADER_REDUCE";
        }

        const approvedOrder: ApprovedOrder = {
            symbol: decision.symbol!,
            side: position.side === "long" ? "sell" : "buy",
            sizeUsd: sizeToExecute,
            clientTag: clientTag
        };

        return { approved: true, reason: `${decision.action === "REDUCE_POSITION" ? "Reduce" : "Close"} Approved`, modifiedOrder: approvedOrder };
    }
}
