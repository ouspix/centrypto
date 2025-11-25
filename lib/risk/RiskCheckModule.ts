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

export class RiskCheckModule {

    public assess(decision: TradeDecision, snapshot: StateSnapshot): RiskAssessment {
        // --- A) Output/Accounting Invariants ---

        // 1. Check Kill Switch
        if (snapshot.constraints.kill_switch) {
            return { approved: false, reason: "Kill Switch Active" };
        }

        // 2. Check Daily Loss
        if (snapshot.account.daily_realized_pnl <= -snapshot.account.max_daily_loss) {
            return { approved: false, reason: "Max Daily Loss Exceeded" };
        }

        // 3. Validate Action Enum
        const allowedActions = snapshot.allowed_actions;
        if (!allowedActions.includes(decision.action) && decision.action !== "DO_NOTHING") {
            // "HOLD" might be mapped to "HOLD_POSITION" in prompt, but let's be strict
            if (decision.action === "HOLD" && allowedActions.includes("HOLD_POSITION")) {
                // Allow soft mapping or reject? User said "Reject anything else".
                return { approved: false, reason: `Invalid action: ${decision.action}. Must be one of ${allowedActions.join(", ")}` };
            }
            if (decision.action !== "HOLD") { // Allow HOLD if it's just a no-op
                return { approved: false, reason: `Invalid action: ${decision.action}` };
            }
        }

        if (decision.action === "DO_NOTHING" || decision.action === "HOLD") {
            return { approved: true, reason: "No Trade Proposed" };
        }

        if (!decision.symbol) {
            return { approved: false, reason: "No symbol provided" };
        }

        // 4. No Same-Tick Flip
        const currentPosition = snapshot.account.current_positions.find(p => p.symbol === decision.symbol);
        if (currentPosition) {
            const isFlip = (decision.target_side === "long" && currentPosition.side === "short") ||
                (decision.target_side === "short" && currentPosition.side === "long");

            if (isFlip && decision.action !== "CLOSE_POSITION") {
                return { approved: false, reason: "Cannot flip position in same tick. Must CLOSE_POSITION first." };
            }
        }

        // Dispatch based on action
        if (decision.action === "OPEN_POSITION" || decision.action === "INCREASE_POSITION") {
            return this.assessOpenPosition(decision, snapshot);
        }

        if (decision.action === "CLOSE_POSITION" || decision.action === "REDUCE_POSITION") {
            return this.assessClosePosition(decision, snapshot);
        }

        return { approved: false, reason: `Action ${decision.action} logic not implemented` };
    }

    private assessOpenPosition(decision: TradeDecision, snapshot: StateSnapshot): RiskAssessment {
        const market = snapshot.markets[decision.symbol!];
        if (!market) {
            return { approved: false, reason: `Market data not found for ${decision.symbol}` };
        }

        // --- B) Trade Permission Gates ---

        // 6. Tradeable Gate
        if (market.derived && !market.derived.liquidity.tradeable) {
            return { approved: false, reason: "Market not tradeable (Liquidity or Cost gate failed)" };
        }

        // 7. Edge Gate
        if (market.derived && !market.derived.edge.edge_ok) {
            return { approved: false, reason: `Insufficient edge (Edge: ${market.derived.edge.edge_bps} bps)` };
        }

        // 8. Playbook Gate & Direction Consistency
        const triggers = market.derived?.triggers;
        if (triggers) {
            const isLong = decision.target_side === "long";
            let playbookOk = false;
            let playbookReason = "";

            // Check specific playbook alignment
            if (decision.playbook.toLowerCase().includes("momentum")) {
                if (isLong && triggers.momentum_ok_long) playbookOk = true;
                else if (!isLong && triggers.momentum_ok_short) playbookOk = true;
                else playbookReason = "Momentum triggers not met for direction";
            } else if (decision.playbook.toLowerCase().includes("mean reversion") || decision.playbook.toLowerCase().includes("reversion")) {
                if (isLong && triggers.mr_ok_long) playbookOk = true;
                else if (!isLong && triggers.mr_ok_short) playbookOk = true;
                else playbookReason = "Mean Reversion triggers not met for direction";
            } else if (decision.playbook.toLowerCase().includes("breakout")) {
                if (triggers.breakout_ok) playbookOk = true;
                else playbookReason = "Breakout triggers not met";
            } else {
                // Fallback: Must satisfy AT LEAST one valid trigger for the direction
                if (isLong && (triggers.momentum_ok_long || triggers.mr_ok_long || triggers.breakout_ok)) playbookOk = true;
                else if (!isLong && (triggers.momentum_ok_short || triggers.mr_ok_short || triggers.breakout_ok)) playbookOk = true;
                else playbookReason = "No valid triggers met for direction";
            }

            if (!playbookOk) {
                return { approved: false, reason: `Playbook Gate Failed: ${playbookReason}` };
            }
        }

        // 9. Regime Compatibility Gate
        const regime = snapshot.global_regime.current;
        const isLong = decision.target_side === "long";

        if (regime === "RISK_ON") {
            // Forbid shorts unless MR short
            if (!isLong && triggers && !triggers.mr_ok_short) {
                return { approved: false, reason: "Regime Mismatch: RISK_ON forbids shorts (unless MR)" };
            }
        } else if (regime === "RISK_OFF") {
            // Forbid longs unless MR long
            if (isLong && triggers && !triggers.mr_ok_long) {
                return { approved: false, reason: "Regime Mismatch: RISK_OFF forbids longs (unless MR)" };
            }
        } else if (regime === "CHOP") {
            // Forbid opens unless edge is strong (4x cost) AND (MR or Breakout)
            const edgeStrong = market.derived && market.derived.edge.expected_move_bps >= (4 * market.derived.costs.cost_bps);
            const isTrend = decision.playbook.toLowerCase().includes("momentum");

            if (!edgeStrong) {
                return { approved: false, reason: "Regime Mismatch: CHOP requires strong edge (4x cost)" };
            }
            if (isTrend) {
                return { approved: false, reason: "Regime Mismatch: CHOP forbids Momentum plays" };
            }
        }

        // --- C) Risk Plan Enforcement ---

        // 10. Risk Plan Required
        if (!decision.risk_plan) {
            return { approved: false, reason: "Missing Risk Plan (SL/TP required)" };
        }

        // 11. Bounds
        const slPct = Math.abs(decision.risk_plan.stop_loss_pct);
        const tpPct = Math.abs(decision.risk_plan.take_profit_pct_primary);

        if (slPct < 0.005 || slPct > 0.05) {
            return { approved: false, reason: `Stop Loss ${slPct} out of bounds (0.5% - 5%)` };
        }

        if (tpPct < 1.5 * slPct) {
            return { approved: false, reason: `Risk/Reward too low (TP must be >= 1.5x SL)` };
        }

        // --- Accounting Checks ---

        const sizeFraction = decision.target_size_fraction_of_equity ?? decision.size_fraction_of_equity;
        if (sizeFraction === null || sizeFraction === undefined) {
            return { approved: false, reason: "Missing target size" };
        }

        const equity = snapshot.account.equity_usd;
        const proposedSizeUsd = equity * sizeFraction;

        // 3. Max Position Size
        const maxPerSymbol = equity * snapshot.constraints.max_position_pct_equity_per_symbol;
        if (proposedSizeUsd > maxPerSymbol) {
            return { approved: false, reason: `Position size exceeds limit (${snapshot.constraints.max_position_pct_equity_per_symbol * 100}%)` };
        }

        // 4. Max Total Exposure & Slots
        const currentPositions = snapshot.account.current_positions;
        const currentExposure = currentPositions.reduce((sum, p) => sum + p.size_usd, 0);
        const maxTotal = equity * snapshot.constraints.max_total_exposure_pct_equity;

        // Check slots (max 5)
        // If we are opening a NEW position (symbol not in current), check if we have space
        const isNewPosition = !currentPositions.find(p => p.symbol === decision.symbol);
        if (isNewPosition && currentPositions.length >= 5) {
            return { approved: false, reason: "Max position slots (5) reached" };
        }

        if (currentExposure + proposedSizeUsd > maxTotal) {
            return { approved: false, reason: `Total exposure exceeds limit (${snapshot.constraints.max_total_exposure_pct_equity * 100}%)` };
        }

        // 5. Min Trade Size
        if (proposedSizeUsd < snapshot.constraints.min_trade_notional_usd) {
            return { approved: false, reason: "Trade size too small" };
        }

        // Construct ApprovedOrder
        const orderSide = isLong ? "buy" : "sell";
        const entryPx = market.price;

        // Calculate SL/TP prices
        // SL is always a distance from entry. 
        // Long: Entry * (1 - slPct)
        // Short: Entry * (1 + slPct)
        const stopLossPrice = isLong
            ? entryPx * (1 - slPct)
            : entryPx * (1 + slPct);

        const takeProfitPrice = isLong
            ? entryPx * (1 + tpPct)
            : entryPx * (1 - tpPct);

        const approvedOrder: ApprovedOrder = {
            symbol: decision.symbol!,
            side: orderSide,
            sizeUsd: proposedSizeUsd,
            clientTag: "AI_TRADER",
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

        const approvedOrder: ApprovedOrder = {
            symbol: decision.symbol!,
            side: position.side === "long" ? "sell" : "buy",
            sizeUsd: position.size_usd,
            clientTag: "AI_TRADER_CLOSE"
        };

        return { approved: true, reason: "Close Approved", modifiedOrder: approvedOrder };
    }
}
