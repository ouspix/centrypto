import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSymbolConfig } from '@/sentiment/config';
import { type SnapshotRow, formatSnapshot } from '../route';

type Params = {
  params: {
    symbol: string;
  };
};

export async function GET(_req: Request, context: Params) {
  const symbol = context.params.symbol.toUpperCase();
  const symbols = Object.keys(getSymbolConfig());
  if (!symbols.includes(symbol)) {
    return NextResponse.json({ error: 'Unknown symbol' }, { status: 404 });
  }

  const snapshot = await prisma.symbolSentimentSnapshot.findFirst({
    where: { symbol },
    orderBy: { updatedAt: 'desc' },
  });

  if (!snapshot) {
    return NextResponse.json({ error: 'No sentiment data' }, { status: 404 });
  }

  return NextResponse.json(formatSnapshot(snapshot as SnapshotRow));
}
