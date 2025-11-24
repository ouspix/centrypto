import fs from 'fs';
import path from 'path';

export type SymbolConfig = Record<string, string[]>;

export type FeedConfig = {
  name: string;
  url: string;
  sourceKey?: string;
  language?: string;
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
    BNB: ['binance', 'bnb', 'BNB'],
    DOGE: ['dogecoin', 'doge', 'DOGE'],
    AVAX: ['avalanche', 'avax', 'AVAX'],
    AAVE: ['aave', 'AAVE'],
    MATIC: ['polygon', 'matic', 'MATIC'],
    LINK: ['chainlink', 'link', 'LINK'],
    UNI: ['uniswap', 'uni', 'UNI'],
    XRP: ['ripple', 'xrp', 'XRP'],
    ADA: ['cardano', 'ada', 'ADA'],
    DOT: ['polkadot', 'dot', 'DOT'],
    ATOM: ['cosmos', 'atom', 'ATOM'],
    LTC: ['litecoin', 'ltc', 'LTC'],
    // Add more as needed - unknown symbols will gracefully fall back to neutral sentiment
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
      reddit: 0.8,
      telegram: 1.1,
    },
  } satisfies AggregationConfig,
};

let symbolCache: SymbolConfig | null = null;
let lexiconCache: Record<string, LexiconConfig> = {};
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
    // Append Extra feeds (RSSHub + official RSS)
    const rsshubBase = process.env.RSSHUB_BASE || 'https://rsshub.app';
    const extraFeeds: FeedConfig = [
      // --- Chinese Feeds ---
      {
        name: 'cn_jinse_all',
        url: `${rsshubBase}/jinse/lives`,
        sourceKey: 'cn_jinse',
        language: 'zh',
      },
      {
        name: 'cn_jinse_policy',
        url: `${rsshubBase}/jinse/lives/2`,
        sourceKey: 'cn_jinse_policy',
        language: 'zh',
      },
      {
        name: 'cn_odaily_newsflash',
        url: 'https://rss.odaily.news/rss/newsflash',
        sourceKey: 'cn_odaily_newsflash',
        language: 'zh',
      },
      {
        name: 'cn_odaily_articles',
        url: 'https://rss.odaily.news/rss/post',
        sourceKey: 'cn_odaily_article',
        language: 'zh',
      },
      {
        name: 'cn_blockbeats_newsflash',
        url: 'https://api.theblockbeats.news/v2/rss/newsflash',
        sourceKey: 'cn_blockbeats_flash',
        language: 'zh',
      },
      {
        name: 'cn_blockbeats_article',
        url: 'https://api.theblockbeats.news/v2/rss/article',
        sourceKey: 'cn_blockbeats_article',
        language: 'zh',
      },
      // --- Social / Community Feeds (RSSHub) ---
      // NOTE: Disabled due to RSSHub rate limits and Twitter API restrictions
      // Reddit, Twitter, and Telegram feeds are unreliable via RSSHub
      // {
      //   name: 'reddit_cryptocurrency',
      //   url: `${rsshubBase}/reddit/subreddit/cryptocurrency`,
      //   sourceKey: 'reddit',
      //   language: 'en',
      // },
      // {
      //   name: 'reddit_solana',
      //   url: `${rsshubBase}/reddit/subreddit/solana`,
      //   sourceKey: 'reddit',
      //   language: 'en',
      // },
      // {
      //   name: 'reddit_defi',
      //   url: `${rsshubBase}/reddit/subreddit/defi`,
      //   sourceKey: 'reddit',
      //   language: 'en',
      // },
      // {
      //   name: 'twitter_bitcoin',
      //   url: `${rsshubBase}/twitter/user/Bitcoin`,
      //   sourceKey: 'twitter',
      //   language: 'en',
      // },
      // {
      //   name: 'twitter_ethereum',
      //   url: `${rsshubBase}/twitter/user/ethereum`,
      //   sourceKey: 'twitter',
      //   language: 'en',
      // },
      // {
      //   name: 'twitter_solana',
      //   url: `${rsshubBase}/twitter/user/solana`,
      //   sourceKey: 'twitter',
      //   language: 'en',
      // },
      // {
      //   name: 'telegram_coindesk',
      //   url: `${rsshubBase}/telegram/channel/coindesk_news`,
      //   sourceKey: 'telegram',
      //   language: 'en',
      // }
    ];
    feedsCache = [...feedsCache, ...extraFeeds];
  }
  return feedsCache;
}

export function getLexiconConfig(lang: 'en' | 'zh' = 'en'): LexiconConfig {
  if (!lexiconCache[lang]) {
    try {
      lexiconCache[lang] = loadJsonFile<LexiconConfig>(lang === 'zh' ? 'lexicon_zh.json' : 'lexicon.json');
    } catch (err) {
      console.warn(`Falling back to default ${lang} lexicon config`, err);
      lexiconCache[lang] = defaults.lexicon;
    }
  }
  return lexiconCache[lang];
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
