import { NextResponse } from 'next/server';
import { SentimentService, SentimentPayload } from '@/services/SentimentService';

const sentimentService = new SentimentService();

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const coin = searchParams.get('coin') || 'CRYPTO';
        const snapshot = await sentimentService.getSentimentForCoin(coin);
        return NextResponse.json(snapshot);
    } catch (error) {
        console.error('Sentiment Cron Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json() as SentimentPayload;
        const snapshot = sentimentService.analyzePayload(body);
        return NextResponse.json(snapshot);
    } catch (error) {
        console.error('Sentiment Cron Error:', error);
        return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }
}
