import { prisma } from "@/lib/db";

type Candle = {
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
};

export type TechnicalIndicators = {
    rsi: {
        value: number;
        signal: 'overbought' | 'oversold' | 'neutral';
    };
    macd: {
        macd: number;
        signal: number;
        histogram: number;
        trend: 'bullish' | 'bearish' | 'neutral';
    };
    bollingerBands: {
        upper: number;
        middle: number;
        lower: number;
        percentB: number; // Price position within bands (0-1)
        bandwidth: number; // Band width as % of middle
    };
    ema: {
        ema9: number;
        ema21: number;
        ema50: number;
        ema200: number;
    };
    sma: {
        sma20: number;
        sma50: number;
        sma200: number;
    };
    atr: {
        value: number;
        normalized: number; // ATR as % of price
    };
};

export class TechnicalIndicatorsService {
    /**
     * Calculate RSI (Relative Strength Index)
     * @param closes Array of closing prices
     * @param period RSI period (default 14)
     */
    private calculateRSI(closes: number[], period: number = 14): number {
        if (closes.length < period + 1) return 50; // Neutral if not enough data

        const changes: number[] = [];
        for (let i = 1; i < closes.length; i++) {
            changes.push(closes[i] - closes[i - 1]);
        }

        // Initial average gain/loss
        let avgGain = 0;
        let avgLoss = 0;

        for (let i = 0; i < period; i++) {
            if (changes[i] > 0) avgGain += changes[i];
            else avgLoss += Math.abs(changes[i]);
        }

        avgGain /= period;
        avgLoss /= period;

        // Smoothed RSI calculation
        for (let i = period; i < changes.length; i++) {
            const change = changes[i];
            avgGain = ((avgGain * (period - 1)) + (change > 0 ? change : 0)) / period;
            avgLoss = ((avgLoss * (period - 1)) + (change < 0 ? Math.abs(change) : 0)) / period;
        }

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    /**
     * Calculate EMA (Exponential Moving Average)
     */
    private calculateEMA(prices: number[], period: number): number {
        if (prices.length < period) return prices[prices.length - 1] || 0;

        const multiplier = 2 / (period + 1);
        let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

        for (let i = period; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    /**
     * Calculate SMA (Simple Moving Average)
     */
    private calculateSMA(prices: number[], period: number): number {
        if (prices.length < period) return prices[prices.length - 1] || 0;

        const slice = prices.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }

    /**
     * Calculate MACD (Moving Average Convergence Divergence)
     */
    private calculateMACD(closes: number[]): { macd: number; signal: number; histogram: number } {
        if (closes.length < 26) {
            return { macd: 0, signal: 0, histogram: 0 };
        }

        // Calculate MACD line (12-period EMA - 26-period EMA)
        const ema12 = this.calculateEMA(closes, 12);
        const ema26 = this.calculateEMA(closes, 26);
        const macdLine = ema12 - ema26;

        // Calculate signal line (9-period EMA of MACD)
        // For simplicity, we'll calculate MACD values for recent periods
        const macdValues: number[] = [];
        for (let i = 26; i <= closes.length; i++) {
            const slice = closes.slice(0, i);
            const e12 = this.calculateEMA(slice, 12);
            const e26 = this.calculateEMA(slice, 26);
            macdValues.push(e12 - e26);
        }

        const signalLine = this.calculateEMA(macdValues, 9);
        const histogram = macdLine - signalLine;

        return {
            macd: macdLine,
            signal: signalLine,
            histogram: histogram
        };
    }

    /**
     * Calculate Bollinger Bands
     */
    private calculateBollingerBands(closes: number[], period: number = 20, stdDev: number = 2): {
        upper: number;
        middle: number;
        lower: number;
        percentB: number;
        bandwidth: number;
    } {
        if (closes.length < period) {
            const current = closes[closes.length - 1] || 0;
            return { upper: current, middle: current, lower: current, percentB: 0.5, bandwidth: 0 };
        }

        const sma = this.calculateSMA(closes, period);
        const slice = closes.slice(-period);

        // Calculate standard deviation
        const variance = slice.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
        const std = Math.sqrt(variance);

        const upper = sma + (stdDev * std);
        const lower = sma - (stdDev * std);
        const current = closes[closes.length - 1];

        // %B: Where price is within the bands (0 = lower band, 1 = upper band)
        const percentB = (upper - lower) !== 0 ? (current - lower) / (upper - lower) : 0.5;

        // Bandwidth: Width of bands as % of middle band
        const bandwidth = sma !== 0 ? ((upper - lower) / sma) * 100 : 0;

        return {
            upper,
            middle: sma,
            lower,
            percentB,
            bandwidth
        };
    }

    /**
     * Calculate ATR (Average True Range)
     */
    private calculateATR(candles: Candle[], period: number = 14): number {
        if (candles.length < period + 1) return 0;

        const trueRanges: number[] = [];

        for (let i = 1; i < candles.length; i++) {
            const high = parseFloat(candles[i].h);
            const low = parseFloat(candles[i].l);
            const prevClose = parseFloat(candles[i - 1].c);

            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            trueRanges.push(tr);
        }

        // Calculate ATR using EMA
        return this.calculateEMA(trueRanges, period);
    }

    /**
     * Get all technical indicators for a symbol
     */
    public async getIndicators(symbol: string, isTestnet: boolean): Promise<TechnicalIndicators> {
        // Fetch candles from database (we need enough history for 200-period SMA)
        const lookbackWindow = Date.now() - (30 * 24 * 60 * 60 * 1000); // 30 days
        const dbCandles = await prisma.candle.findMany({
            where: {
                symbol,
                interval: "1m",
                t: { gte: lookbackWindow }
            },
            orderBy: { t: 'asc' }
        });

        // If not enough data in DB, fetch from API
        let candles: Candle[] = dbCandles.map(c => ({
            t: Number(c.t),
            o: c.o.toString(),
            h: c.h.toString(),
            l: c.l.toString(),
            c: c.c.toString(),
            v: c.v.toString()
        }));

        if (candles.length === 0) {
            // Return neutral indicators when cache is empty; ingestion is handled separately.
            return this.getNeutralIndicators();
        }

        const closes = candles.map(c => parseFloat(c.c));
        const currentPrice = closes[closes.length - 1];

        // Calculate all indicators
        const rsiValue = this.calculateRSI(closes);
        const macdData = this.calculateMACD(closes);
        const bbData = this.calculateBollingerBands(closes);
        const atrValue = this.calculateATR(candles);

        // EMAs
        const ema9 = this.calculateEMA(closes, 9);
        const ema21 = this.calculateEMA(closes, 21);
        const ema50 = this.calculateEMA(closes, 50);
        const ema200 = this.calculateEMA(closes, 200);

        // SMAs
        const sma20 = this.calculateSMA(closes, 20);
        const sma50 = this.calculateSMA(closes, 50);
        const sma200 = this.calculateSMA(closes, 200);

        // Determine signals
        const rsiSignal = rsiValue > 70 ? 'overbought' : rsiValue < 30 ? 'oversold' : 'neutral';
        const macdTrend = macdData.histogram > 0 ? 'bullish' : macdData.histogram < 0 ? 'bearish' : 'neutral';

        return {
            rsi: {
                value: rsiValue,
                signal: rsiSignal
            },
            macd: {
                macd: macdData.macd,
                signal: macdData.signal,
                histogram: macdData.histogram,
                trend: macdTrend
            },
            bollingerBands: {
                upper: bbData.upper,
                middle: bbData.middle,
                lower: bbData.lower,
                percentB: bbData.percentB,
                bandwidth: bbData.bandwidth
            },
            ema: {
                ema9,
                ema21,
                ema50,
                ema200
            },
            sma: {
                sma20,
                sma50,
                sma200
            },
            atr: {
                value: atrValue,
                normalized: currentPrice !== 0 ? (atrValue / currentPrice) * 100 : 0
            }
        };
    }

    private getNeutralIndicators(): TechnicalIndicators {
        return {
            rsi: { value: 50, signal: 'neutral' },
            macd: { macd: 0, signal: 0, histogram: 0, trend: 'neutral' },
            bollingerBands: { upper: 0, middle: 0, lower: 0, percentB: 0.5, bandwidth: 0 },
            ema: { ema9: 0, ema21: 0, ema50: 0, ema200: 0 },
            sma: { sma20: 0, sma50: 0, sma200: 0 },
            atr: { value: 0, normalized: 0 }
        };
    }
}
