import { getLexiconConfig } from './config';

interface ScoreResult {
  score: number;
  confidence: number;
  model?: string;
}

const PYTHON_SERVICE_URL = process.env.SENTIMENT_SERVICE_URL || 'http://localhost:8000';

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s,.!?;:"'()]+/);
}

function clamp(val: number, min: number = -1, max: number = 1): number {
  return Math.min(max, Math.max(min, val));
}

function scoreWithLexicon(text: string, lang: 'en' | 'zh' = 'en', source?: string): ScoreResult {
  const config = getLexiconConfig(lang);
  const tokens = tokenize(text);
  const lowerText = text.toLowerCase();

  let rawScore = 0;
  let hits = 0;

  // 1. Token matching
  const tokenMap = new Map<string, number>();
  [...config.positive, ...config.negative].forEach(entry => tokenMap.set(entry.term, entry.weight));

  if (lang === 'zh') {
    // For Chinese, simple inclusion check since tokenization is hard without a library
    for (const [term, weight] of tokenMap.entries()) {
      if (text.includes(term)) {
        rawScore += weight;
        hits++;
      }
    }
  } else {
    // For English, exact token match
    for (const token of tokens) {
      if (tokenMap.has(token)) {
        rawScore += tokenMap.get(token)!;
        hits++;
      }
    }
  }

  // 2. Phrase matching (Boost/Dampen)
  // Note: config might not have boost_phrases if loading failed or old format, so check existence
  const boosts = config.boost_phrases || [];
  const dampens = config.dampen_phrases || [];

  for (const { phrase, weight } of boosts) {
    if (lowerText.includes(phrase)) {
      rawScore += weight;
      hits++;
    }
  }

  // Dampen phrases usually reduce the score or flip it, here we just add weight (assuming negative weight for dampeners if that's the logic, 
  // or maybe they are multipliers? The type says 'weight', let's assume additive for now based on previous logic)
  for (const { phrase, weight } of dampens) {
    if (lowerText.includes(phrase)) {
      rawScore += weight;
      hits++;
    }
  }

  // 3. Normalization
  const normalized = clamp(rawScore / (config.normalizer || 5.0));

  // 4. Confidence
  // Simple heuristic: more hits = higher confidence
  let confidence = 0.2 + (hits * 0.1);
  confidence = clamp(confidence, 0.1, 0.9);

  return {
    score: normalized,
    confidence,
    model: 'lexicon'
  };
}

export async function scoreMessage(text: string, metadata?: { source?: string; language?: string }): Promise<ScoreResult> {
  try {
    const response = await fetch(`${PYTHON_SERVICE_URL}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        source: metadata?.source || 'unknown'
      })
    });

    if (!response.ok) {
      throw new Error(`Service returned ${response.status}`);
    }

    const data = await response.json();
    return {
      score: data.score,
      confidence: data.confidence,
      model: `python-${data.label}`
    };

  } catch (error) {
    // Only log if it's not a connection refused (common during startup/dev) to avoid spam
    // console.warn(`[Sentiment] Python service failed: ${error}`);

    // Fallback to lexicon
    const lang = (metadata?.language === 'zh') ? 'zh' : 'en';
    const lexiconResult = scoreWithLexicon(text, lang, metadata?.source);
    return {
      ...lexiconResult,
      model: 'lexicon-fallback'
    };
  }
}

// Compatibility wrappers
export async function scoreWithFinbert(text: string): Promise<ScoreResult> {
  return scoreMessage(text, { source: 'news' });
}

export async function scoreWithRoberta(text: string): Promise<ScoreResult> {
  return scoreMessage(text, { source: 'twitter' });
}
