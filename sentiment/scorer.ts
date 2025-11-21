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

let weightedCache: Partial<Record<'en' | 'zh', WeightedLexicon>> = {};

function buildLexicon(lang: 'en' | 'zh'): WeightedLexicon {
  const lexicon = getLexiconConfig(lang);
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

function getLexicon(lang: 'en' | 'zh'): WeightedLexicon {
  if (!weightedCache[lang]) {
    weightedCache[lang] = buildLexicon(lang);
  }
  return weightedCache[lang];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter(Boolean) ?? [];
}

function clamp(score: number) {
  return Math.max(-1, Math.min(1, score));
}

function detectLanguage(text: string, explicit?: string): 'zh' | 'en' {
  if (explicit === 'zh' || explicit === 'en') return explicit;
  const cjkMatches = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uff9f]/g);
  const cjkRatio = cjkMatches ? cjkMatches.length / Math.max(text.length, 1) : 0;
  return cjkRatio > 0.1 ? 'zh' : 'en';
}

export function scoreMessage(text: string, metadata?: { source?: string; language?: string }): ScoreResult {
  if (!text || !text.trim()) {
    return { score: 0, confidence: 0.1 };
  }

  const lang = detectLanguage(text, metadata?.language);
  const { tokenWeights, phraseWeights, normalizer } = getLexicon(lang);
  const tokens = tokenize(text);

  let rawScore = 0;
  let tokenHits = 0;

  if (lang === 'zh') {
    // For CJK text, do substring matching against lexicon terms.
    for (const [term, weight] of tokenWeights.entries()) {
      if (text.includes(term)) {
        rawScore += weight;
        tokenHits += 1;
      }
    }
  } else {
    for (const token of tokens) {
      const weight = tokenWeights.get(token);
      if (typeof weight === 'number') {
        rawScore += weight;
        tokenHits += 1;
      }
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
