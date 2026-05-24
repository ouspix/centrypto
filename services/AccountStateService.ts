import { getClearinghouseState, getSpotClearinghouseState } from "@/lib/hyperliquid-info";
import { AgentConfig } from "@/lib/agent-config";
import { AccountState, DerivedPortfolio, Position } from "@/types/snapshot";
import { traderLog, traderWarn } from "@/lib/log/traderLog";

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
            traderLog(`Fetching clearinghouse state for authenticated wallet (${isTestnet ? "testnet" : "mainnet"}).`);
            const [clearinghouseState, spotClearinghouseState] = await Promise.all([
                getClearinghouseState(userAddress, isTestnet),
                getSpotClearinghouseState(userAddress, isTestnet)
            ]);
            const spotUsdc = this.readSpotUsdc(spotClearinghouseState);

            if (clearinghouseState) {
                const marginSummary = clearinghouseState.marginSummary;
                const positions = Array.isArray(clearinghouseState.assetPositions)
                    ? clearinghouseState.assetPositions
                    : [];

                const perpEquity = this.numberFrom(marginSummary?.accountValue);
                const useSpotEquity = this.shouldUseSpotEquity(perpEquity, spotUsdc, spotClearinghouseState);
                account.equity_usd = useSpotEquity ? spotUsdc : perpEquity;
                account.perp_equity_usd = perpEquity;
                account.spot_usdc = spotUsdc;
                account.equity_source = useSpotEquity ? "spot_usdc" : "perps";
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

                traderLog(`Found ${account.current_positions.length} open position(s).`);
            } else {
                traderWarn("⚠️ Failed to fetch clearinghouse state or it was null.");
                if (spotUsdc > 0) {
                    account.equity_usd = spotUsdc;
                    account.perp_equity_usd = 0;
                    account.spot_usdc = spotUsdc;
                    account.equity_source = "spot_usdc";
                }
            }
        } else {
            traderLog("ℹ️ No user address provided, skipping account data fetch.");
        }

        account.daily_unrealized_pnl_usd = account.current_positions.reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0);
        account.daily_total_pnl_usd = (account.daily_realized_pnl_usd || account.daily_realized_pnl || 0) + account.daily_unrealized_pnl_usd;
        account.max_daily_loss = account.equity_usd * riskConfig.daily_loss_kill_switch_fraction;
        account.derived_portfolio = this.calculateDerivedPortfolio(account.current_positions, account.equity_usd, riskConfig);

        return { account, heldSymbols };
    }

    private readSpotUsdc(spotState: any): number {
        const balances = Array.isArray(spotState?.balances) ? spotState.balances : [];
        const usdc = balances.find((balance: any) => String(balance?.coin ?? "").toUpperCase() === "USDC");
        return this.numberFrom(usdc?.total);
    }

    private shouldUseSpotEquity(perpEquity: number, spotUsdc: number, spotState: any): boolean {
        if (spotUsdc <= 0) return false;
        if (perpEquity <= 0) return true;
        return Array.isArray(spotState?.tokenToAvailableAfterMaintenance);
    }

    private numberFrom(value: unknown): number {
        const parsed = typeof value === "number" ? value : parseFloat(String(value ?? "0"));
        return Number.isFinite(parsed) ? parsed : 0;
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
