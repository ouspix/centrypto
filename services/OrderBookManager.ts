import { HyperliquidWS } from "@/lib/hyperliquid-ws";
import { OrderBookMetrics } from "./MarketAnalysisService";

type WsLevel = { px: string; sz: string; n: number };
type WsBook = { coin: string; levels: [WsLevel[], WsLevel[]]; time: number };

export class OrderBookManager {
    private ws: HyperliquidWS;
    private books: Map<string, WsBook> = new Map();
    private activeSymbols: Set<string> = new Set();
    private depthBandsPct: string[] = ["0.10", "0.25", "0.50", "1.00"];
    private depthBandFractions: number[] = [0.001, 0.0025, 0.005, 0.01];

    constructor(ws: HyperliquidWS) {
        this.ws = ws;
        this.ws.on('l2Book', (book: WsBook) => {
            this.handleBookUpdate(book);
        });
    }

    /**
     * Updates the set of symbols we want to track.
     * Subscribes to new ones, unsubscribes from old ones.
     */
    public updateSubscriptions(symbols: string[]) {
        const newSet = new Set(symbols);

        // Subscribe to new
        for (const sym of newSet) {
            if (!this.activeSymbols.has(sym)) {
                console.log(`[OrderBookManager] Subscribing to L2 for ${sym}`);
                this.ws.subscribeToL2Book(sym);
                this.activeSymbols.add(sym);
            }
        }

        // Unsubscribe from old
        for (const sym of this.activeSymbols) {
            if (!newSet.has(sym)) {
                console.log(`[OrderBookManager] Unsubscribing from L2 for ${sym}`);
                this.ws.unsubscribeFromL2Book(sym);
                this.activeSymbols.delete(sym);
                this.books.delete(sym);
            }
        }
    }

    private handleBookUpdate(book: WsBook) {
        // Replace the entire book (it's a snapshot)
        this.books.set(book.coin, book);
    }

    public setDepthBandsPct(bands: string[]) {
        if (!bands || bands.length === 0) return;

        const sanitized = bands
            .map(b => parseFloat(b))
            .filter(v => !isNaN(v) && v > 0)
            .sort((a, b) => a - b);

        if (sanitized.length === 0) return;

        this.depthBandsPct = sanitized.map(v => v.toFixed(2));
        this.depthBandFractions = sanitized.map(v => v / 100);
    }

    public getMetrics(symbol: string): OrderBookMetrics {
        const book = this.books.get(symbol);
        if (!book) {
            return this.getEmptyMetrics();
        }

        return this.calculateMetrics(book);
    }

    private calculateMetrics(book: WsBook): OrderBookMetrics {
        const bids = book.levels[0];
        const asks = book.levels[1];

        if (!bids.length || !asks.length) return this.getEmptyMetrics();

        const bestBid = parseFloat(bids[0].px);
        const bestAsk = parseFloat(asks[0].px);
        const mid = (bestBid + bestAsk) / 2;

        // Spread BPS
        const spreadBps = ((bestAsk - bestBid) / mid) * 10000;

        const depthBandsBid: Record<string, number> = {};
        const depthBandsAsk: Record<string, number> = {};

        const calculateDepth = (levels: WsLevel[], bandFraction: number) => {
            let depth = 0;
            const lower = mid * (1 - bandFraction);
            const upper = mid * (1 + bandFraction);

            const iterator = levels === bids ? bids : asks;
            for (const l of iterator) {
                const px = parseFloat(l.px);
                const sz = parseFloat(l.sz);
                if (levels === bids && px < lower) break;
                if (levels === asks && px > upper) break;
                depth += px * sz;
            }
            return depth;
        };

        this.depthBandsPct.forEach((bandPct, idx) => {
            const fraction = this.depthBandFractions[idx] ?? 0;
            const bidDepth = calculateDepth(bids, fraction);
            const askDepth = calculateDepth(asks, fraction);
            depthBandsBid[bandPct] = bidDepth;
            depthBandsAsk[bandPct] = askDepth;
        });

        const onePctKey = this.depthBandsPct.find(k => parseFloat(k) >= 1) ?? this.depthBandsPct[this.depthBandsPct.length - 1];
        const bidUsd = depthBandsBid[onePctKey] ?? 0;
        const askUsd = depthBandsAsk[onePctKey] ?? 0;

        const denom = bidUsd + askUsd;
        const imbalance = denom > 0 ? (bidUsd - askUsd) / denom : 0;
        const bookPressure = imbalance; // Using imbalance as proxy for pressure

        // Cost BPS (Approximate)
        const takerFeeBps = 3.5;
        const costBps = (2 * takerFeeBps) + spreadBps;

        return {
            spread_bps: spreadBps,
            best_bid: bestBid,
            best_ask: bestAsk,
            mid,
            depth_usd: {
                bid_1pct: bidUsd,
                ask_1pct: askUsd
            },
            imbalance: imbalance, // Ratio -1 to 1? Or 0 to 1? 
            // User code: (bid - ask) / (bid + ask) -> range [-1, 1]
            // If bid > ask, positive (buy pressure). If ask > bid, negative (sell pressure).
            book_pressure: bookPressure,
            cost_bps: costBps,
            depth_bands_usd: { bid: depthBandsBid, ask: depthBandsAsk }
        };
    }

    private getEmptyMetrics(): OrderBookMetrics {
        return {
            spread_bps: 0,
            best_bid: 0,
            best_ask: 0,
            mid: 0,
            depth_usd: { bid_1pct: 0, ask_1pct: 0 },
            imbalance: 0,
            book_pressure: 0,
            cost_bps: 0,
            depth_bands_usd: { bid: {}, ask: {} }
        };
    }
}
