
import { RiskCheckModule, TradeDecision } from "./lib/risk/RiskCheckModule";
import { StateSnapshot } from "./services/SnapshotBuilder";

const riskModule = new RiskCheckModule();

const mockSnapshot: StateSnapshot = {
    account: {
        equity_usd: 10000,
        current_positions: [
            {
                symbol: "ETH-PERP",
                side: "long",
                size_usd: 1000, // 10% of equity
                size_coin: 0.5,
                entry_price: 2000,
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
        "ETH-PERP": {
            price: 2000,
            assetIndex: 2,
            derived: {
                liquidity: { tradeable: true },
                edge: { edge_bps: 10, edge_ok: true },
                costs: { cost_bps: 5, cost_ok: true },
                triggers: { momentum_ok_long: true }
            }
        }
    },
    constraints: {
        kill_switch: false,
        no_flip_same_tick: true,
        max_position_pct_equity_per_symbol: 0.5,
        max_total_exposure_pct_equity: 1.0,
        min_trade_notional_usd: 10
    },
    allowed_actions: ["OPEN_POSITION", "CLOSE_POSITION", "REDUCE_POSITION", "INCREASE_POSITION", "HOLD"]
} as any;

const decision: TradeDecision = {
    action: "INCREASE_POSITION",
    symbol: "ETH-PERP",
    target_side: "long",
    target_size_fraction_of_equity: 0.2, // Target 20% (2000 USD)
    playbook: "Momentum",
    risk_plan: { stop_loss_pct: 0.02, take_profit_pct_primary: 0.04 },
    confidence: 0.8,
    reason_code: "momentum_continuation",
    notes: "Adding to winner",
    side: "long",
    size_fraction_of_equity: null
};

const assessment = riskModule.assess(decision, mockSnapshot);

console.log("Decision:", decision.action);
console.log("Current Size:", mockSnapshot.account.current_positions[0].size_usd);
console.log("Target Size:", mockSnapshot.account.equity_usd * decision.target_size_fraction_of_equity!);
console.log("Expected Increase Amount:", 2000 - 1000);

if (assessment.modifiedOrder) {
    console.log("Calculated Order Size:", assessment.modifiedOrder.sizeUsd);
    if (assessment.modifiedOrder.sizeUsd === 2000) {
        console.error("FAIL: Order size equals full target size (Double Counting)");
    } else if (assessment.modifiedOrder.sizeUsd === 1000) {
        console.log("PASS: Order size matches expected increase");
    } else {
        console.error("FAIL: Order size is incorrect:", assessment.modifiedOrder.sizeUsd);
    }
} else {
    console.error("FAIL: No modified order returned", assessment.reason);
}
