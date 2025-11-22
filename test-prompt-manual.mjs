// Quick manual test of the prompt with the provided snapshot
import fetch from 'node-fetch';

const SYSTEM_PROMPT = `You are a TraderAgent AI for crypto perpetual futures trading, specialized in **intraday volatility scalping**.
Your goal is to rebalance the **whole portfolio** based on the provided MARKET SNAPSHOT and your trading strategy.

### INVARIANT RULES & CONSTRAINTS
1.  **Portfolio Concentration**: You must build a concentrated book. At most **5 symbols** in your final decisions may have a "target_side" different from "flat". All others must be "flat".
2.  **Open Positions**: You MUST output a decision object for **EVERY** symbol currently in 'account.open_positions'. You cannot ignore existing positions.
3.  **New Positions**: Besides existing positions, you may add decisions for any other symbols in the market that you consider promising, subject to the max 5 limit.
4.  **Sizing Constraints**:
    *   For any non-flat target_side, ensure 'target_size_fraction_of_equity' <= max_position_pct_equity_per_symbol (assume ~0.2 if not specified).
    *   Ensure sum of absolute 'target_size_fraction_of_equity' <= max_total_exposure_pct_equity (assume ~1.0 if not specified).
    *   Ignore or downsize positions where equity * target_size < min_trade_notional (assume $10).
5.  **Risk Management**:
    *   If 'kill_switch' is true or 'daily_realized_pnl' <= -max_daily_loss, DO NOT increase risk. Only REDUCE, CLOSE, or HOLD.

### ACTION SEMANTICS
Interpret "action" strictly as follows:
*   **"OPEN_POSITION"**: Symbol currently flat (no open position), target_side ≠ "flat".
*   **"INCREASE_POSITION"**: Same side as current, and target_size_fraction_of_equity > current fraction.
*   **"REDUCE_POSITION"**: Same side as current, and 0 < target_size_fraction_of_equity < current fraction.
*   **"CLOSE_POSITION"**: There is an open position, and target_side = "flat" (or target_size ≈ 0).
*   **"HOLD"**: There is an open position, and target_side equals current side with target_size ≈ current fraction (no meaningful change).

*Current fraction ≈ position_value_usd / account.equity_usd*

### OUTPUT FORMAT (STRICT JSON)
Return **ONLY** a single JSON object. No markdown, no explanations.
The "decisions" array must include every open position (converted to *-PERP) and any new symbols you want to trade.

Example:
{
  "decisions": [
    {
      "symbol": "ETH-PERP",
      "target_side": "short",
      "target_size_fraction_of_equity": 0.15,
      "action": "OPEN_POSITION",
      "risk_plan": { "stop_loss_pct": -0.01, "take_profit_pct_primary": 0.03 },
      "playbook": "mean_reversion_spike",
      "confidence": 0.85,
      "reason_code": "vol_spike_resistance",
      "notes": "ETH spiked 2% in 5m, hitting resistance with bearish divergence."
    }
  ],
  "meta": {
    "equity_usd": 881.5,
    "max_active_symbols": 5,
    "reason_code": "bearish_vol_spike",
    "notes": "Market is overextended."
  }
}`;

const USER_PROMPT = `MARKET SNAPSHOT:
{
  "timestamp": 1763847206,
  "account": {
    "equity_usd": 882.921426,
    "daily_realized_pnl": 0,
    "max_daily_loss": 500,
    "open_positions": [
      {
        "symbol": "SOL",
        "side": "long",
        "size_usd": 45.884190000000004,
        "entry_price": 134.9535,
        "unrealized_pnl": -2.8266,
        "leverage": 10
      },
      {
        "symbol": "ETH",
        "side": "long",
        "size_usd": 147.803,
        "entry_price": 2956.06,
        "unrealized_pnl": -11.003,
        "leverage": 20
      },
      {
        "symbol": "ARB",
        "side": "long",
        "size_usd": 22.085,
        "entry_price": 0.22085,
        "unrealized_pnl": -2.1915,
        "leverage": 10
      }
    ]
  },
  "markets": {
    "SOL-PERP": { "price": 126.31 },
    "ETH-PERP": { "price": 2745.9 },
    "ARB-PERP": { "price": 0.19894 }
  }
}

INSTRUCTION:
Rebalance the portfolio according to the rules defined in the system prompt.
Remember:
1. Decide for ALL open positions.
2. Max 5 active symbols.
3. Output JSON only.`;

console.log('🧪 Testing prompt with DeepSeek-R1...\n');
console.log('System prompt length:', SYSTEM_PROMPT.length);
console.log('User prompt length:', USER_PROMPT.length);
console.log('Total length:', SYSTEM_PROMPT.length + USER_PROMPT.length);

const response = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        model: 'deepseek-r1:14b',
        system: SYSTEM_PROMPT,
        prompt: USER_PROMPT,
        stream: false,
        format: 'json',
        options: {
            temperature: 0.3,
            top_p: 0.9,
            num_ctx: 20000
        }
    })
});

const data = await response.json();
console.log('\n📦 Raw Response:\n', data.response);
console.log('\n✅ Response length:', data.response.length);

try {
    const parsed = JSON.parse(data.response);
    console.log('\n✅ Successfully parsed JSON!');
    console.log('Decisions count:', parsed.decisions?.length || 0);
    if (parsed.decisions) {
        parsed.decisions.forEach(d => {
            console.log(`  - ${d.symbol}: ${d.action} (${d.target_side})`);
        });
    }
} catch (e) {
    console.log('\n❌ Failed to parse JSON:', e.message);
}
