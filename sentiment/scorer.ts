import { getLexiconConfig } from './config';

export type ScoreResult = {
  score: number;
  confidence: number;
};

type WeightedLexicon = {
  tokenWeights: Map<string, number>;
  phraseWeights: { phrase: string; weight: number }[];
  normalizer: number;
};

let weightedCache: WeightedLexicon | null = null;

function buildLexicon(): WeightedLexicon {
  const lexicon = getLexiconConfig();
  const tokenWeights = new Map<string, number>();
  lexicon.positive.forEach((item) => tokenWeights.set(item.term.toLowerCase(), item.weight));
  lexicon.negative.forEach((item) => tokenWeights.set(item.term.toLowerCase(), item.weight));

  return {
    tokenWeights,
    phraseWeights: [...lexicon.boost_phrases, ...lexicon.dampen_phrases].map((entry) => ({
      phrase: entry.phrase.toLowerCase(),
      weight: entry.weight,
    })),
    normalizer: lexicon.normalizer || 3,
  };
}

function getLexicon(): WeightedLexicon {
  if (!weightedCache) {
    weightedCache = buildLexicon();
  }
  return weightedCache;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter(Boolean) ?? [];
}

function clamp(score: number) {
  return Math.max(-1, Math.min(1, score));
}

export function scoreMessage(text: string, metadata?: { source?: string }): ScoreResult {
  if (!text || !text.trim()) {
    return { score: 0, confidence: 0.1 };
  }

  const { tokenWeights, phraseWeights, normalizer } = getLexicon();
  const tokens = tokenize(text);

  let rawScore = 0;
  let tokenHits = 0;

  for (const token of tokens) {
    const weight = tokenWeights.get(token);
    if (typeof weight === 'number') {
      rawScore += weight;
      tokenHits += 1;
    }
  }

  let phraseHits = 0;
  const lower = text.toLowerCase();
  for (const entry of phraseWeights) {
    if (lower.includes(entry.phrase)) {
      rawScore += entry.weight;
      phraseHits += 1;
    }
  }

  // Slightly penalize neutral/no-hit texts from noisy sources.
  if (tokenHits === 0 && !phraseHits && metadata?.source === 'twitter') {
    rawScore *= 0.8;
  }

  const normalized = clamp(rawScore / normalizer);
  const confidenceBase = tokenHits > 0 ? 0.4 + tokenHits * 0.15 + phraseHits * 0.1 : 0.2 + phraseHits * 0.1;
  const confidence = Math.min(1, Math.max(0.05, confidenceBase));

  return { score: normalized, confidence: parseFloat(confidence.toFixed(3)) };
}
