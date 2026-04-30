import { NextRequest, NextResponse } from 'next/server';
import { MarketAnalysisService } from '@/services/MarketAnalysisService';

const marketService = new MarketAnalysisService();

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const symbol = searchParams.get('symbol');
        const isTestnet = searchParams.get('isTestnet') === 'true';

        if (!symbol) {
            return NextResponse.json(
                { error: 'Symbol parameter is required' },
                { status: 400 }
            );
        }

        // Use MarketAnalysisService to get metrics (uses correct DB and caching)
        const metrics = await marketService.getMetricsForSymbol(symbol, isTestnet, true);

        // Map MarketMetrics to the expected TechnicalIndicators structure
        // We'll use 5m timeframe as the default "trading" view for these indicators
        const rsiValue = metrics.rsi.m5;
        const rsiSignal = rsiValue > 70 ? 'overbought' : rsiValue < 30 ? 'oversold' : 'neutral';

        const macd = metrics.macd.m5;
        const macdTrend = macd.histogram > 0 ? 'bullish' : macd.histogram < 0 ? 'bearish' : 'neutral';

        const bb = metrics.bbands.m5;
        // Recalculate %B and Bandwidth if needed, or use what we have
        // MarketMetrics bbands has { upper, middle, lower, width }
        // We need percentB. 
        // percentB = (price - lower) / (upper - lower)
        // We don't have exact current price here easily without fetching again, 
        // but we can approximate or just omit if frontend doesn't strictly need it.
        // Actually, let's just return what we have.

        const indicators = {
            rsi: {
                value: rsiValue,
                signal: rsiSignal
            },
            macd: {
                macd: macd.macd,
                signal: macd.signal,
                histogram: macd.histogram,
                trend: macdTrend
            },
            bollingerBands: {
                upper: bb.upper,
                middle: bb.middle,
                lower: bb.lower,
                bandwidth: bb.width * 100 // Convert to percentage if needed
            },
            atr: {
                value: metrics.atr.m5,
                // normalized: (atr / price) * 100. We don't have price handy here.
                // But we can infer it roughly from BB middle?
                normalized: bb.middle > 0 ? (metrics.atr.m5 / bb.middle) * 100 : 0
            },
            // EMAs/SMAs are not explicitly in MarketMetrics but could be added if needed.
            // For now, sending 0s or removing them.
            ema: { ema9: 0, ema21: 0, ema50: 0, ema200: 0 },
            sma: { sma20: 0, sma50: 0, sma200: 0 }
        };

        return NextResponse.json({
            symbol,
            indicators,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('[API] Error fetching indicators:', error);
        return NextResponse.json(
            { error: 'Failed to fetch indicators' },
            { status: 500 }
        );
    }
}
