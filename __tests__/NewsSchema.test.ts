import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { NEWS_OUTPUT_SCHEMA, newsOutputSchema } from "@/lib/llm/schemas";
describe("news inference schema", () => {
    it("constrains the CLI to the frozen asset universe and evidence IDs without changing the shared schema", () => {
        const schema = newsOutputSchema(["BTC", "ETH"], ["evidence-a"]);
        const signals = schema.properties.signals as any;
        expect(signals.items.properties.symbols.items.enum).toEqual(["BTC", "ETH"]);
        expect(signals.items.properties.evidenceIds.items.enum).toEqual(["evidence-a"]);
        expect((NEWS_OUTPUT_SCHEMA.properties.signals as any).items.properties.symbols.items).not.toHaveProperty("enum");
        expect(new Ajv({ strict: true }).compile(schema)({ summary: "No material changes", signals: [] })).toBe(true);
    });
});
