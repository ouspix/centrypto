const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const TRADER_OUTPUT_SCHEMA = object({ decisions: { type: "array", maxItems: 100, items: object({
    scope: { type: "string", enum: ["candidate", "position"] },
    action: { type: "string", enum: ["OPEN_POSITION", "SKIP", "HOLD_POSITION", "REDUCE_POSITION", "CLOSE_POSITION"] },
    candidate_id: { type: ["string", "null"] }, symbol: { type: "string" },
    target_side: { type: "string", enum: ["long", "short", "flat"] },
    target_size_fraction_of_equity: { type: "number", minimum: 0, maximum: 1 },
    playbook: { type: ["string", "null"] }, confidence: { type: "number", minimum: 0, maximum: 1 },
    reason_code: { type: "string", enum: ["momentum_edge", "breakout_edge", "mean_reversion_edge", "liquidity_grab", "discretionary_edge", "position_management", "risk_reduction", "skip"] },
    notes: { type: "string" }
}) } });
export function newsOutputSchema(universe: string[], evidenceIds: string[]) {
    const schema = structuredClone(NEWS_OUTPUT_SCHEMA);
    const signals = schema.properties.signals as { items: { properties: Record<string, unknown> } };
    signals.items.properties.symbols = { type: "array", items: { type: "string", enum: [...new Set(universe)] } };
    signals.items.properties.evidenceIds = { type: "array", minItems: 1, items: { type: "string", enum: evidenceIds } };
    return schema;
}
const nullableText = { type: ["string", "null"] };
export const factsSchema = object({
    subject: object({ name: { type: "string" }, symbol: nullableText, chain: nullableText, contract: nullableText, venue: nullableText }),
    targets: { type: "array", maxItems: 20, items: object({
        relation: { type: "string", enum: ["direct", "indirect", "venue", "collateral", "market", "unresolved"] },
        symbol: nullableText, contract: nullableText, quote: nullableText, instrumentKind: { type: "string", enum: ["asset", "spot", "perp"] }, channel: { type: "string", enum: ["supply", "demand", "cashflow", "settlement", "liquidity", "collateral", "capacity", "rates", "none"] }, mechanism: { type: "string" }
    }) },
    factKey: { type: "string", minLength: 1, maxLength: 240 },
    change: { type: "string", enum: ["announcement", "update", "repeat", "correction", "retraction", "resolution"] },
    impact: { type: "string", enum: ["operational_risk", "catalyst", "scheduled", "background"] },
    deadline: nullableText,
    origins: { type: "array", maxItems: 40, items: object({
        evidenceId: { type: "string" }, origin: { type: "string" }, basis: { type: "string", enum: ["official_notice", "independent_reporting", "relay", "unknown"] }
    }) }
});
export const NEWS_OUTPUT_SCHEMA = object({ summary: { type: "string", maxLength: 3000 }, signals: { type: "array", maxItems: 30, items: object({
    facts: factsSchema, eventKey: { type: "string", maxLength: 200 }, symbols: { type: "array", items: { type: "string" } },
    category: { type: "string" }, summary: { type: "string", maxLength: 2000 },
    direction: { type: "string", enum: ["bullish", "bearish", "mixed", "neutral"] },
    confidence: { type: "number", minimum: 0, maximum: 1 }, materiality: { type: "number", minimum: 0, maximum: 1 },
    horizon: { type: "string", enum: ["short_term", "day_scale"] },
    claimType: { type: "string", enum: ["confirmed_announcement", "reported_claim", "rumor", "opinion"] },
    corroboration: { type: "string" }, contradictions: { type: "array", items: { type: "string" } },
    evidenceIds: { type: "array", minItems: 1, items: { type: "string" } }, expiresAt: { type: "string" }
}) } });
