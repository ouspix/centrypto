import { AgentConfig } from "@/lib/agent-config";
import { MarketEntry } from "@/types/snapshot";
import { TradeDecision } from "@/types/trading";
import { BacktestCandle } from "./BacktestDataSource";
import { BacktestPortfolio } from "./BacktestPortfolio";
import { ExecutionBookSnapshot, ExecutionResult, L2BookLevel, SimPosition } from "./BacktestTypes";

export type ExecutionBookResolver = (symbol: string, ts: Date) => ExecutionBookSnapshot | null;

type Fill = {
    price: number;
    slippageBps: number;
    usedBook: boolean;
};

export class ExecutionSimulator {
    constructor(
        private readonly config: AgentConfig,
        private readonly network: "mainnet" | "testnet" = "mainnet"
    ) {}

    public advancePositionWithCandles(
        position: SimPosition,
        candles: BacktestCandle[],
        portfolio: BacktestPortfolio
    ): void {
        for (const candle of candles) {
            const high = Number(candle.high);
            const low = Number(candle.low);
            const close = Number(candle.close);
            this.updateExcursions(position, high, low);

            const stop = position.side === "long"
                ? position.entry_price * (1 - position.stop_loss_pct)
                : position.entry_price * (1 + position.stop_loss_pct);
            const takeProfit = position.side === "long"
                ? position.entry_price * (1 + position.take_profit_pct)
                : position.entry_price * (1 - position.take_profit_pct);

            if (position.side === "long") {
                if (low <= stop) {
                    this.closeAtPrice(position.symbol, stop, asDate(candle.openTime), "stop_loss", portfolio, 0);
                    return;
                }
                if (high >= takeProfit) {
                    this.closeAtPrice(position.symbol, takeProfit, asDate(candle.openTime), "take_profit", portfolio, 0);
                    return;
                }
            } else {
                if (high >= stop) {
                    this.closeAtPrice(position.symbol, stop, asDate(candle.openTime), "stop_loss", portfolio, 0);
                    return;
                }
                if (low <= takeProfit) {
                    this.closeAtPrice(position.symbol, takeProfit, asDate(candle.openTime), "take_profit", portfolio, 0);
                    return;
                }
            }

            if (position.time_stop_minutes && asDate(candle.openTime).getTime() - position.entry_ts.getTime() >= position.time_stop_minutes * 60_000) {
                this.closeAtPrice(position.symbol, close, asDate(candle.openTime), "time_stop", portfolio, 0);
                return;
            }
        }
    }

    public apply(
        decisions: TradeDecision[],
        markets: Record<string, MarketEntry>,
        portfolio: BacktestPortfolio,
        ts: Date,
        resolveBook?: ExecutionBookResolver
    ): ExecutionResult[] {
        const results: ExecutionResult[] = [];
        for (const decision of decisions) {
            if (!decision.symbol) {
                results.push(this.result(decision, false, false, "skipped", "missing_symbol"));
                continue;
            }
            if (decision.action === "OPEN_POSITION") {
                results.push(this.open(decision, markets[decision.symbol], portfolio, ts, resolveBook));
            } else if (decision.action === "CLOSE_POSITION" || decision.action === "REDUCE_POSITION") {
                results.push(this.closeOrReduce(decision, markets[decision.symbol], portfolio, ts, resolveBook));
            } else {
                results.push(this.result(decision, false, false, "skipped", "non_executable_action"));
            }
        }
        return results;
    }

    private open(decision: TradeDecision, market: MarketEntry | undefined, portfolio: BacktestPortfolio, ts: Date, resolveBook?: ExecutionBookResolver): ExecutionResult {
        if (!market) return this.result(decision, true, false, "failed", "missing_market");
        if (!decision.symbol || !decision.target_side || decision.target_side === "flat") return this.result(decision, true, false, "failed", "invalid_open_side");
        const fraction = decision.target_size_fraction_of_equity ?? decision.size_fraction_of_equity ?? 0;
        if (fraction <= 0) return this.result(decision, true, false, "failed", "invalid_size_fraction");
        const notionalUsd = portfolio.equityUsd * fraction;
        const allowed = portfolio.canOpen(decision.symbol, notionalUsd, ts);
        if (!allowed.ok) return this.result(decision, true, false, "failed", allowed.reason, { requested_notional_usd: notionalUsd });

        const side = decision.target_side;
        const fill = this.resolveEntryFill(market, side, notionalUsd, ts, resolveBook);
        if (!fill || fill.price <= 0) {
            return this.result(decision, true, false, "failed", "insufficient_book_depth", {
                requested_notional_usd: notionalUsd,
                used_book: !!resolveBook?.(market.symbol, ts)
            });
        }
        const feeUsd = fee(notionalUsd, this.feeBps());
        const sizeCoin = notionalUsd / fill.price;
        const riskPlan = decision.risk_plan;
        if (!riskPlan) return this.result(decision, true, false, "failed", "missing_risk_plan", { requested_notional_usd: notionalUsd });

        const position: SimPosition = {
            id: `${decision.symbol}:${ts.getTime()}`,
            symbol: decision.symbol,
            side,
            playbook: decision.playbook || "none",
            entry_ts: ts,
            entry_price: fill.price,
            size_fraction: fraction,
            notional_usd: notionalUsd,
            size_coin: sizeCoin,
            stop_loss_pct: Math.abs(riskPlan.stop_loss_pct),
            take_profit_pct: Math.abs(riskPlan.take_profit_pct_primary),
            time_stop_minutes: timeStopForPlaybook(decision.playbook, this.config),
            entry_regime: market.regime_tags ?? null,
            entry_signal: {
                ret_sigma_5m_vs_1h: market.derived?.normalized.ret_sigma_5m_vs_1h ?? null,
                vol_ratio_5m_vs_1h: market.derived?.normalized.vol_ratio_5m_vs_1h ?? null,
                book_pressure: market.orderbook.book_pressure ?? null,
                trend_alignment_score: market.derived?.triggers.trend_aligned ? 1 : 0,
                edge_to_cost_mult: market.derived?.entry?.edge_to_cost_mult ?? null
            },
            highest_price: fill.price,
            lowest_price: fill.price,
            max_favorable_excursion_bps: 0,
            max_adverse_excursion_bps: 0,
            unrealized_pnl_usd: 0
        };

        portfolio.addPosition(position, feeUsd, ts);
        return this.result(decision, true, true, "executed", "opened", {
            fill_price: fill.price,
            requested_notional_usd: notionalUsd,
            filled_notional_usd: notionalUsd,
            fees_usd: feeUsd,
            slippage_bps: fill.slippageBps,
            used_book: fill.usedBook
        });
    }

    private closeOrReduce(decision: TradeDecision, market: MarketEntry | undefined, portfolio: BacktestPortfolio, ts: Date, resolveBook?: ExecutionBookResolver): ExecutionResult {
        if (!market) return this.result(decision, true, false, "failed", "missing_market");
        if (!decision.symbol) return this.result(decision, true, false, "failed", "missing_symbol");
        const position = portfolio.positions.get(decision.symbol);
        if (!position) return this.result(decision, true, false, "failed", "missing_position");
        const targetFraction = decision.action === "REDUCE_POSITION"
            ? Math.max(0, decision.target_size_fraction_of_equity ?? 0)
            : 0;
        const reduceNotional = decision.action === "REDUCE_POSITION"
            ? Math.max(0, position.notional_usd - (portfolio.equityUsd * targetFraction))
            : undefined;
        const requestedNotional = reduceNotional ?? position.notional_usd;
        const fill = this.resolveExitFill(market, position.side, requestedNotional, ts, resolveBook);
        if (!fill || fill.price <= 0) {
            return this.result(decision, true, false, "failed", "insufficient_book_depth", {
                requested_notional_usd: requestedNotional,
                used_book: !!resolveBook?.(market.symbol, ts)
            });
        }
        const feeUsd = fee(requestedNotional, this.feeBps());
        const trade = portfolio.closePosition(decision.symbol, fill.price, ts, decision.action.toLowerCase(), feeUsd, fill.slippageBps, reduceNotional);
        return this.result(decision, true, !!trade, trade ? "executed" : "failed", trade ? "closed_or_reduced" : "portfolio_close_failed", {
            fill_price: fill.price,
            requested_notional_usd: requestedNotional,
            filled_notional_usd: trade ? requestedNotional : 0,
            fees_usd: feeUsd,
            slippage_bps: fill.slippageBps,
            used_book: fill.usedBook,
            trade_id: trade?.trade_id ?? null
        });
    }

    private closeAtPrice(symbol: string, price: number, ts: Date, reason: string, portfolio: BacktestPortfolio, slippageBps: number): void {
        const position = portfolio.positions.get(symbol);
        if (!position) return;
        const feeUsd = fee(position.notional_usd, this.feeBps());
        portfolio.closePosition(symbol, price, ts, reason, feeUsd, slippageBps);
    }

    private updateExcursions(position: SimPosition, high: number, low: number): void {
        position.highest_price = Math.max(position.highest_price, high);
        position.lowest_price = Math.min(position.lowest_price, low);
        if (position.side === "long") {
            position.max_favorable_excursion_bps = Math.max(position.max_favorable_excursion_bps, 10000 * (position.highest_price / position.entry_price - 1));
            position.max_adverse_excursion_bps = Math.min(position.max_adverse_excursion_bps, 10000 * (position.lowest_price / position.entry_price - 1));
        } else {
            position.max_favorable_excursion_bps = Math.max(position.max_favorable_excursion_bps, 10000 * (1 - position.lowest_price / position.entry_price));
            position.max_adverse_excursion_bps = Math.min(position.max_adverse_excursion_bps, 10000 * (1 - position.highest_price / position.entry_price));
        }
    }

    private entryPrice(market: MarketEntry, side: "long" | "short", slippageBps: number): number {
        if (side === "long") {
            const bestAsk = market.orderbook.best_ask || market.price * (1 + market.spread_bps / 20000);
            return bestAsk * (1 + slippageBps / 10000);
        }
        const bestBid = market.orderbook.best_bid || market.price * (1 - market.spread_bps / 20000);
        return bestBid * (1 - slippageBps / 10000);
    }

    private exitPrice(market: MarketEntry, side: "long" | "short", slippageBps: number): number {
        if (side === "long") {
            const bestBid = market.orderbook.best_bid || market.price * (1 - market.spread_bps / 20000);
            return bestBid * (1 - slippageBps / 10000);
        }
        const bestAsk = market.orderbook.best_ask || market.price * (1 + market.spread_bps / 20000);
        return bestAsk * (1 + slippageBps / 10000);
    }

    private resolveSlippageBps(market: MarketEntry): number {
        return Math.max(0, market.derived?.costs.slippage_bps_est ?? this.config.network_profiles[this.network].slippage_model.min_bps);
    }

    private resolveEntryFill(
        market: MarketEntry,
        side: "long" | "short",
        notionalUsd: number,
        ts: Date,
        resolveBook?: ExecutionBookResolver
    ): Fill | null {
        const book = resolveBook?.(market.symbol, ts);
        if (book) {
            return side === "long"
                ? walkBook(book.asks, notionalUsd, book.asks[0]?.price ?? market.orderbook.best_ask, "buy")
                : walkBook(book.bids, notionalUsd, book.bids[0]?.price ?? market.orderbook.best_bid, "sell");
        }

        const slippageBps = this.resolveSlippageBps(market);
        return { price: this.entryPrice(market, side, slippageBps), slippageBps, usedBook: false };
    }

    private resolveExitFill(
        market: MarketEntry,
        positionSide: "long" | "short",
        notionalUsd: number,
        ts: Date,
        resolveBook?: ExecutionBookResolver
    ): Fill | null {
        const book = resolveBook?.(market.symbol, ts);
        if (book) {
            return positionSide === "long"
                ? walkBook(book.bids, notionalUsd, book.bids[0]?.price ?? market.orderbook.best_bid, "sell")
                : walkBook(book.asks, notionalUsd, book.asks[0]?.price ?? market.orderbook.best_ask, "buy");
        }

        const slippageBps = this.resolveSlippageBps(market);
        return { price: this.exitPrice(market, positionSide, slippageBps), slippageBps, usedBook: false };
    }

    private feeBps(): number {
        return this.config.network_profiles[this.network].fees_bps;
    }

    private result(
        decision: TradeDecision,
        attempted: boolean,
        success: boolean,
        status: string,
        reason: string,
        extra: Partial<ExecutionResult> = {}
    ): ExecutionResult {
        return {
            decision,
            attempted,
            success,
            status,
            reason,
            symbol: decision.symbol,
            action: decision.action,
            candidate_id: decision.candidate_id ?? null,
            ...extra
        };
    }
}

function fee(notionalUsd: number, feeBps: number): number {
    return notionalUsd * feeBps / 10000;
}

function walkBook(levels: L2BookLevel[], notionalUsd: number, referencePrice: number | undefined, side: "buy" | "sell"): Fill | null {
    if (!referencePrice || referencePrice <= 0 || notionalUsd <= 0) return null;
    let remaining = notionalUsd;
    let baseFilled = 0;
    let quoteSpent = 0;

    for (const level of levels) {
        const levelNotional = level.price * level.size;
        const takeNotional = Math.min(remaining, levelNotional);
        const takeSize = takeNotional / level.price;
        baseFilled += takeSize;
        quoteSpent += takeNotional;
        remaining -= takeNotional;
        if (remaining <= 1e-9) break;
    }

    if (remaining > 1e-6 || baseFilled <= 0 || quoteSpent <= 0) return null;
    const avgFill = quoteSpent / baseFilled;
    const slippageBps = side === "buy"
        ? 10000 * (avgFill / referencePrice - 1)
        : 10000 * (1 - avgFill / referencePrice);
    return {
        price: avgFill,
        slippageBps: Math.max(0, slippageBps),
        usedBook: true
    };
}

function timeStopForPlaybook(playbook: string | null | undefined, config: AgentConfig): number | undefined {
    const name = (playbook || "").toLowerCase();
    if (name.includes("mean reversion")) return 45;
    if (name.includes("breakout")) return 90;
    if (name.includes("momentum")) return config.risk.stop_loss_templates.trend.time_stop_minutes ?? 180;
    return config.risk.stop_loss_templates.default.time_stop_minutes;
}

function asDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}
