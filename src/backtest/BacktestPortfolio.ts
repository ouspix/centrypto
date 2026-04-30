import { AccountState, Position } from "@/types/snapshot";
import { AgentConfig } from "@/lib/agent-config";
import { MarketEntry } from "@/types/snapshot";
import { SimPosition, SimTrade } from "./BacktestTypes";

export class BacktestPortfolio {
    public readonly positions = new Map<string, SimPosition>();
    public readonly trades: SimTrade[] = [];
    public readonly equityCurve: Array<{ ts: Date; equity_usd: number }> = [];

    private realizedPnlUsd = 0;
    private feesUsd = 0;
    private readonly initialEquityUsd: number;
    private dailyBaseline: { day: string; realizedPnlUsd: number; equityUsd: number } | null = null;

    constructor(
        initialEquityUsd: number,
        private readonly config: AgentConfig
    ) {
        this.initialEquityUsd = initialEquityUsd;
        this.equityCurve.push({ ts: new Date(0), equity_usd: initialEquityUsd });
    }

    public get equityUsd(): number {
        return this.initialEquityUsd + this.realizedPnlUsd + this.unrealizedPnlUsd();
    }

    public get realizedPnl(): number {
        return this.realizedPnlUsd;
    }

    public get totalFeesUsd(): number {
        return this.feesUsd;
    }

    public buildAccountState(markets: Record<string, MarketEntry> = {}, ts: Date = new Date(0)): AccountState {
        const positions = Array.from(this.positions.values()).map(position => toSnapshotPosition(position, markets[position.symbol], ts));
        const unrealized = positions.reduce((sum, position) => sum + position.unrealized_pnl, 0);
        const equity = this.initialEquityUsd + this.realizedPnlUsd + unrealized;
        const baseline = this.getDailyBaseline(ts, equity);
        const dailyRealizedPnl = this.realizedPnlUsd - baseline.realizedPnlUsd;
        const dailyTotalPnl = equity - baseline.equityUsd;
        const totalExposure = positions.reduce((sum, position) => sum + position.fraction_of_equity, 0);
        return {
            equity_usd: equity,
            daily_realized_pnl: dailyRealizedPnl,
            daily_realized_pnl_usd: dailyRealizedPnl,
            daily_unrealized_pnl_usd: dailyTotalPnl - dailyRealizedPnl,
            daily_total_pnl_usd: dailyTotalPnl,
            max_daily_loss: equity * this.config.risk.daily_loss_kill_switch_fraction,
            current_positions: positions,
            derived_portfolio: {
                total_exposure_fraction: round(totalExposure, 6),
                remaining_capacity: round(Math.max(0, this.config.risk.max_total_exposure_fraction - totalExposure), 6),
                position_slots_used: positions.length,
                slots_remaining: Math.max(0, this.config.risk.max_positions - positions.length)
            }
        };
    }

    public canOpen(symbol: string, notionalUsd: number, ts: Date): { ok: boolean; reason: string } {
        if (this.positions.has(symbol)) return { ok: false, reason: "existing_position" };
        if (this.positions.size >= this.config.risk.max_positions) return { ok: false, reason: "max_positions" };
        if (notionalUsd < this.config.risk.min_trade_notional_usd) return { ok: false, reason: "min_notional" };

        const equity = this.equityUsd;
        const fraction = equity > 0 ? notionalUsd / equity : Infinity;
        if (fraction > this.config.risk.max_position_fraction_per_symbol) return { ok: false, reason: "max_symbol_exposure" };
        if (this.totalExposureFraction() + fraction > this.config.risk.max_total_exposure_fraction) return { ok: false, reason: "max_total_exposure" };

        const lastTrade = this.trades[this.trades.length - 1];
        if (
            this.config.risk.no_flip_same_tick &&
            lastTrade?.symbol === symbol &&
            lastTrade.exit_ts.getTime() === ts.getTime()
        ) {
            return { ok: false, reason: "no_flip_same_tick" };
        }

        return { ok: true, reason: "ok" };
    }

    public addPosition(position: SimPosition, entryFeeUsd: number, ts: Date): void {
        position.entry_fee_usd = entryFeeUsd;
        this.positions.set(position.symbol, position);
        this.feesUsd += entryFeeUsd;
        this.realizedPnlUsd -= entryFeeUsd;
        this.markToMarket(ts);
    }

    public closePosition(symbol: string, exitPrice: number, exitTs: Date, exitReason: string, exitFeeUsd: number, slippageBps: number, reduceNotionalUsd?: number): SimTrade | null {
        const position = this.positions.get(symbol);
        if (!position) return null;

        const closeNotional = reduceNotionalUsd ? Math.min(reduceNotionalUsd, position.notional_usd) : position.notional_usd;
        const closeFraction = position.notional_usd > 0 ? closeNotional / position.notional_usd : 1;
        const entryNotional = position.notional_usd * closeFraction;
        const sizeCoin = position.size_coin * closeFraction;
        const gross = position.side === "long"
            ? (exitPrice - position.entry_price) * sizeCoin
            : (position.entry_price - exitPrice) * sizeCoin;
        const entryFeeUsd = (position.entry_fee_usd ?? 0) * closeFraction;
        const net = gross - exitFeeUsd;
        this.realizedPnlUsd += net;
        this.feesUsd += exitFeeUsd;

        const trade: SimTrade = {
            trade_id: `${symbol}:${position.entry_ts.getTime()}:${exitTs.getTime()}:${this.trades.length}`,
            entry_ts: position.entry_ts,
            exit_ts: exitTs,
            symbol,
            side: position.side,
            playbook: position.playbook,
            entry_price: position.entry_price,
            exit_price: exitPrice,
            size_fraction: position.size_fraction * closeFraction,
            notional_usd: entryNotional,
            fees_usd: entryFeeUsd + exitFeeUsd,
            slippage_bps: slippageBps,
            gross_pnl_usd: gross,
            net_pnl_usd: gross - entryFeeUsd - exitFeeUsd,
            exit_reason: exitReason,
            max_favorable_excursion_bps: position.max_favorable_excursion_bps,
            max_adverse_excursion_bps: position.max_adverse_excursion_bps,
            entry_regime: position.entry_regime
        };
        this.trades.push(trade);

        if (closeFraction >= 0.999999) {
            this.positions.delete(symbol);
        } else {
            position.notional_usd -= closeNotional;
            position.size_coin -= sizeCoin;
            position.size_fraction *= (1 - closeFraction);
            position.entry_fee_usd = Math.max(0, (position.entry_fee_usd ?? 0) - entryFeeUsd);
        }

        this.markToMarket(exitTs);
        return trade;
    }

    public markToMarket(ts: Date, markets: Record<string, MarketEntry> = {}): void {
        for (const position of this.positions.values()) {
            const price = markets[position.symbol]?.price ?? position.entry_price;
            position.unrealized_pnl_usd = position.side === "long"
                ? (price - position.entry_price) * position.size_coin
                : (position.entry_price - price) * position.size_coin;
        }
        this.equityCurve.push({ ts, equity_usd: this.equityUsd });
    }

    public totalExposureFraction(): number {
        const equity = this.equityUsd;
        if (equity <= 0) return 0;
        return Array.from(this.positions.values()).reduce((sum, position) => sum + position.notional_usd / equity, 0);
    }

    private unrealizedPnlUsd(): number {
        return Array.from(this.positions.values()).reduce((sum, position) => sum + (position.unrealized_pnl_usd ?? 0), 0);
    }

    private getDailyBaseline(ts: Date, equityUsd: number): { day: string; realizedPnlUsd: number; equityUsd: number } {
        const day = ts.toISOString().slice(0, 10);
        if (!this.dailyBaseline || this.dailyBaseline.day !== day) {
            this.dailyBaseline = {
                day,
                realizedPnlUsd: this.realizedPnlUsd,
                equityUsd
            };
        }
        return this.dailyBaseline;
    }
}

function toSnapshotPosition(position: SimPosition, market: MarketEntry | undefined, ts: Date): Position {
    const price = market?.price ?? position.entry_price;
    const unrealized = position.side === "long"
        ? (price - position.entry_price) * position.size_coin
        : (position.entry_price - price) * position.size_coin;
    position.unrealized_pnl_usd = unrealized;
    return {
        symbol: position.symbol,
        side: position.side,
        size_usd: position.notional_usd,
        size_coin: position.size_coin,
        fraction_of_equity: position.size_fraction,
        entry_price: position.entry_price,
        unrealized_pnl: unrealized,
        leverage: 1,
        position_age_min: Math.max(0, Math.floor((ts.getTime() - position.entry_ts.getTime()) / 60_000)),
        regim_when_opening: typeof position.entry_regime === "string" ? position.entry_regime : null,
        edge_to_cost: position.entry_signal.edge_to_cost_mult,
        playbook_when_opened: position.playbook
    };
}

function round(value: number, places: number): number {
    const factor = Math.pow(10, places);
    return Math.round(value * factor) / factor;
}
