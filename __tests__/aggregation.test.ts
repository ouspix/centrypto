import { describe, expect, it } from 'vitest';
import { aggregateMessages } from '../sentiment/aggregation';
import { getAggregationConfig } from '../sentiment/config';

describe('Aggregation', () => {
  it('computes weighted score, baseline, and tag rollups', () => {
    const config = getAggregationConfig();
    const now = new Date();
    const messages = [
      {
        symbol: 'BTC',
        source: 'twitter',
        sentimentScore: 0.8,
        ts: now,
        likeCount: 10,
        retweetCount: 2,
        replyCount: 1,
        tagsJson: JSON.stringify(['etf', 'pump']),
      },
      {
        symbol: 'BTC',
        source: 'news',
        sentimentScore: -0.2,
        ts: now,
        likeCount: 0,
        tagsJson: JSON.stringify(['regulation']),
      },
      {
        symbol: 'BTC',
        source: 'twitter',
        sentimentScore: 0.1,
        ts: now,
        replyCount: 5,
      },
    ];

    const result = aggregateMessages(messages, {
      windowMinutes: 120,
      avgMentions24h: 24,
      config,
    });

    expect(result.mentions).toBe(3);
    expect(result.mentionsVsBaseline).toBeCloseTo(0.6, 1);
    expect(result.score).toBeGreaterThan(0); // net bullish
    expect(result.disagreement).toBeGreaterThan(0);
    expect(result.sourceMix.twitter).toBeCloseTo(0.667, 2);
    expect(result.tags).toContain('etf');
    expect(result.tags.length).toBeGreaterThan(0);
  });
});
