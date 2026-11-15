import Ajv from "ajv";
import type { DeskOrder } from "./execution-types";

export const ALLOCATION_REVIEW_VERSION = "allocation-1";
export const allocationFamilies = ["recovery", "continuation", "reversal", "catalyst", "relative_value", "other"] as const;
export type AllocationReview = {
    version: typeof ALLOCATION_REVIEW_VERSION;
    payoff: {
        continuation: { netReturnBps: number | null; basis: string };
        stagnation: { netReturnBps: number | null; basis: string };
        failure: { netReturnBps: number | null; basis: string };
        costs: string;
        extensionRequired: boolean;
        extensionEvidence: string | null;
        preferenceOverCash: string;
        evidenceIds: string[];
    };
    eventRisk: {
        status: "identified" | "none_identified" | "unavailable";
        events: Array<{ name: string; at: string | null; relevance: string }>;
        action: "enter_as_sized" | "reduce_size" | "exit_before_event" | "wait" | "pass";
        rationale: string;
        maxNotionalUsd: number | null;
        exitBefore: string | null;
        evidenceIds: string[];
    };
    theme: {
        family: typeof allocationFamilies[number];
        driver: string;
        correlatedInstrumentIds: string[];
        jointDownside: string;
        marginalCase: string;
        evidenceIds: string[];
    };
};
const explanation = { type: "string", minLength: 10, maxLength: 900 };
const ids = { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 250 } };
const scenario = { type: "object", additionalProperties: false, required: ["netReturnBps", "basis"], properties: {
    netReturnBps: { type: ["number", "null"], description: "Conditional return after fees, spread/walking and funding over the saved horizon. Null means unmeasured; explain the economically relevant magnitude and uncertainty in basis. Never a forecast or inferred probability." },
    basis: explanation,
} };
export const allocationReviewSchema = { type: "object", additionalProperties: false, required: ["version", "payoff", "eventRisk", "theme"], properties: {
    version: { const: ALLOCATION_REVIEW_VERSION },
    payoff: { type: "object", additionalProperties: false, required: ["continuation", "stagnation", "failure", "costs", "extensionRequired", "extensionEvidence", "preferenceOverCash", "evidenceIds"], properties: {
        continuation: scenario, stagnation: scenario, failure: scenario, costs: explanation,
        extensionRequired: { type: "boolean" }, extensionEvidence: { ...explanation, type: ["string", "null"] },
        preferenceOverCash: { ...explanation, description: "Weigh plausible remaining payoff against stagnation and failure. Small fees, available capacity, rising closes or absence of invalidation alone do not establish an advantage." }, evidenceIds: ids,
    } },
    eventRisk: { type: "object", additionalProperties: false, required: ["status", "events", "action", "rationale", "maxNotionalUsd", "exitBefore", "evidenceIds"], properties: {
        status: { enum: ["identified", "none_identified", "unavailable"] },
        events: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, required: ["name", "at", "relevance"], properties: {
            name: { type: "string", minLength: 1, maxLength: 200 }, at: { type: ["string", "null"] }, relevance: explanation,
        } } },
        action: { enum: ["enter_as_sized", "reduce_size", "exit_before_event", "wait", "pass"] }, rationale: explanation,
        maxNotionalUsd: { type: ["number", "null"], exclusiveMinimum: 0 }, exitBefore: { type: ["string", "null"] }, evidenceIds: ids,
    } },
    theme: { type: "object", additionalProperties: false, required: ["family", "driver", "correlatedInstrumentIds", "jointDownside", "marginalCase", "evidenceIds"], properties: {
        family: { enum: [...allocationFamilies] }, driver: explanation, correlatedInstrumentIds: ids,
        jointDownside: explanation, marginalCase: explanation, evidenceIds: ids,
    } },
} };
const validate = new Ajv({ strict: false }).compile(allocationReviewSchema);
export function validateAllocationReview(value: unknown): asserts value is AllocationReview {
    if (!validate(value)) throw new Error("Complete decisionPlan.allocation: costed payoff, actionable event risk and joint theme assessment are required.");
    const review = value as AllocationReview;
    if (review.payoff.extensionRequired && !review.payoff.extensionEvidence)
        throw new Error("Explain evidence for required extension beyond the observed range, including what remains unmeasured.");
    const event = review.eventRisk;
    if (event.status === "identified" && !event.events.length) throw new Error("Identify the material event and its relevance.");
    if (event.status === "none_identified" && event.events.length) throw new Error("Listed relevant events require identified event-risk status.");
    if (event.action === "reduce_size" && event.maxNotionalUsd === null) throw new Error("Record the event-driven maximum notional for reduced sizing.");
    if (event.action === "exit_before_event" && event.exitBefore === null) throw new Error("Record the event-driven exit deadline.");
    for (const at of [event.exitBefore, ...event.events.map(e => e.at)]) {
        if (at !== null && (!/(Z|[+-]\d\d:\d\d)$/.test(at) || !Number.isFinite(Date.parse(at)))) throw new Error("Event dates must be valid timestamps with a timezone, or null if unknown.");
    }
    if (event.action === "exit_before_event") {
        const dates = event.events.flatMap(e => e.at === null ? [] : [Date.parse(e.at)]);
        if (!dates.length || Date.parse(event.exitBefore!) > Math.min(...dates))
            throw new Error("A pre-event exit must be no later than the identified event time; unknown timing cannot support this action.");
    }
}

/** Require a review matching the ticket, not a model score, win-rate or payoff ratio. */
export function assertAllocationTicket(proposal: any, order: DeskOrder, now = Date.now()) {
    if (!proposal || !["candidate", "active"].includes(proposal.status) || !(Date.parse(proposal.validUntil) > now) ||
        !(Date.parse(proposal.setup?.entryExpiresAt) > now) || proposal.decisionPlan?.action !== "enter")
        throw new Error("A current live entry decision is required; read trade_plan and reassess the proposal.");
    validateAllocationReview(proposal.decisionPlan.allocation);
    const review: AllocationReview = proposal.decisionPlan.allocation;
    const leg = proposal.legs?.find((l: any) => l.instrumentId === order.instrumentId && l.side === order.side);
    if (!leg || proposal.setup.strategyVersion !== order.strategyVersion || proposal.setup.stopPrice !== order.stopPrice ||
        proposal.setup.holdHours !== order.maxHoldHours || proposal.decisionPlan.horizonHours !== order.maxHoldHours ||
        Date.parse(proposal.setup.entryExpiresAt) !== Date.parse(order.entryExpiresAt!) ||
        (proposal.setup.targetPrice ?? null) !== (order.takeProfitPrice ?? null) ||
        (leg.quantity != null && order.quantity > leg.quantity) || leg.entryPrice == null ||
        (order.side === "buy" ? order.limitPrice > leg.entryPrice : order.limitPrice < leg.entryPrice))
        throw new Error("Order differs from the reviewed allocation; revise the exact plan before previewing or submitting.");
    const event = review.eventRisk;
    if (["wait", "pass"].includes(event.action)) throw new Error("The event-risk decision does not authorize an entry.");
    if (event.maxNotionalUsd !== null && order.quantity * order.limitPrice > event.maxNotionalUsd + 1e-8)
        throw new Error("Order exceeds the trader's event-risk notional cap.");
    // Test the latest possible fill, not just this preview time. The local time
    // exit remains fill-relative; this does not invent a blackout or change it.
    if (event.exitBefore !== null && Date.parse(order.entryExpiresAt!) + order.maxHoldHours! * 3600000 > Date.parse(event.exitBefore))
        throw new Error("Entry expiry plus holding window exceeds the chosen event exit deadline; adjust the plan or wait.");
    return { proposalKey: proposal.key, proposalRevision: proposal.revision, reviewedAt: proposal.updatedAt, allocation: review };
}
