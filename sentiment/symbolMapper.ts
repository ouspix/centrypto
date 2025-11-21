import { getSymbolConfig, SymbolConfig } from './config';

type SymbolMatcher = {
  symbol: string;
  patterns: RegExp[];
};

let matchersCache: SymbolMatcher[] | null = null;

function escapeRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatchers(config: SymbolConfig): SymbolMatcher[] {
  return Object.entries(config).map(([symbol, aliases]) => {
    const patterns = aliases.map((alias) => {
      const escaped = escapeRegex(alias);
      const pattern = `(^|[^a-zA-Z0-9])${escaped}([^a-zA-Z0-9]|$)`;
      return new RegExp(pattern, 'i');
    });
    return { symbol, patterns };
  });
}

export function mapTextToSymbols(text: string): string[] {
  if (!text || !text.trim()) return [];
  if (!matchersCache) {
    matchersCache = buildMatchers(getSymbolConfig());
  }

  const hits: string[] = [];
  for (const matcher of matchersCache) {
    const found = matcher.patterns.some((pattern) => pattern.test(text));
    if (found) {
      hits.push(matcher.symbol);
    }
  }
  return Array.from(new Set(hits));
}
