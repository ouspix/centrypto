import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSymbolConfig } from '@/sentiment/config';

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

  return {
    symbol: row.symbol,
    score: row.score,
    change_2h: row.change2h,
    mentions: row.mentions,
    mentions_vs_baseline: row.mentionsVsBaseline,
    disagreement: row.disagreement,
    source_mix: sourceMix,
    tags,
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function GET() {
  const symbols = Object.keys(getSymbolConfig());
  const snapshots = await prisma.symbolSentimentSnapshot.findMany({
    where: { symbol: { in: symbols } },
    orderBy: { updatedAt: 'desc' },
  });

  const latest: Record<string, ReturnType<typeof formatSnapshot>> = {};
  snapshots.forEach((row) => {
    if (!latest[row.symbol]) {
      latest[row.symbol] = formatSnapshot(row as SnapshotRow);
    }
  });

  return NextResponse.json(Object.values(latest));
}
