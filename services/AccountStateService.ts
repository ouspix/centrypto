import { getClearinghouseState } from "@/lib/hyperliquid";
import { AgentConfig } from "@/lib/agent-config";
import { AccountState, DerivedPortfolio, Position } from "@/types/snapshot";

export class AccountStateService {
    public async buildAccountState(
        userAddress: string | null,
        isTestnet: boolean,
        riskConfig: AgentConfig["risk"]
    ): Promise<{ account: AccountState; heldSymbols: string[] }> {
        const account: AccountState = {
            equity_usd: 10000.0,
            daily_realized_pnl: 0.0,
            daily_realized_pnl_usd: 0.0,
            daily_unrealized_pnl_usd: 0.0,
            daily_total_pnl_usd: 0.0,
            max_daily_loss: 0.0,
            current_positions: [],
            derived_portfolio: {
                total_exposure_fraction: 0,
                remaining_capacity: riskConfig.max_total_exposure_fraction,
                position_slots_used: 0,
                slots_remaining: riskConfig.max_positions
            }
        };

        const heldSymbols: string[] = [];

        if (userAddress) {
            console.log(`🔍 Fetching clearinghouse state for ${userAddress}...`);
            const clearinghouseState = await getClearinghouseState(userAddress, isTestnet);

            if (clearinghouseState) {
                const marginSummary = clearinghouseState.marginSummary;
                const positions = clearinghouseState.assetPositions;

                const equity = parseFloat(marginSummary.accountValue);
                account.equity_usd = isNaN(equity) ? 0 : equity;
                const realizedPnl = parseFloat((marginSummary as any)?.totalPnl24h || marginSummary?.totalPnl || 0);
                account.daily_realized_pnl = isNaN(realizedPnl) ? 0 : realizedPnl;
                account.daily_realized_pnl_usd = account.daily_realized_pnl;

                account.current_positions = positions
                    .filter((p: any) => parseFloat(p.position.szi) !== 0)
                    .map((p: any): Position => {
                        const size = parseFloat(p.position.szi) || 0;
                        const entryPrice = parseFloat(p.position.entryPx) || 0;
                        const side = size > 0 ? "long" : "short";
                        const unrealizedPnl = parseFloat(p.position.unrealizedPnl) || 0;
                        const leverage = parseFloat(p.position.leverage.value) || 0;
                        const symbol = p.position.coin || "UNKNOWN";
                        const sizeUsd = Math.abs(size) * entryPrice;

                        heldSymbols.push(symbol);

                        return {
                            symbol: `${symbol}-PERP`,
                            side,
                            size_usd: sizeUsd,
                            size_coin: Math.abs(size),
                            fraction_of_equity: account.equity_usd > 0 ? sizeUsd / account.equity_usd : 0,
                            entry_price: entryPrice,
                            unrealized_pnl: unrealizedPnl,
                            leverage
                        };
                    });

                console.log(`✅ Found ${account.current_positions.length} open positions:`, account.current_positions.map((p: any) => p.symbol).join(", "));
            } else {
                console.warn("⚠️ Failed to fetch clearinghouse state or it was null.");
            }
        } else {
            console.log("ℹ️ No user address provided, skipping account data fetch.");
        }

        account.daily_unrealized_pnl_usd = account.current_positions.reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0);
        account.daily_total_pnl_usd = (account.daily_realized_pnl_usd || account.daily_realized_pnl || 0) + account.daily_unrealized_pnl_usd;
        account.max_daily_loss = account.equity_usd * riskConfig.daily_loss_kill_switch_fraction;
        account.derived_portfolio = this.calculateDerivedPortfolio(account.current_positions, account.equity_usd, riskConfig);

        return { account, heldSymbols };
    }

    private calculateDerivedPortfolio(positions: Position[], equityUsd: number, riskConfig: AgentConfig["risk"]): DerivedPortfolio {
        const maxTotalExposure = riskConfig.max_total_exposure_fraction;
        const maxSlots = riskConfig.max_positions;
        const totalExposure = positions.reduce((sum: number, p: Position) => sum + p.fraction_of_equity, 0);

        return {
            total_exposure_fraction: parseFloat(totalExposure.toFixed(4)),
            remaining_capacity: parseFloat((maxTotalExposure - totalExposure).toFixed(4)),
            position_slots_used: positions.length,
            slots_remaining: Math.max(0, maxSlots - positions.length)
        };
    }
}
