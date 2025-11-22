import { NextResponse } from 'next/server';
import { ScreenerService } from '@/services/ScreenerService';

const screener = new ScreenerService();

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { isTestnet = true, screeningConfig } = body;

        const symbols = await screener.getScreenedSymbols(isTestnet, [], screeningConfig);

        return NextResponse.json({ symbols });
    } catch (error) {
        console.error('Screener API Error:', error);
        return NextResponse.json({
            error: 'Screening failed',
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
