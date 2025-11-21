import { describe, expect, it } from 'vitest';
import { scoreMessage } from '../sentiment/scorer';

describe('Sentiment scorer', () => {
  it('scores bullish phrases positively', () => {
    const { score, confidence } = scoreMessage('This looks like a massive rally to the moon for BTC');
    expect(score).toBeGreaterThan(0.4);
    expect(confidence).toBeGreaterThan(0.4);
  });

  it('scores bearish language negatively', () => {
    const { score } = scoreMessage('This project is a rug pull and outright scam');
    expect(score).toBeLessThan(-0.5);
  });

  it('keeps neutral text near zero', () => {
    const { score } = scoreMessage('Building quietly, nothing major happening today');
    expect(Math.abs(score)).toBeLessThan(0.2);
  });
});
