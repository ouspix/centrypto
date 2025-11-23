import { NextRequest, NextResponse } from 'next/server';
import { TechnicalIndicatorsService } from '@/services/TechnicalIndicatorsService';

const indicatorsService = new TechnicalIndicatorsService();

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

        const indicators = await indicatorsService.getIndicators(symbol, isTestnet);

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
