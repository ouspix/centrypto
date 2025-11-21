import fs from 'fs';
import path from 'path';

export type SymbolConfig = Record<string, string[]>;

export type FeedConfig = {
  name: string;
  url: string;
}[];

export type LexiconEntry = {
  term: string;
  weight: number;
};

export type PhraseWeight = {
  phrase: string;
  weight: number;
};

export type LexiconConfig = {
  positive: LexiconEntry[];
  negative: LexiconEntry[];
  boost_phrases: PhraseWeight[];
  dampen_phrases: PhraseWeight[];
  normalizer: number;
};

export type AggregationConfig = {
  windowMinutes: number;
  baselineDays: number;
  maxStdForDisagreement: number;
  sourceWeights: Record<string, number>;
};

const rootDir = process.cwd();

const defaults = {
  symbols: {
    BTC: ['bitcoin', 'btc', 'BTC'],
    ETH: ['ethereum', 'eth', 'ETH'],
    SOL: ['solana', 'sol', 'SOL'],
    ARB: ['arbitrum', 'arb', 'ARB'],
  } satisfies SymbolConfig,
  lexicon: {
    positive: [
      { term: 'bullish', weight: 1.0 },
      { term: 'undervalued', weight: 0.8 },
      { term: 'strong', weight: 0.6 },
      { term: 'moon', weight: 0.9 },
      { term: 'pump', weight: 0.7 },
      { term: 'breakout', weight: 0.8 },
      { term: 'rally', weight: 0.7 },
      { term: 'surge', weight: 0.7 },
      { term: 'support', weight: 0.4 },
      { term: 'uptrend', weight: 0.6 },
    ],
    negative: [
      { term: 'bearish', weight: -1.0 },
      { term: 'overvalued', weight: -0.8 },
      { term: 'weak', weight: -0.6 },
      { term: 'dump', weight: -0.9 },
      { term: 'crash', weight: -1.0 },
      { term: 'rug', weight: -1.0 },
      { term: 'scam', weight: -0.9 },
      { term: 'lawsuit', weight: -0.7 },
      { term: 'ban', weight: -0.7 },
      { term: 'outage', weight: -0.6 },
      { term: 'halt', weight: -0.6 },
    ],
    boost_phrases: [
      { phrase: 'to the moon', weight: 1.0 },
      { phrase: 'massive rally', weight: 0.9 },
      { phrase: 'price discovery', weight: 0.8 },
    ],
    dampen_phrases: [
      { phrase: 'going to zero', weight: -1.0 },
      { phrase: 'rug pull', weight: -1.0 },
      { phrase: 'sell the news', weight: -0.6 },
    ],
    normalizer: 3.0,
  } satisfies LexiconConfig,
  aggregation: {
    windowMinutes: 120,
    baselineDays: 30,
    maxStdForDisagreement: 0.7,
    sourceWeights: {
      news: 1.2,
      twitter: 1.0,
    },
  } satisfies AggregationConfig,
};

let symbolCache: SymbolConfig | null = null;
let lexiconCache: LexiconConfig | null = null;
let feedsCache: FeedConfig | null = null;
let aggregationConfigCache: AggregationConfig | null = null;

function loadJsonFile<T>(filename: string): T {
  const target = path.join(rootDir, 'config', filename);
  const raw = fs.readFileSync(target, 'utf-8');
  return JSON.parse(raw) as T;
}

export function getSymbolConfig(): SymbolConfig {
  if (!symbolCache) {
    try {
      symbolCache = loadJsonFile<SymbolConfig>('symbols.json');
    } catch (err) {
      console.warn('Falling back to default symbol config', err);
      symbolCache = defaults.symbols;
    }
  }
  return symbolCache;
}

export function getFeedConfig(): FeedConfig {
  if (!feedsCache) {
    try {
      feedsCache = loadJsonFile<FeedConfig>('feeds.json');
    } catch (err) {
      console.warn('Falling back to empty feed config', err);
      feedsCache = [];
    }
  }
  return feedsCache;
}

export function getLexiconConfig(): LexiconConfig {
  if (!lexiconCache) {
    try {
      lexiconCache = loadJsonFile<LexiconConfig>('lexicon.json');
    } catch (err) {
      console.warn('Falling back to default lexicon config', err);
      lexiconCache = defaults.lexicon;
    }
  }
  return lexiconCache;
}

export function getAggregationConfig(): AggregationConfig {
  if (!aggregationConfigCache) {
    try {
      aggregationConfigCache = loadJsonFile<AggregationConfig>('aggregation.json');
    } catch (err) {
      console.warn('Falling back to default aggregation config', err);
      aggregationConfigCache = defaults.aggregation;
    }
  }
  return aggregationConfigCache;
}
