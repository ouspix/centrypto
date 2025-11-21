import { NextResponse } from 'next/server';
import { getSymbolConfig } from '@/sentiment/config';
import { SentimentService } from '@/services/SentimentService';

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

  const service = new SentimentService();
  const snapshot = await service.getSentimentForCoin(symbol);

  return NextResponse.json(snapshot);
}
