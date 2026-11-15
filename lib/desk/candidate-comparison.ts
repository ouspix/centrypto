import { portfolioChoiceSchema, reviewPortfolioChoice, type PortfolioChoice, type PriceFacts } from "./portfolio-choice";
type Candidate = { instrumentId: string; symbol?: string };
export function comparisonSlate(lanes: Array<{ family: string; candidates: Candidate[] }>, shortlist: Candidate[]) {
    const selected: Array<Candidate & { nominatedFrom: string }> = [];
    const add = (c: Candidate, source: string) => {
        if (selected.length < 3 && !selected.some(x => x.instrumentId === c.instrumentId)) selected.push({ ...c, nominatedFrom: source });
    };
    for (const lane of lanes) {
        const candidate = lane.candidates.find(c => !selected.some(x => x.instrumentId === c.instrumentId));
        if (candidate) add(candidate, lane.family);
    }
    for (const candidate of shortlist) add(candidate, "remaining_shortlist");
    return { candidates: selected, instruction: "Starting slate, not a ranking or entry signal. Compare about three distinct promising candidates with horizon-relevant evidence. Replace a nomination when another case is stronger. Different lanes are hypotheses, not independent signals. Record the comparison, including cash, with record_candidate_comparison; distinguish investigated cases from screen-only exclusions. Fewer credible candidates or urgent exposure work justify a narrower review with an explicit coverageReason. No trade quota." };
}
const text = { type: "string", minLength: 10, maxLength: 800 };
export const candidateComparisonSchema = {
    type: "object", additionalProperties: false,
    required: ["candidates", "preferredInstrumentId", "relativeReason", "coverageReason"],
    properties: {
        portfolioChoice: portfolioChoiceSchema,
        candidates: { type: "array", minItems: 0, maxItems: 4, items: {
            type: "object", additionalProperties: false,
            required: ["instrumentId", "mechanism", "stage", "evidenceIds", "support", "objection", "disposition", "nextStep"],
            properties: {
                instrumentId: { type: "string", minLength: 1 }, mechanism: text,
                stage: { type: "string", enum: ["investigated", "screen_only"] },
                evidenceIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1 } },
                support: text, objection: text,
                disposition: { type: "string", enum: ["enter", "wait", "research", "pass", "defer"] }, nextStep: text,
            },
        } },
        preferredInstrumentId: { type: ["string", "null"] }, relativeReason: text,
        coverageReason: { type: ["string", "null"], minLength: 10, maxLength: 800 },
    },
};
export type CandidateComparison = {
    portfolioChoice?: PortfolioChoice;
    candidates: Array<{ instrumentId: string; mechanism: string; stage: "investigated" | "screen_only"; evidenceIds: string[];
        support: string; objection: string; disposition: string; nextStep: string }>;
    preferredInstrumentId: string | null; relativeReason: string; coverageReason: string | null;
};
export function reviewCandidateComparison(input: CandidateComparison, facts?: PriceFacts) {
    const ids = input.candidates.map(c => c.instrumentId);
    if (new Set(ids).size !== ids.length) throw new Error("Compare distinct instruments; do not count multiple scenarios for one token as different candidates.");
    if (input.preferredInstrumentId !== null && !ids.includes(input.preferredInstrumentId)) throw new Error("Preferred instrument must be in this comparison; null means no new candidate selected, not liquidation of existing holdings.");
    if (input.portfolioChoice) reviewPortfolioChoice(input.portfolioChoice, facts);
    const investigated = input.candidates.filter(c => c.stage === "investigated").length;
    if (investigated < 3 && !input.coverageReason?.trim()) throw new Error("State coverageReason for a narrower investigation. Screen-only names do not count as investigated. Fewer candidates is allowed; no trade is required.");
    return { investigated, screenedOnly: ids.length - investigated, coverage: investigated >= 3 ? "compared" : "limited_with_reason",
        instruction: "Recorded model assessment, not verified alpha or entry permission. Repeated passes can be correct; compare the specific evidence and assumptions, not wording diversity. Persist any concrete research or watch commitment through its own tool." };
}
