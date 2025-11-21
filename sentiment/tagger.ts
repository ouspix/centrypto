const TAG_RULES: { tag: string; patterns: RegExp[] }[] = [
  { tag: 'etf', patterns: [/etf/i] },
  { tag: 'listing', patterns: [/list(ing)?/i, /listing/i] },
  { tag: 'upgrade', patterns: [/upgrade/i, /fork/i, /hard fork/i] },
  { tag: 'partnership', patterns: [/partnership/i, /partner/i] },
  { tag: 'airdrop', patterns: [/airdrop/i] },
  { tag: 'roadmap', patterns: [/roadmap/i, /milestone/i] },
  { tag: 'ecosystem', patterns: [/ecosystem/i] },
  { tag: 'hack', patterns: [/hack/i, /exploit/i, /breach/i] },
  { tag: 'rug', patterns: [/rug/i, /exit scam/i] },
  { tag: 'scam', patterns: [/scam/i, /fraud/i] },
  { tag: 'lawsuit', patterns: [/lawsuit/i, /sue/i] },
  { tag: 'regulation', patterns: [/regulation/i, /\bsec\b/i, /\bcftc\b/i, /\bdoj\b/i, /ban/i] },
  { tag: 'outage', patterns: [/outage/i, /downtime/i, /halt/i, /offline/i] },
  { tag: 'meme', patterns: [/meme/i] },
  { tag: 'pump', patterns: [/pump/i, /moon/i, /lambo/i] },
  { tag: 'dump', patterns: [/dump/i, /selloff/i] },
];

export function tagMessage(text: string): string[] {
  if (!text || !text.trim()) return [];
  const lower = text.toLowerCase();
  const tags = new Set<string>();

  for (const rule of TAG_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(lower))) {
      tags.add(rule.tag);
    }
  }

  return Array.from(tags);
}
