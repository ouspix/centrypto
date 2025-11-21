import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSymbolConfig } from '@/sentiment/config';
import { SentimentService } from '@/services/SentimentService';

export type SnapshotRow = {
  symbol: string;
  score: number;
  change2h: number;
  mentions: number;
  mentionsVsBaseline: number;
  disagreement: number;
  sourceMixJson: string;
  tagsJson: string;
  updatedAt: Date;
};

export function formatSnapshot(row: SnapshotRow) {
  let sourceMix: Record<string, number> = {};
  let tags: string[] = [];

  try {
    sourceMix = row.sourceMixJson ? JSON.parse(row.sourceMixJson) : {};
  } catch {
    sourceMix = {};
  }
  try {
    tags = row.tagsJson ? JSON.parse(row.tagsJson) : [];
  } catch {
    tags = [];
  }

  const sentimentConfidence = row.mentions < 10 ? Math.max(0.2, row.mentions / 10) : 1;

  return {
    symbol: row.symbol,
    score: row.score,
    change_2h: row.change2h,
    mentions: row.mentions,
    mentions_vs_baseline: row.mentionsVsBaseline,
    disagreement: row.disagreement,
    source_mix: sourceMix,
    tags,
    sentiment_confidence: parseFloat(sentimentConfidence.toFixed(3)),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function GET() {
  const symbols = Object.keys(getSymbolConfig());
  const service = new SentimentService();
  const results = [];
  // Refresh per symbol using the service (will ingest/score/aggregate if stale)
  for (const symbol of symbols) {
    const snapshot = await service.getSentimentForCoin(symbol);
    results.push(snapshot);
  }
  return NextResponse.json(results);
}
