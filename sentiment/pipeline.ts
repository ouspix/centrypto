import Parser from 'rss-parser';
import { TwitterApi, TweetV2 } from 'twitter-api-v2';
import { prisma } from '../lib/db';
import {
  getAggregationConfig,
  getFeedConfig,
  getSymbolConfig,
} from './config';
import { mapTextToSymbols } from './symbolMapper';
import { aggregateMessages } from './aggregation';
import { scoreMessage } from './scorer';
import { tagMessage } from './tagger';

type IngestOptions = {
  symbols?: string[];
};

type ScoreOptions = {
  symbols?: string[];
  batchSize?: number;
};

type AggregateOptions = {
  symbols?: string[];
  windowMinutes?: number;
};

const TWO_HOURS_MS = 120 * 60 * 1000;

export async function ingestTwitter(options: IngestOptions = {}): Promise<number> {
  const bearer = process.env.TWITTER_BEARER_TOKEN;
  if (!bearer) {
    console.warn('Skipping Twitter ingestion: TWITTER_BEARER_TOKEN not set');
    return 0;
  }

  const client = new TwitterApi(bearer);
  const symbolConfig = getSymbolConfig();
  const targets = options.symbols?.length
    ? options.symbols.filter((s) => symbolConfig[s])
    : Object.keys(symbolConfig);

  const aliases = targets.flatMap((sym) => [sym, `$${sym}`, ...(symbolConfig[sym] || [])]);
  const uniqueAliases = Array.from(new Set(aliases));

  let tweets: TweetV2[] = [];
  try {
    tweets = await fetchTweetsForSymbols(client, uniqueAliases);
  } catch (err: any) {
    if (err?.code === 429) {
      console.error('Twitter rate limited, skipping this run', err?.rateLimit);
      return 0;
    }
    console.error('Twitter ingestion failed', err);
    return 0;
  }

  let rows = dedupeMessages(
    tweets.flatMap((tweet) => mapTweetToMessages(tweet)) // mapTextToSymbols decides symbols
  );
  rows = await filterExisting(rows);
  if (!rows.length) return 0;
  const result = await prisma.message.createMany({ data: rows });
  console.log(`Twitter: inserted ${result.count} rows across symbols`);
  return result.count;
}

export async function ingestRss(options: IngestOptions = {}): Promise<number> {
  const feeds = getFeedConfig();
  if (!feeds.length) {
    console.warn('No RSS feeds configured.');
    return 0;
  }

  const allowed = options.symbols?.length ? new Set(options.symbols) : null;
  const parser = new Parser();
  let inserted = 0;

  for (const feed of feeds) {
    try {
      console.log(`[RSS] fetching ${feed.name} (${feed.url})`);
      const result = await parser.parseURL(feed.url);
      let rows = dedupeMessages(
        result.items?.flatMap((item) => toMessages(item as any, feed.name || 'news', allowed)) ?? []
      );
      rows = await filterExisting(rows);
      console.log(`[RSS] parsed ${rows.length} new rows (post-dedupe) for ${feed.name}`);
      if (!rows.length) continue;
      const res = await prisma.message.createMany({
        data: rows,
      });
      inserted += res.count;
      console.log(`[RSS] inserted ${res.count} rows from ${feed.name}`);
    } catch (err) {
      const isForbidden = (err as any)?.statusCode === 403 || /403/i.test(String((err as any)?.message ?? ''));
      const prefix = isForbidden ? '[RSS 403]' : '[RSS error]';
      const msg = isForbidden
        ? `${prefix} ${feed.name} blocked (HTTP 403). Skipping this feed; others continue.`
        : `${prefix} ${feed.name} failed: ${String(err)}`;
      console.warn(msg);
    }
  }
  return inserted;
}

export async function scorePendingMessages(options: ScoreOptions = {}): Promise<number> {
  const batchSize = options.batchSize ?? 200;
  let total = 0;

  while (true) {
    const messages = await prisma.message.findMany({
      where: {
        sentimentScore: null,
        ...(options.symbols?.length ? { symbol: { in: options.symbols } } : {}),
      },
      take: batchSize,
      orderBy: { id: 'asc' },
    });

    if (!messages.length) break;

    const updates = messages.map((message) => {
      const { score, confidence } = scoreMessage(message.text, {
        source: message.source,
      });
      const tags = tagMessage(message.text);
      return prisma.message.update({
        where: { id: message.id },
        data: {
          sentimentScore: score,
          sentimentConf: confidence,
          tagsJson: JSON.stringify(tags),
        },
      });
    });

    await prisma.$transaction(updates);
    total += messages.length;
    console.log(`Scored ${messages.length} messages`);
  }

  return total;
}

export async function aggregateSnapshots(options: AggregateOptions = {}): Promise<number> {
  const config = getAggregationConfig();
  const symbolConfig = getSymbolConfig();
  const targetSymbols = options.symbols?.length
    ? options.symbols.filter((s) => symbolConfig[s])
    : Object.keys(symbolConfig);
  const windowMinutes = options.windowMinutes ?? config.windowMinutes;

  await refreshBaselines(targetSymbols, config.baselineDays);

  let created = 0;
  for (const symbol of targetSymbols) {
    try {
      await buildSnapshot(symbol, windowMinutes, config);
      created += 1;
    } catch (err) {
      console.error(`Aggregation failed for ${symbol}`, err);
    }
  }
  return created;
}

export async function runFullPipeline(symbols?: string[]) {
  await ingestRss({ symbols });
  await ingestTwitter({ symbols });
  await scorePendingMessages({ symbols });
  await aggregateSnapshots({ symbols });
}

async function fetchTweetsForSymbols(client: TwitterApi, aliases: string[]) {
  const query = `${aliases.map((a) => `"${a}"`).join(' OR ')} lang:en -is:retweet`;
  const response = await client.v2.search(query, {
    max_results: 50,
    'tweet.fields': ['created_at', 'public_metrics', 'lang'],
  });
  return response.tweets;
}

function mapTweetToMessages(tweet: TweetV2) {
  const metrics = tweet.public_metrics || {};
  const symbols = mapTextToSymbols(tweet.text || '') || [];
  const ts = tweet.created_at ? new Date(tweet.created_at) : new Date();
  return symbols.map((symbol) => ({
    externalId: tweet.id,
    source: 'twitter',
    symbol,
    text: tweet.text || '',
    ts,
    likeCount: metrics.like_count ?? null,
    retweetCount: metrics.retweet_count ?? null,
    replyCount: metrics.reply_count ?? null,
  }));
}

function toMessages(
  item: {
    guid?: string;
    link?: string;
    title?: string;
    contentSnippet?: string;
    content?: string;
    isoDate?: string;
    pubDate?: string;
  },
  source: string,
  allowedSymbols: Set<string> | null
) {
  const text = `${item.title ?? ''} ${item.contentSnippet ?? item.content ?? ''}`.trim();
  const symbols = mapTextToSymbols(text);
  const filteredSymbols = allowedSymbols
    ? symbols.filter((s) => allowedSymbols.has(s))
    : symbols;
  if (!filteredSymbols.length) return [];
  const externalId = item.guid || item.link || `${source}-${item.title ?? 'untitled'}`;
  const tsString = item.isoDate || item.pubDate;
  const ts = tsString ? new Date(tsString) : new Date();

  return filteredSymbols.map((symbol) => ({
    externalId,
    source,
    symbol,
    text,
    ts,
    likeCount: null,
    retweetCount: null,
    replyCount: null,
  }));
}

function dedupeMessages(
  rows: {
    externalId: string;
    source: string;
    symbol: string;
    text: string;
    ts: Date;
    likeCount: number | null;
    retweetCount: number | null;
    replyCount: number | null;
  }[]
) {
  const map = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.externalId}-${row.source}-${row.symbol}`;
    if (!map.has(key)) {
      map.set(key, row);
    }
  }
  return Array.from(map.values());
}

async function filterExisting(
  rows: {
    externalId: string;
    source: string;
    symbol: string;
    text: string;
    ts: Date;
    likeCount: number | null;
    retweetCount: number | null;
    replyCount: number | null;
  }[]
) {
  if (!rows.length) return rows;
  const sources = Array.from(new Set(rows.map((r) => r.source)));
  const externalIds = Array.from(new Set(rows.map((r) => r.externalId)));

  const existing = await prisma.message.findMany({
    where: {
      source: { in: sources },
      externalId: { in: externalIds },
    },
    select: { externalId: true, source: true, symbol: true },
  });

  const existingKeys = new Set(existing.map((e) => `${e.externalId}-${e.source}-${e.symbol}`));
  return rows.filter((r) => !existingKeys.has(`${r.externalId}-${r.source}-${r.symbol}`));
}

async function refreshBaselines(symbols: string[], baselineDays: number) {
  const since = new Date(Date.now() - baselineDays * 24 * 60 * 60 * 1000);
  for (const symbol of symbols) {
    const count = await prisma.message.count({
      where: {
        symbol,
        ts: { gte: since },
      },
    });
    const avgMentions24h = baselineDays > 0 ? count / baselineDays : 0;
    await prisma.symbolBaseline.upsert({
      where: { symbol },
      update: { avgMentions24h },
      create: { symbol, avgMentions24h },
    });
  }
}

async function buildSnapshot(symbol: string, windowMinutes: number, config: ReturnType<typeof getAggregationConfig>) {
  const now = new Date();
  const primaryWindowStart = new Date(now.getTime() - windowMinutes * 60 * 1000);

  let messages = await prisma.message.findMany({
    where: {
      symbol,
      ts: { gte: primaryWindowStart },
      sentimentScore: { not: null },
    },
    orderBy: { ts: 'desc' },
  });

  // If no recent messages, fall back to a wider window to avoid empty snapshots.
  let effectiveWindow = windowMinutes;
  if (messages.length === 0) {
    const fallbackWindow = Math.max(windowMinutes, 360); // 6h fallback
    const fallbackStart = new Date(now.getTime() - fallbackWindow * 60 * 1000);
    messages = await prisma.message.findMany({
      where: {
        symbol,
        ts: { gte: fallbackStart },
        sentimentScore: { not: null },
      },
      orderBy: { ts: 'desc' },
    });
    effectiveWindow = fallbackWindow;
  }

  const baseline = await prisma.symbolBaseline.findUnique({ where: { symbol } });
  const agg = aggregateMessages(messages, {
    windowMinutes: effectiveWindow,
    avgMentions24h: baseline?.avgMentions24h ?? 0,
    config,
  });

  const previousScore = await getPreviousSnapshotScore(symbol, windowMinutes, now);
  const change2h = previousScore !== null ? agg.score - previousScore : 0;

  await prisma.symbolSentimentSnapshot.create({
    data: {
      symbol,
      windowMinutes: effectiveWindow,
      score: agg.score,
      change2h,
      mentions: agg.mentions,
      mentionsVsBaseline: agg.mentionsVsBaseline,
      disagreement: agg.disagreement,
      sourceMixJson: JSON.stringify(agg.sourceMix),
      tagsJson: JSON.stringify(agg.tags),
      updatedAt: now,
    },
  });

  console.log(
    `Snapshot ${symbol}: score=${agg.score.toFixed(3)} mentions=${agg.mentions} change2h=${change2h.toFixed(3)}`
  );
}

async function getPreviousSnapshotScore(symbol: string, windowMinutes: number, now: Date) {
  const target = new Date(now.getTime() - TWO_HOURS_MS);
  const previous = await prisma.symbolSentimentSnapshot.findFirst({
    where: {
      symbol,
      windowMinutes,
      updatedAt: { lte: target },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return previous?.score ?? null;
}
