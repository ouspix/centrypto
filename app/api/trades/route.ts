import { NextRequest, NextResponse } from 'next/server';
import { requireWalletSession, WalletSessionError, normalizeWalletAddress } from '@/lib/auth/wallet-session';
import { TradeHistoryService } from '@/services/TradeHistoryService';

const tradeService = new TradeHistoryService();

export async function GET(request: NextRequest) {
    try {
        const session = requireWalletSession(request);
        const { searchParams } = new URL(request.url);
        const requestedUserAddress = searchParams.get('userAddress');
        const analytics = searchParams.get('analytics') === 'true';
        const limit = parseInt(searchParams.get('limit') || '100');
        const range = searchParams.get('range'); // e.g., 24h,3d,7d,1m,1y
        const network = searchParams.get('network');
        const isTestnet = network === 'testnet';

        if (requestedUserAddress && normalizeWalletAddress(requestedUserAddress) !== session.address) {
            return NextResponse.json({ error: 'userAddress does not match wallet session' }, { status: 403 });
        }

        if (analytics) {
            const analyticsData = await tradeService.getAnalytics(session.address, isTestnet);
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

        const trades = await tradeService.getTrades(session.address, isTestnet, limit, sinceMs);

        return NextResponse.json({ trades });
    } catch (error) {
        if (error instanceof WalletSessionError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('[API] Error fetching trades:', error);
        return NextResponse.json(
            { error: 'Failed to fetch trades' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const session = requireWalletSession(request);
        const body = await request.json();
        const { symbol, side, entryPrice, size, leverage, userAddress, strategyName } = body;

        if (userAddress && normalizeWalletAddress(userAddress) !== session.address) {
            return NextResponse.json({ error: 'userAddress does not match wallet session' }, { status: 403 });
        }

        if (!symbol || !side || !entryPrice || !size) {
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
            userAddress: session.address,
            strategyName
        });

        return NextResponse.json({ trade }, { status: 201 });
    } catch (error) {
        if (error instanceof WalletSessionError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('[API] Error creating trade:', error);
        return NextResponse.json(
            { error: 'Failed to create trade' },
            { status: 500 }
        );
    }
}

export async function PATCH(request: NextRequest) {
    try {
        requireWalletSession(request);
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
        if (error instanceof WalletSessionError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('[API] Error closing trade:', error);
        return NextResponse.json(
            { error: 'Failed to close trade' },
            { status: 500 }
        );
    }
}
