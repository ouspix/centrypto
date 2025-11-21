import { NextResponse } from 'next/server';
import { getSymbolConfig } from '@/sentiment/config';
import { SentimentService } from '@/services/SentimentService';

export async function GET() {
  const symbols = Object.keys(getSymbolConfig());
  const service = new SentimentService();
  const results = [];
  for (const symbol of symbols) {
    const snap = await service.getSentimentForCoin(symbol);
    results.push({
      symbol: snap.symbol,
      score: snap.score,
      change_2h: snap.change_2h,
      mentions: snap.mentions,
      mentions_vs_baseline: snap.mentions_vs_baseline,
      disagreement: snap.disagreement,
      source_mix: snap.source_mix,
      tags: snap.tags,
      sentiment_confidence: snap.sentiment_confidence ?? (snap.mentions < 10 ? Math.max(0.2, snap.mentions / 10) : 1),
    });
  }
  return NextResponse.json(results);
}
