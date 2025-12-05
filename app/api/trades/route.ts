import { NextRequest, NextResponse } from 'next/server';
import { TradeHistoryService } from '@/services/TradeHistoryService';

const tradeService = new TradeHistoryService();

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const userAddress = searchParams.get('userAddress');
        const analytics = searchParams.get('analytics') === 'true';
        const limit = parseInt(searchParams.get('limit') || '100');
        const range = searchParams.get('range'); // e.g., 24h,3d,7d,1m,1y
        const network = searchParams.get('network');
        const isTestnet = network === 'testnet';

        if (!userAddress) {
            return NextResponse.json(
                { error: 'userAddress parameter is required' },
                { status: 400 }
            );
        }

        if (analytics) {
            const analyticsData = await tradeService.getAnalytics(userAddress, isTestnet);
            return NextResponse.json({ analytics: analyticsData });
        }

        let sinceMs: number | undefined = undefined;
        if (range) {
            const now = Date.now();
            const msMap: Record<string, number> = {
                '24h': 24 * 60 * 60 * 1000,
                '3d': 3 * 24 * 60 * 60 * 1000,
                '7d': 7 * 24 * 60 * 60 * 1000,
                '1m': 30 * 24 * 60 * 60 * 1000,
                '1y': 365 * 24 * 60 * 60 * 1000,
            };
            const windowMs = msMap[range];
            if (windowMs) {
                sinceMs = now - windowMs;
            }
        }

        const trades = await tradeService.getTrades(userAddress, isTestnet, limit, sinceMs);

        return NextResponse.json({ trades });
    } catch (error) {
        console.error('[API] Error fetching trades:', error);
        return NextResponse.json(
            { error: 'Failed to fetch trades' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { symbol, side, entryPrice, size, leverage, userAddress, strategyName } = body;

        if (!symbol || !side || !entryPrice || !size || !userAddress) {
            return NextResponse.json(
                { error: 'Missing required fields' },
                { status: 400 }
            );
        }

        const trade = await tradeService.createTrade({
            symbol,
            side,
            entryPrice,
            size,
            leverage,
            userAddress,
            strategyName
        });

        return NextResponse.json({ trade }, { status: 201 });
    } catch (error) {
        console.error('[API] Error creating trade:', error);
        return NextResponse.json(
            { error: 'Failed to create trade' },
            { status: 500 }
        );
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { tradeId, exitPrice, fees } = body;

        if (!tradeId || !exitPrice) {
            return NextResponse.json(
                { error: 'tradeId and exitPrice are required' },
                { status: 400 }
            );
        }

        const trade = await tradeService.closeTrade({
            tradeId,
            exitPrice,
            fees
        });

        if (!trade) {
            return NextResponse.json(
                { error: 'Trade not found or already closed' },
                { status: 404 }
            );
        }

        return NextResponse.json({ trade });
    } catch (error) {
        console.error('[API] Error closing trade:', error);
        return NextResponse.json(
            { error: 'Failed to close trade' },
            { status: 500 }
        );
    }
}
