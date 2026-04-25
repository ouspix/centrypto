/**
 * LLM Response Parser — handles JSON extraction, repair, and normalization
 * of LLM outputs into structured TradeDecision arrays.
 *
 * Extracted from OrchestratorService to isolate parsing concerns.
 */

import { TradeDecision } from "@/types/trading";

/**
 * Extract a JSON string from raw LLM output.
 * Handles code blocks, bare JSON, and truncated responses.
 */
export function extractJson(rawOutput: string): string {
    let jsonStr = rawOutput.trim();

    // 1. Try to find JSON in code blocks
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
        return codeBlockMatch[1].trim();
    }

    // 2. If no code blocks, try to find the first '{' or '['
    const firstBrace = jsonStr.indexOf('{');
    const firstBracket = jsonStr.indexOf('[');

    if (firstBrace === -1 && firstBracket === -1) {
        throw new Error("No JSON object or array found in response");
    }

    const start = (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket))
        ? firstBrace
        : firstBracket;

    const end = jsonStr.lastIndexOf((start === firstBrace) ? '}' : ']');

    if (end !== -1) {
        jsonStr = jsonStr.substring(start, end + 1);
    }

    return jsonStr;
}

/**
 * Attempt to parse JSON, falling back to repair logic for truncated responses.
 */
export function parseJsonWithRepair(jsonStr: string): any {
    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        console.warn("⚠️ Initial JSON parse failed, attempting to repair truncated JSON...");
        try {
            let repaired = jsonStr.trim();

            // Remove trailing comma if present
            if (repaired.endsWith(',')) {
                repaired = repaired.slice(0, -1);
            }

            // Balance braces/brackets
            const stack: string[] = [];
            let inString = false;
            let escape = false;

            for (let i = 0; i < repaired.length; i++) {
                const char = repaired[i];
                if (escape) {
                    escape = false;
                    continue;
                }
                if (char === '\\') {
                    escape = true;
                    continue;
                }
                if (char === '"') {
                    inString = !inString;
                    continue;
                }
                if (!inString) {
                    if (char === '{' || char === '[') {
                        stack.push(char);
                    } else if (char === '}' || char === ']') {
                        stack.pop();
                    }
                }
            }

            // Close open string
            if (inString) {
                repaired += '"';
            }

            // Close open structures
            while (stack.length > 0) {
                const open = stack.pop();
                if (open === '{') repaired += '}';
                if (open === '[') repaired += ']';
            }

            console.log("🔧 Repaired JSON (last 50 chars):", repaired.substring(repaired.length - 50));
            const parsed = JSON.parse(repaired);
            console.log("✅ JSON repaired successfully");
            return parsed;

        } catch (repairError) {
            console.error("❌ JSON Repair Failed:", repairError);
            console.error("Original JSON Error:", e);
            throw new Error(`Failed to parse JSON (even after repair): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

/**
 * Normalize a parsed LLM response into a flat array of decision-like objects.
 * Handles multiple response shapes: direct array, `{decisions: [...]}`, single object, etc.
 */
export function normalizeDecisionArray(parsed: any): any[] {
    if (Array.isArray(parsed)) {
        // Case 1: Direct array of decisions
        return parsed;
    }

    if (parsed.decisions && Array.isArray(parsed.decisions)) {
        // Case 2: Standard format { decisions: [...] }
        return parsed.decisions;
    }

    if (parsed.symbol && parsed.action) {
        // Case 3: Single decision object
        return [parsed];
    }

    // Case 4: Maybe wrapped in another key? Try to find an array value
    const arrayValue = Object.values(parsed).find(v => Array.isArray(v));
    if (arrayValue) {
        return arrayValue as any[];
    }

    // Case 5: DeepSeek-R1 reasoning tokens — check if all keys start with "/"
    const keys = Object.keys(parsed);
    const allKeysAreMetadata = keys.length > 0 && keys.every(k => k.startsWith('/'));

    if (allKeysAreMetadata) {
        console.error("⚠️ DeepSeek-R1 returned only reasoning/metadata tokens. The model may not be following the JSON schema.");
        console.error("Parsed object:", JSON.stringify(parsed, null, 2));
        throw new Error("DeepSeek-R1 returned reasoning tokens instead of decisions. Try a different model or adjust the prompt.");
    }

    console.error("Parsed object keys:", keys);
    console.error("Parsed object:", JSON.stringify(parsed, null, 2));
    throw new Error(`Invalid response structure: could not find decisions array. Found keys: ${keys.join(', ')}`);
}

/**
 * Validate and convert raw decision objects into typed TradeDecision array.
 * Filters out DO_NOTHING, invalid symbols, and invalid actions.
 */
export function validateDecisions(decisionsArray: any[]): TradeDecision[] {
    const validActions = ["OPEN_POSITION", "INCREASE_POSITION", "REDUCE_POSITION", "CLOSE_POSITION", "HOLD_POSITION", "HOLD"];
    const decisions: TradeDecision[] = [];

    for (const d of decisionsArray) {
        // 1. Filter out DO_NOTHING
        if (d.action === "DO_NOTHING") continue;

        // 2. Filter out invalid symbols (N/A, null, empty)
        if (!d.symbol || d.symbol === "N/A" || d.symbol === "null") continue;

        // 3. Validate Action
        if (!validActions.includes(d.action)) {
            console.warn(`⚠️ Skipping invalid action: ${d.action} for ${d.symbol}`);
            continue;
        }

        const sizeHint = d.size_hint ?? d.sizeHint;
        const notes = d.notes || (sizeHint ? `size_hint:${sizeHint}` : "");

        decisions.push({
            action: d.action,
            symbol: d.symbol,
            side: d.side ?? null,
            size_fraction_of_equity: null,
            target_side: d.target_side ?? d.side ?? null,
            target_size_fraction_of_equity: null,
            risk_plan: null,
            playbook: d.playbook || "none",
            confidence: d.confidence ?? 0.5,
            reason_code: d.reason_code || "unknown",
            notes,
            audit: d.audit
        });
    }

    return decisions;
}

/**
 * Full pipeline: extract JSON → parse with repair → normalize → validate.
 */
export function parseLlmResponse(rawOutput: string): TradeDecision[] {
    const jsonStr = extractJson(rawOutput);
    const parsed = parseJsonWithRepair(jsonStr);
    const normalized = normalizeDecisionArray(parsed);
    return validateDecisions(normalized);
}
