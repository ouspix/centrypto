import { describe, expect, it } from 'vitest';
import { mapTextToSymbols } from '../sentiment/symbolMapper';

describe('SymbolMapper', () => {
  it('detects symbols with aliases and casing', () => {
    const symbols = mapTextToSymbols('Big move incoming for bitcoin and ETH soon');
    expect(symbols).toContain('BTC');
    expect(symbols).toContain('ETH');
  });

  it('detects cashtags and avoids partial matches', () => {
    const symbols = mapTextToSymbols('Watching $SOL but not sold on solidarity');
    expect(symbols).toContain('SOL');
    expect(symbols).not.toContain('BTC');
  });

  it('returns empty for unrelated text', () => {
    const symbols = mapTextToSymbols('macro news without coins');
    expect(symbols).toEqual([]);
  });
});
