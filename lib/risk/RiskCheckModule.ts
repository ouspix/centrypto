import { ApprovedOrder } from "@/lib/hyperliquidExecution";
import { StateSnapshot } from "@/services/SnapshotBuilder";

export type TradeDecision = {
    action: "OPEN_POSITION" | "CLOSE_POSITION" | "REDUCE_POSITION" | "ADJUST_STOPS" | "DO_NOTHING" | "HOLD" | "INCREASE_POSITION";
    symbol: string | null;
    side: "long" | "short" | null;
    target_side: "long" | "short" | "flat" | null;
    target_size_fraction_of_equity: number | null;
    size_fraction_of_equity: number | null; // Deprecated, keeping for compatibility if needed, but prompt uses target_size_fraction_of_equity
    risk_plan: {
        stop_loss_pct: number;
        take_profit_pct_primary: number;
    } | null;
    playbook: string;
    confidence: number;
    reason_code: string;
    notes: string;
};

export type RiskAssessment = {
    approved: boolean;
    reason: string;
    modifiedOrder?: ApprovedOrder;
};

export class RiskCheckModule {

    public assess(decision: TradeDecision, snapshot: StateSnapshot): RiskAssessment {
        // 1. Check Kill Switch
        if (snapshot.constraints.kill_switch) {
            return { approved: false, reason: "Kill Switch Active" };
        }

        // 2. Check Daily Loss
        if (snapshot.account.daily_realized_pnl <= -snapshot.account.max_daily_loss) {
            return { approved: false, reason: "Max Daily Loss Exceeded" };
        }

        if (decision.action === "DO_NOTHING" || decision.action === "HOLD") {
            return { approved: true, reason: "No Trade Proposed" };
        }

        if (decision.action === "OPEN_POSITION" || decision.action === "INCREASE_POSITION") {
            return this.assessOpenPosition(decision, snapshot);
        }

        if (decision.action === "CLOSE_POSITION" || decision.action === "REDUCE_POSITION") {
            // Always allow closing (unless some specific rule)
            return this.assessClosePosition(decision, snapshot);
        }

        return { approved: false, reason: "Action not implemented yet" };
    }

    private assessOpenPosition(decision: TradeDecision, snapshot: StateSnapshot): RiskAssessment {
        // Use target_size_fraction_of_equity (new field) or fall back to deprecated size_fraction_of_equity
        const sizeFraction = decision.target_size_fraction_of_equity ?? decision.size_fraction_of_equity;

        if (!decision.symbol || !decision.target_side || sizeFraction === null || sizeFraction === undefined) {
            return { approved: false, reason: "Missing trade details" };
        }

        const equity = snapshot.account.equity_usd;
        const proposedSizeUsd = equity * sizeFraction;

        // 3. Check Max Position Size
        const maxPerSymbol = equity * snapshot.constraints.max_position_pct_equity_per_symbol;
        if (proposedSizeUsd > maxPerSymbol) {
            // Option: Shrink instead of reject
            // proposedSizeUsd = maxPerSymbol;
            return { approved: false, reason: `Position size exceeds limit (${snapshot.constraints.max_position_pct_equity_per_symbol * 100}%)` };
        }

        // 4. Check Max Total Exposure
        const currentExposure = snapshot.account.open_positions.reduce((sum, p) => sum + p.size_usd, 0);
        const maxTotal = equity * snapshot.constraints.max_total_exposure_pct_equity;

        if (currentExposure + proposedSizeUsd > maxTotal) {
            return { approved: false, reason: `Total exposure exceeds limit (${snapshot.constraints.max_total_exposure_pct_equity * 100}%)` };
        }

        // 5. Check Min Trade Size
        if (proposedSizeUsd < snapshot.constraints.min_trade_notional_usd) {
            return { approved: false, reason: "Trade size too small" };
        }

        // Construct ApprovedOrder
        const orderSide = (decision.target_side ?? decision.side) === "long" ? "buy" : "sell";
        const approvedOrder: ApprovedOrder = {
            symbol: decision.symbol,
            side: orderSide,
            sizeUsd: proposedSizeUsd,
            clientTag: "AI_TRADER",
            // Calculate TP/SL prices
            // This requires current price, which we need to look up in snapshot.markets
        };

        const market = snapshot.markets[decision.symbol];
        if (market && decision.risk_plan) {
            const entryPx = market.price;
            const isLong = (decision.target_side ?? decision.side) === "long";

            if (isLong) {
                approvedOrder.stopLossPrice = entryPx * (1 + decision.risk_plan.stop_loss_pct);
                approvedOrder.takeProfitPrice = entryPx * (1 + decision.risk_plan.take_profit_pct_primary);
            } else {
                approvedOrder.stopLossPrice = entryPx * (1 - decision.risk_plan.stop_loss_pct); // stop_loss_pct is negative, so 1 - (-0.02) = 1.02 (wrong for short SL)
                // Wait, prompt says "stop_loss_pct: -0.02 (negative for loss)".
                // For Long: Entry * (1 - 0.02) = 0.98. Correct.
                // For Short: Entry * (1 + 0.02) = 1.02. We need to ADD the absolute pct.
                approvedOrder.stopLossPrice = entryPx * (1 - decision.risk_plan.stop_loss_pct); // This adds it if pct is negative. Correct.

                // TP: "take_profit_pct_primary: 0.05".
                // For Long: Entry * 1.05.
                // For Short: Entry * 0.95.
                approvedOrder.takeProfitPrice = entryPx * (1 - decision.risk_plan.take_profit_pct_primary);
            }
        }

        return { approved: true, reason: "Risk Checks Passed", modifiedOrder: approvedOrder };
    }

    private assessClosePosition(decision: TradeDecision, snapshot: StateSnapshot): RiskAssessment {
        // Find position
        const position = snapshot.account.open_positions.find(p => p.symbol === decision.symbol);
        if (!position) {
            return { approved: false, reason: "No open position to close" };
        }

        const approvedOrder: ApprovedOrder = {
            symbol: decision.symbol!,
            side: position.side === "long" ? "sell" : "buy",
            sizeUsd: position.size_usd, // Close full size
            clientTag: "AI_TRADER_CLOSE"
        };

        return { approved: true, reason: "Close Approved", modifiedOrder: approvedOrder };
    }
}
