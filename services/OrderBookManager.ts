import { HyperliquidWS } from "@/lib/hyperliquid-ws";
import { OrderBookMetrics } from "./MarketAnalysisService";

type WsLevel = { px: string; sz: string; n: number };
type WsBook = { coin: string; levels: [WsLevel[], WsLevel[]]; time: number };

export class OrderBookManager {
    private ws: HyperliquidWS;
    private books: Map<string, WsBook> = new Map();
    private activeSymbols: Set<string> = new Set();

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

    public getMetrics(symbol: string): OrderBookMetrics {
        const book = this.books.get(symbol);
        if (!book) {
            return this.getEmptyMetrics();
        }

        return this.calculateMetrics(book);
    }

    private calculateMetrics(book: WsBook, pct: number = 0.01): OrderBookMetrics {
        const bids = book.levels[0];
        const asks = book.levels[1];

        if (!bids.length || !asks.length) return this.getEmptyMetrics();

        const bestBid = parseFloat(bids[0].px);
        const bestAsk = parseFloat(asks[0].px);
        const mid = (bestBid + bestAsk) / 2;

        // Spread BPS
        const spreadBps = ((bestAsk - bestBid) / mid) * 10000;

        // Depth & Imbalance
        const bidLimit = mid * (1 - pct);
        const askLimit = mid * (1 + pct);

        let bidUsd = 0;
        let askUsd = 0;

        for (const l of bids) {
            const px = parseFloat(l.px);
            const sz = parseFloat(l.sz);
            if (px < bidLimit) break;
            bidUsd += px * sz;
        }

        for (const l of asks) {
            const px = parseFloat(l.px);
            const sz = parseFloat(l.sz);
            if (px > askLimit) break;
            askUsd += px * sz;
        }

        const denom = bidUsd + askUsd;
        const imbalance = denom > 0 ? (bidUsd - askUsd) / denom : 0;
        const bookPressure = imbalance; // Using imbalance as proxy for pressure

        // Cost BPS (Approximate)
        const takerFeeBps = 3.5;
        const costBps = (2 * takerFeeBps) + spreadBps;

        return {
            spread_bps: spreadBps,
            depth_usd: {
                bid_1pct: bidUsd,
                ask_1pct: askUsd
            },
            imbalance: imbalance, // Ratio -1 to 1? Or 0 to 1? 
            // User code: (bid - ask) / (bid + ask) -> range [-1, 1]
            // If bid > ask, positive (buy pressure). If ask > bid, negative (sell pressure).
            book_pressure: bookPressure,
            cost_bps: costBps,
            depth_bands_usd: { bid: {}, ask: {} }
        };
    }

    private getEmptyMetrics(): OrderBookMetrics {
        return {
            spread_bps: 0,
            depth_usd: { bid_1pct: 0, ask_1pct: 0 },
            imbalance: 0,
            book_pressure: 0,
            cost_bps: 0,
            depth_bands_usd: { bid: {}, ask: {} }
        };
    }
}
