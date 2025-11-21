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
  return weights[source] ?? 1;
}

export function aggregateMessages(messages: AggregateMessage[], options: AggregationOptions): AggregationResult {
  const scored = messages.filter((m) => typeof m.sentimentScore === 'number') as Required<
    Pick<AggregateMessage, 'sentimentScore' | 'ts' | 'source' | 'likeCount' | 'retweetCount' | 'replyCount' | 'tagsJson'> & {
      symbol: string;
    }
  >[];

  const mentions = scored.length;
  const expected = options.avgMentions24h > 0 ? (options.avgMentions24h * options.windowMinutes) / 1440 : 0;
  const mentionsVsBaseline = expected > 0 ? mentions / expected : 1;

  let weightedSum = 0;
  let totalWeight = 0;
  const scores: number[] = [];
  const sourceCounts: Record<string, number> = {};

  for (const msg of scored) {
    const weight = engagementWeight(msg) * sourceWeight(msg.source, options.config.sourceWeights);
    weightedSum += msg.sentimentScore * weight;
    totalWeight += weight;
    scores.push(msg.sentimentScore);
    sourceCounts[msg.source] = (sourceCounts[msg.source] || 0) + 1;
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
