import "server-only";

import { DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { getWalletKillSwitch } from "@/lib/risk/kill-switch";
import { AccountStateService } from "@/services/AccountStateService";

export async function assertWalletExecutionAllowed(userAddress: string, isTestnet: boolean): Promise<void> {
    const killSwitch = await getWalletKillSwitch(userAddress, isTestnet);
    if (killSwitch) {
        throw new Error("Backend kill switch is active for this wallet");
    }

    const accountState = new AccountStateService();
    const { account } = await accountState.buildAccountState(userAddress, isTestnet, DEFAULT_AGENT_CONFIG.risk);
    const maxDailyLoss = account.equity_usd * DEFAULT_AGENT_CONFIG.risk.daily_loss_kill_switch_fraction;
    const dailyTotal = account.daily_total_pnl_usd ?? account.daily_realized_pnl_usd ?? account.daily_realized_pnl ?? 0;
    if (dailyTotal <= -maxDailyLoss) {
        throw new Error(`Daily loss kill switch active (${dailyTotal.toFixed(2)} <= -${maxDailyLoss.toFixed(2)})`);
    }
}
