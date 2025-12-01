
import { RiskCheckModule, TradeDecision } from "./lib/risk/RiskCheckModule";
import { StateSnapshot } from "./services/SnapshotBuilder";

const riskModule = new RiskCheckModule();

const mockSnapshot: StateSnapshot = {
    account: {
        equity_usd: 10000,
        current_positions: [
            {
                symbol: "AAVE-PERP",
                side: "short",
                size_usd: 5000, // 50% of equity
                size_coin: 10,
                entry_price: 500,
                unrealized_pnl: 0,
                leverage: 1
            }
        ],
        daily_realized_pnl: 0,
        max_daily_loss: 1000,
        derived_portfolio: {
            slots_remaining: 5
        }
    },
    markets: {
        "AAVE-PERP": {
            price: 500,
            assetIndex: 1
        }
    },
    constraints: {
        kill_switch: false,
        no_flip_same_tick: true,
        max_position_pct_equity_per_symbol: 0.2, // 20%
        max_total_exposure_pct_equity: 1.0,
        min_trade_notional_usd: 10
    },
    allowed_actions: ["OPEN_POSITION", "CLOSE_POSITION", "REDUCE_POSITION", "HOLD"]
} as any;

const decision: TradeDecision = {
    action: "REDUCE_POSITION",
    symbol: "AAVE-PERP",
    target_side: "short",
    target_size_fraction_of_equity: 0.2, // Target 20% (2000 USD)
    playbook: "Risk Management",
    risk_plan: { stop_loss_pct: 0.02, take_profit_pct_primary: 0.015 },
    confidence: 0.75,
    reason_code: "over_position_limit",
    notes: "Reduce to comply",
    side: "short",
    size_fraction_of_equity: null
};

const assessment = riskModule.assess(decision, mockSnapshot);

console.log("Decision:", decision.action);
console.log("Current Size:", mockSnapshot.account.current_positions[0].size_usd);
console.log("Target Size:", mockSnapshot.account.equity_usd * decision.target_size_fraction_of_equity!);
console.log("Expected Reduce Size:", 5000 - 2000);

if (assessment.modifiedOrder) {
    console.log("Calculated Order Size:", assessment.modifiedOrder.sizeUsd);
    if (assessment.modifiedOrder.sizeUsd === 5000) {
        console.error("FAIL: Order size equals full position size (CLOSE instead of REDUCE)");
    } else if (assessment.modifiedOrder.sizeUsd === 3000) {
        console.log("PASS: Order size matches expected reduction");
    } else {
        console.error("FAIL: Order size is incorrect:", assessment.modifiedOrder.sizeUsd);
    }
} else {
    console.error("FAIL: No modified order returned");
}
