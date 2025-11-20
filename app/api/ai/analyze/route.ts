import { NextResponse } from 'next/server';
import { OrchestratorService } from '@/services/OrchestratorService';

const orchestrator = new OrchestratorService();

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { coin } = body;

        if (!coin) {
            return NextResponse.json({ error: 'Coin is required' }, { status: 400 });
        }

        // 1. Fetch Sentiment Data
        let sentimentScore = 0;
        try {
            const sentimentResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/cron/sentiment?coin=${coin}`);
            if (sentimentResponse.ok) {
                const sentimentData = await sentimentResponse.json();
                sentimentScore = sentimentData.sentiment_index || 0;
            }
        } catch (error) {
            console.error('Failed to fetch sentiment:', error);
        }

        // 2. Fetch Real-time L2 Book from Hyperliquid
        const hlResponse = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: "l2Book",
                coin: coin
            })
        });

        if (!hlResponse.ok) {
            throw new Error('Failed to fetch market data from Hyperliquid');
        }

        const bookData = await hlResponse.json();
        const levels = bookData.levels || [];

        // Parse levels - Hyperliquid returns [[px, sz], ...]
        const parsedLevels = levels.map((l: any) => {
            if (Array.isArray(l)) {
                return { px: parseFloat(l[0]), sz: parseFloat(l[1]) };
            }
            return { px: parseFloat(l.px), sz: parseFloat(l.sz) };
        });

        parsedLevels.sort((a: any, b: any) => b.px - a.px); // Descending by price

        // Split into bids (lower prices) and asks (higher prices)
        const midIndex = Math.floor(parsedLevels.length / 2);
        const asks = parsedLevels.slice(0, midIndex).map((l: any) => [l.px, l.sz] as [number, number]);
        const bids = parsedLevels.slice(midIndex).map((l: any) => [l.px, l.sz] as [number, number]);

        const midPrice = parsedLevels.length > 0 ? parsedLevels[midIndex]?.px || 0 : 0;

        // Calculate orderbook pressure
        const bidVolume = bids.reduce((sum: number, [_, sz]: [number, number]) => sum + sz, 0);
        const askVolume = asks.reduce((sum: number, [_, sz]: [number, number]) => sum + sz, 0);
        const totalVolume = bidVolume + askVolume;
        const orderbookPressure = totalVolume > 0
            ? (bidVolume > askVolume ? 'Buy Pressure' : askVolume > bidVolume ? 'Sell Pressure' : 'Balanced')
            : 'Unknown';

        const snapshot = {
            coin: coin,
            mid: midPrice,
            bids: bids.slice(0, 5),
            asks: asks.slice(0, 5),
            sentiment: sentimentScore,
            orderbookPressure: orderbookPressure
        };

        // 3. Call Orchestrator (which calls Ollama) with enhanced data
        const decision = await orchestrator.analyzeMarket(snapshot);

        // 4. Add data sources to response
        const enhancedDecision = {
            ...decision,
            dataSources: {
                sentiment: sentimentScore,
                orderbookPressure: orderbookPressure,
                volume: totalVolume * midPrice // Approximate volume in USD
            }
        };

        return NextResponse.json(enhancedDecision);

    } catch (error) {
        console.error('AI Analyze Error:', error);
        return NextResponse.json({
            action: "HOLD",
            confidence: 50,
            reasoning: "Insufficient data to determine market direction due to lack of bid and ask information.",
            dataSources: {
                sentiment: 0,
                orderbookPressure: "Unknown",
                volume: 0
            }
        }, { status: 500 });
    }
}
