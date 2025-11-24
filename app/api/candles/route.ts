import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const symbol = searchParams.get('symbol');
        const interval = searchParams.get('interval') || '1h';
        // Kept for signature parity; data comes from DB only
        const _isTestnet = searchParams.get('isTestnet') === 'true';

        if (!symbol) {
            return NextResponse.json({ error: 'Symbol is required' }, { status: 400 });
        }

        // 1. Determine lookback based on interval
        let lookbackMs = 0;
        switch (interval) {
            case '1m': lookbackMs = 6 * 60 * 60 * 1000; break;
            case '15m': lookbackMs = 7 * 24 * 60 * 60 * 1000; break;
            case '1h': lookbackMs = 30 * 24 * 60 * 60 * 1000; break;
            case '4h': lookbackMs = 90 * 24 * 60 * 60 * 1000; break;
            case '1d': lookbackMs = 365 * 24 * 60 * 60 * 1000; break;
            default: lookbackMs = 24 * 60 * 60 * 1000;
        }

        const startTime = Date.now() - lookbackMs;

        // 2. Always fetch 1m candles from DB for the required range
        // We use 1m data as the source of truth for all aggregations
        let dbCandles = await prisma.candle.findMany({
            where: {
                symbol,
                interval: "1m",
                t: { gte: startTime }
            },
            orderBy: { t: 'asc' }
        });

        // 3. Aggregate candles if needed (DB only; ingestion happens in standalone script)
        let resultCandles = [];

        if (interval === '1m') {
            resultCandles = dbCandles.map(c => ({
                time: Number(c.t) / 1000,
                open: c.o,
                high: c.h,
                low: c.l,
                close: c.c,
                volume: c.v
            }));
        } else {
            // Aggregate 1m candles into target interval
            const intervalMs = getIntervalMs(interval);
            resultCandles = aggregateCandles(dbCandles, intervalMs);
        }

        return NextResponse.json(resultCandles);

    } catch (error) {
        console.error('[API] Error in candles route:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

function aggregateCandles(candles: any[], intervalMs: number) {
    if (candles.length === 0) return [];

    const aggregated = [];
    let currentBucketStartTime = Math.floor(Number(candles[0].t) / intervalMs) * intervalMs;
    let currentBucket = {
        open: candles[0].o,
        high: candles[0].h,
        low: candles[0].l,
        close: candles[0].c,
        volume: candles[0].v,
        startTime: currentBucketStartTime
    };

    for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const time = Number(c.t);

        if (time < currentBucketStartTime + intervalMs) {
            // Still in the same bucket
            currentBucket.high = Math.max(currentBucket.high, c.h);
            currentBucket.low = Math.min(currentBucket.low, c.l);
            currentBucket.close = c.c; // Close is always the last one
            currentBucket.volume += c.v;
        } else {
            // New bucket
            aggregated.push({
                time: currentBucket.startTime / 1000,
                open: currentBucket.open,
                high: currentBucket.high,
                low: currentBucket.low,
                close: currentBucket.close,
                volume: currentBucket.volume
            });

            currentBucketStartTime = Math.floor(time / intervalMs) * intervalMs;
            currentBucket = {
                open: c.o,
                high: c.h,
                low: c.l,
                close: c.c,
                volume: c.v,
                startTime: currentBucketStartTime
            };
        }
    }

    // Push the last bucket
    aggregated.push({
        time: currentBucket.startTime / 1000,
        open: currentBucket.open,
        high: currentBucket.high,
        low: currentBucket.low,
        close: currentBucket.close,
        volume: currentBucket.volume
    });

    return aggregated;
}

function getIntervalMs(interval: string): number {
    const num = parseInt(interval);
    if (interval.endsWith('m')) return num * 60 * 1000;
    if (interval.endsWith('h')) return num * 60 * 60 * 1000;
    if (interval.endsWith('d')) return num * 24 * 60 * 60 * 1000;
    return 60 * 1000;
}
