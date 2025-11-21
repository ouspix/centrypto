import { AggregationConfig } from './config';

export type AggregateMessage = {
  sentimentScore: number | null;
  ts: Date;
  source: string;
  symbol: string;
  likeCount?: number | null;
  retweetCount?: number | null;
  replyCount?: number | null;
  tagsJson?: string | null;
};

export type AggregationOptions = {
  windowMinutes: number;
  avgMentions24h: number;
  config: AggregationConfig;
};

export type AggregationResult = {
  score: number;
  mentions: number;
  mentionsVsBaseline: number;
  disagreement: number;
  sourceMix: Record<string, number>;
  tags: string[];
};

const MAX_TAGS = 5;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function engagementWeight(message: AggregateMessage) {
  const engagement = (message.likeCount ?? 0) + (message.retweetCount ?? 0) + (message.replyCount ?? 0);
  return 1 + Math.log1p(engagement);
}

function sourceWeight(source: string, weights: Record<string, number>) {
  const base = weights[source] ?? 1;
  // Down-weight long-form articles relative to flashes/tweets
  if (source.includes('article')) return base * 0.5;
  return base;
}

export function aggregateMessages(messages: AggregateMessage[], options: AggregationOptions): AggregationResult {
  const scored = messages.filter((m) => typeof m.sentimentScore === 'number') as Required<
    Pick<AggregateMessage, 'sentimentScore' | 'ts' | 'source' | 'likeCount' | 'retweetCount' | 'replyCount' | 'tagsJson'> & {
      symbol: string;
    }
  >[];

  const mentions = scored.length;
  const expected = options.avgMentions24h > 0 ? (options.avgMentions24h * options.windowMinutes) / 1440 : 0;
  const expectedClamped = Math.max(expected, 5); // prevent explosive ratios when history is sparse
  const mentionsVsBaseline = mentions / expectedClamped;

  let weightedSum = 0;
  let totalWeight = 0;
  const scores: number[] = [];
  const sourceCounts: Record<string, number> = {};

  const normalizeSource = (s: string) => {
    if (s.startsWith('cn_')) return 'cn_news';
    if (s.startsWith('en_')) return 'en_news';
    if (s.includes('news')) return 'en_news';
    return s;
  };

  for (const msg of scored) {
    const weight = engagementWeight(msg) * sourceWeight(msg.source, options.config.sourceWeights);
    weightedSum += msg.sentimentScore * weight;
    totalWeight += weight;
    scores.push(msg.sentimentScore);
    const key = normalizeSource(msg.source);
    sourceCounts[key] = (sourceCounts[key] || 0) + 1;
  }

  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;

  const variance =
    scores.length > 0 ? scores.reduce((sum, s) => sum + Math.pow(s - score, 2), 0) / scores.length : 0;
  const stdDev = Math.sqrt(variance);
  const disagreement = clamp01(stdDev / options.config.maxStdForDisagreement);

  const sourceMix: Record<string, number> = {};
  if (mentions > 0) {
    for (const [key, count] of Object.entries(sourceCounts)) {
      sourceMix[key] = parseFloat((count / mentions).toFixed(3));
    }
  }

  const tags = collectTags(scored);

  return {
    score,
    mentions,
    mentionsVsBaseline,
    disagreement,
    sourceMix,
    tags,
  };
}

function collectTags(messages: AggregateMessage[]): string[] {
  const tagCounts: Record<string, number> = {};
  for (const msg of messages) {
    if (!msg.tagsJson) continue;
    try {
      const tags = JSON.parse(msg.tagsJson) as string[];
      tags.forEach((tag) => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    } catch {
      // ignore bad tags payloads
    }
  }

  return Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TAGS)
    .map(([tag]) => tag);
}
