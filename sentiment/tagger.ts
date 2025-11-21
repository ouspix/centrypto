const TAG_RULES_EN: { tag: string; patterns: RegExp[] }[] = [
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

const TAG_RULES_ZH: { tag: string; patterns: RegExp[] }[] = [
  { tag: 'hack', patterns: [/黑客|被盗|攻擊|攻击|漏洞|安全事件/] },
  { tag: 'regulation', patterns: [/监管|监管机构|罚款|处罚|合规|禁令|禁止|整改/] },
  { tag: 'listing', patterns: [/上线交易所|上线|上架|新上线/] },
  { tag: 'airdrop', patterns: [/空投|发币|糖果/] },
  { tag: 'pump', patterns: [/拉盘|拉升|暴涨|大涨/] },
  { tag: 'dump', patterns: [/砸盘|抛售|暴跌|大跌/] },
  { tag: 'scam', patterns: [/跑路|骗局|诈骗|庞氏/] },
  { tag: 'outage', patterns: [/宕机|停机|中断|故障/] },
];

export function tagMessage(text: string, language: 'en' | 'zh' = 'en'): string[] {
  if (!text || !text.trim()) return [];
  const lower = text.toLowerCase();
  const tags = new Set<string>();

  const rules = language === 'zh' ? TAG_RULES_ZH : TAG_RULES_EN;

  for (const rule of rules) {
    if (rule.patterns.some((pattern) => pattern.test(lower))) {
      tags.add(rule.tag);
    }
  }

  return Array.from(tags);
}
