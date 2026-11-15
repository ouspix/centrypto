import { retireProposalWatches } from "./watch-state";
import { entryDecisionSchema, validateEntryDecisionChange, type EntryDecision } from "./entry-decision";
import { validateAllocationReview } from "./allocation-review";
import { EXECUTABLE_STRATEGIES } from "./decision-policy";
import { parseDeskMandate, type DeskMandate } from "./mandate";
import Ajv from "ajv";
import type { DeskBook, DeskShift, Prisma, PrismaClient } from "@prisma/client";
import type { DeskConsultation } from "./roundtable";
import { record } from "./books";
import { consumeResearchReviews } from "./backtest/delivery";
import { journalTransaction } from "./journal";
import { listInstruments } from "./instruments";
import type { DeskRole, RoleNote } from "./roles";

export const researchMethods = [
    "screen_markets",
    "swing_context",
    "strategy_profile",
    "allocation_context",
    "news_strategy_context",
    "setup_outcomes",
    "size_swing_trade",
    "technical_analysis",
    "market_regime",
    "market_structure",
    "sentiment_snapshot",
    "historical_move_study",
    "opportunity_diagnostics",
    "backtest_catalog",
    "backtest_strategy",
    "retry_backtest",
    "backtest_status",
    "research_backlog",
    "research_landscape", "entry_filter_comparison",
    "start_prospective_test",
    "prospective_tests",
    "find_instruments",
    "order_book",
    "market_history",
    "funding_and_basis",
    "funding_history",
    "account_exposure",
    "desk_blotter",
    "transaction_cost",
    "price_since_event",
    "news_history",
    "search_news",
    "read_evidence",
    "outcomes",
    "public_research_topics",
    "search_public_sources",
    "read_public_source",
    "assess_trade_scenarios",
    "assess_portfolio_choices",
    "preview_order",
] as const;
export type ResearchTask = {
    id: string;
    gap: string;
    owner: Exclude<DeskRole, "lead">;
    question: string;
    nextTool: string;
    completionCriteria: string;
    status: "ready" | "review" | "waiting_external" | "resolved" | "abandoned";
    result: string;
    evidenceIds: string[];
    assessedRevision?: number;
    methodUsed?: boolean;
};

export type ProposalDraft = {
    key: string;
    expectedRevision: number;
    status: "researching" | "candidate" | "parked" | "closed";
    thesis: string;
    horizon: string;
    invalidation: string;
    missingEvidence: string[];
    evidenceIds: string[];
    legs: {
        instrumentId: string;
        side: "buy" | "sell";
        quantity: number | null;
        entryPrice: number | null;
    }[];
    economics: string;
    validUntil: string;
    researchPlan: ResearchTask[];
    decisionPlan?: EntryDecision;
    setup?: {strategyVersion:typeof EXECUTABLE_STRATEGIES[number];entryCondition:string;stopPrice:number;targetPrice:number|null;holdHours:number;riskBudgetUsd:number;entryExpiresAt:string;backtestRunIds:string[]};
};
export type TradeProposal = Omit<ProposalDraft, "expectedRevision"> & {
    revision: number;
    updatedBy: DeskRole;
    updatedAt: string;
    sourceShiftId: string;
};
const text = { type: "string", minLength: 1, maxLength: 1200 };
export const proposalSchema = {
    type: "object",
    additionalProperties: false,
    required: [
        "key",
        "expectedRevision",
        "status",
        "thesis",
        "horizon",
        "invalidation",
        "missingEvidence",
        "evidenceIds",
        "legs",
        "economics",
        "validUntil",
        "researchPlan",
    ],
    properties: {
        decisionPlan: entryDecisionSchema,
        key: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,79}$" },
        expectedRevision: { type: "integer", minimum: 0 },
        status: {
            type: "string",
            enum: ["researching", "candidate", "parked", "closed"],
        },
        setup:{type:"object",additionalProperties:false,required:["strategyVersion","entryCondition","stopPrice","targetPrice","holdHours","riskBudgetUsd","entryExpiresAt","backtestRunIds"],properties:{
            strategyVersion:{type:"string",enum:[...EXECUTABLE_STRATEGIES]},entryCondition:text,stopPrice:{type:"number",exclusiveMinimum:0},targetPrice:{type:["number","null"],exclusiveMinimum:0},holdHours:{type:"number",minimum:2,maximum:48},riskBudgetUsd:{type:"number",exclusiveMinimum:0,description:"Active proposals must fit the current book mandate maxRiskPerTradeUsd; checked when saving. Historical closed proposals grant no permission."},entryExpiresAt:{type:"string"},backtestRunIds:{type:"array",maxItems:8,items:{type:"string",maxLength:150}}
        }},
        thesis: text,
        horizon: { ...text, maxLength: 300 },
        invalidation: text,
        economics: text,
        missingEvidence: {
            type: "array",
            maxItems: 6,
            items: { ...text, maxLength: 300 },
        },
        evidenceIds: {
            type: "array",
            maxItems: 12,
            items: { type: "string", maxLength: 250 },
        },
        validUntil: { type: "string" },
        researchPlan: {
            type: "array",
            maxItems: 6,
            items: {
                type: "object",
                additionalProperties: false,
                required: [
                    "id",
                    "gap",
                    "owner",
                    "question",
                    "nextTool",
                    "completionCriteria",
                    "status",
                    "result",
                    "evidenceIds",
                ],
                properties: {
                    id: {
                        type: "string",
                        pattern: "^[a-z0-9][a-z0-9_-]{0,39}$",
                    },
                    gap: { ...text, maxLength: 300 },
                    owner: {
                        type: "string",
                        enum: ["catalyst", "derivatives", "execution", "risk"],
                    },
                    question: { ...text, maxLength: 300 },
                    nextTool: { type: "string", enum: researchMethods },
                    completionCriteria: {
                        ...text,
                        minLength: 10,
                        maxLength: 300,
                    },
                    status: {
                        type: "string",
                        enum: [
                            "ready",
                            "review",
                            "waiting_external",
                            "resolved",
                            "abandoned",
                        ],
                    },
                    result: { type: "string", maxLength: 1200 },
                    evidenceIds: {
                        type: "array",
                        maxItems: 12,
                        items: { type: "string", maxLength: 250 },
                    },
                    assessedRevision: { type: "integer", minimum: 1 },
                    methodUsed: { type: "boolean" },
                },
            },
        },
        legs: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
                type: "object",
                additionalProperties: false,
                required: ["instrumentId", "side", "quantity", "entryPrice"],
                properties: {
                    instrumentId: {
                        type: "string",
                        minLength: 1,
                        maxLength: 150,
                    },
                    side: { type: "string", enum: ["buy", "sell"] },
                    quantity: { type: ["number", "null"], exclusiveMinimum: 0 },
                    entryPrice: {
                        type: ["number", "null"],
                        exclusiveMinimum: 0,
                    },
                },
            },
        },
    },
};
const validate = new Ajv().compile(proposalSchema);
export function validateProposal(
    value: unknown,
    role: DeskRole,
    mandate?: DeskMandate,
): asserts value is ProposalDraft {
    if (!validate(value))
        throw new Error(
            "Invalid trade proposal. Supply a complete draft and its expected revision.",
        );
    const p = value as ProposalDraft;
    if (p.decisionPlan?.allocation) validateAllocationReview(p.decisionPlan.allocation);
    if (mandate && p.status !== "closed" && p.setup && p.setup.riskBudgetUsd > mandate.maxRiskPerTradeUsd)
        throw new Error(`Proposal risk budget exceeds current book mandate (${mandate.maxRiskPerTradeUsd} USD per trade).`);
    if (p.decisionPlan && p.setup && p.decisionPlan.horizonHours !== p.setup.holdHours)
        throw new Error("Decision horizon and executable setup holdHours must agree.");
    if (p.status !== "closed" && p.decisionPlan?.action === "research" &&
        !p.researchPlan.some(task => ["ready", "review", "waiting_external"].includes(task.status)))
        throw new Error("A research decision needs a concrete unresolved researchPlan task.");
    if(p.setup && (!Number.isFinite(Date.parse(p.setup.entryExpiresAt)) || (p.status!=="closed" && Date.parse(p.setup.entryExpiresAt)<=Date.now()) || Date.parse(p.setup.entryExpiresAt)>Date.parse(p.validUntil)))throw new Error("Setup entry expiry must be future and within proposal validity");
    if (
        !/(Z|[+-]\d\d:\d\d)$/.test(p.validUntil) ||
        !Number.isFinite(Date.parse(p.validUntil)) ||
        (p.status !== "closed" && Date.parse(p.validUntil) <= Date.now()) ||
        Date.parse(p.validUntil) > Date.now() + 90 * 86400000
    )
        throw new Error(
            "Proposal validity must include a timezone and fall within the next 90 days.",
        );
    if (role !== "lead" && (p.status === "parked" || p.status === "closed"))
        throw new Error("Only the lead can park or close a proposal.");
    if (new Set(p.legs.map((l) => l.instrumentId)).size !== p.legs.length)
        throw new Error("Combine duplicate instrument legs.");
    if (new Set(p.researchPlan.map((t) => t.id)).size !== p.researchPlan.length)
        throw new Error(
            "Research task IDs must be unique within the proposal.",
        );
    if (
        p.status !== "closed" &&
        p.missingEvidence.some(
            (gap) =>
                !p.researchPlan.some(
                    (t) =>
                        t.gap === gap &&
                        !["resolved", "abandoned"].includes(t.status),
                ),
        )
    )
        throw new Error(
            "Assign every missing evidence item an owner, concrete question, next tool and completion condition.",
        );
    if (
        p.researchPlan.some(
            (t) =>
                ["waiting_external", "resolved", "abandoned"].includes(
                    t.status,
                ) && t.result.trim().length < 10,
        )
    )
        throw new Error(
            "Record findings or the specific external dependency before resolving, abandoning or deferring research.",
        );
}

export function researchQuestion(p: TradeProposal, t: ResearchTask) {
    return `[Research task ${p.key}/${t.id}] ${t.question} Use ${t.nextTool} to investigate. Completion condition: ${t.completionCriteria}. Report observed results, evidence and remaining gaps; do not invent assumptions or treat missing data as a negative edge.`;
}
export function reviewedResearchDraft(
    p: TradeProposal,
    id: string,
    note: RoleNote,
    methods: string[],
): ProposalDraft {
    const {
        revision,
        updatedBy: _by,
        updatedAt: _at,
        sourceShiftId: _shift,
        ...draft
    } = p;
    return {
        ...draft,
        expectedRevision: revision,
        researchPlan: (p.researchPlan ?? []).map((t) =>
            t.id === id
                ? {
                      ...t,
                      status: "review",
                      assessedRevision: revision,
                      methodUsed: methods.includes(t.nextTool),
                      result: [note.summary, note.thesis, note.dissent]
                          .filter(Boolean)
                          .join(" ")
                          .slice(0, 1200),
                      evidenceIds: note.evidenceIds.slice(0, 12),
                  }
                : t,
        ),
    };
}
const scope = (book: DeskBook, mode: string) =>
    `proposal:${book.version}:${mode}:`;
export type ProposalReview = DeskConsultation & {
    sourceShiftId: string;
    reviewedAt: string;
};
export async function recordProposalReview(
    tx: Prisma.TransactionClient,
    book: DeskBook,
    shift: DeskShift,
    entry: DeskConsultation,
    consultationKey: string,
) {
    if (!entry.proposalKey) return;
    const key =
        scope(book, shift.mode) +
        entry.proposalKey +
        ":review:" +
        consultationKey;
    await record(
        tx,
        book.id,
        shift.id,
        key,
        "proposal_review",
        entry.colleague,
        {
            ...entry,
            sourceShiftId: shift.id,
            reviewedAt: new Date().toISOString(),
        } satisfies ProposalReview,
    );
}
export async function loadTradeProposalReviews(
    db: PrismaClient,
    book: DeskBook,
    shift: DeskShift,
    proposals: TradeProposal[],
) {
    if (!proposals.length) return [];
    const rows = await db.deskRecord.findMany({
        where: {
            bookId: book.id,
            kind: "proposal_review",
            shiftId: { not: shift.id },
            OR: proposals.map((p) => ({
                key: {
                    startsWith: scope(book, shift.mode) + p.key + ":review:",
                },
            })),
        },
        orderBy: { id: "desc" },
        take: 6,
    });
    return rows.map((r) => JSON.parse(r.dataJson) as ProposalReview);
}
export async function loadTradeProposals(
    db: PrismaClient,
    book: DeskBook,
    shift: DeskShift,
) {
    const found: TradeProposal[] = [];
    let cursor: number | undefined;
    do {
        const rows = await db.deskRecord.findMany({
            where: {
                bookId: book.id,
                kind: "trade_proposal",
                key: { startsWith: scope(book, shift.mode) },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 24,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const row of rows) {
            const p = JSON.parse(row.dataJson) as TradeProposal;
            if (
                Date.parse(p.validUntil) > Date.now() &&
                (p.status !== "closed" || p.sourceShiftId === shift.id)
            )
                found.push({ ...p, researchPlan: p.researchPlan ?? [] });
        }
        if (rows.length < 24) break;
        cursor = rows.at(-1)!.id;
    } while (found.length < 16);
    return found.slice(0, 16);
}
export async function saveTradeProposal(
    db: PrismaClient,
    book: DeskBook,
    shift: DeskShift,
    role: DeskRole,
    draft: ProposalDraft,
    signal: AbortSignal,
): Promise<TradeProposal> {
    validateProposal(draft, role, parseDeskMandate(book.mandateJson));
    const key = scope(book, shift.mode) + draft.key;
    const observed=await db.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key}}});
    const observedProposal=observed?JSON.parse(observed.dataJson) as TradeProposal:null;
    if(!observedProposal&&shift.mode==="research"&&draft.expectedRevision!==0)
        throw new Error("This read-only research board has no such revision. Live proposal revisions belong to the live lead. Record completed findings with resolve_research_idea; do not copy a live revision into this board.");
    if(!observedProposal||JSON.stringify(observedProposal.legs)!==JSON.stringify(draft.legs)){
        const items=await listInstruments(book.isTestnet,draft.legs.every(l=>l.instrumentId.includes(":perp:"))?"perp":"all");
        if(draft.legs.some(l=>!items.some(i=>i.id===l.instrumentId)))throw new Error("Resolve each leg to an instrument on this book's network first.");
    }
    return journalTransaction(db, book, shift, signal, async (tx) => {
        const existing = await tx.deskRecord.findUnique({
            where: { bookId_key: { bookId: book.id, key } },
        });
        const prior =
            existing && (JSON.parse(existing.dataJson) as TradeProposal | null);
        if ((prior?.revision ?? 0) !== draft.expectedRevision) {
            // Replaying an identical acknowledged/uncertain journal write is harmless.
            if (
                prior &&
                Object.keys(draft)
                    .filter((k) => k !== "expectedRevision")
                    .every(
                        (k) =>
                            JSON.stringify(prior[k as keyof TradeProposal]) ===
                            JSON.stringify(draft[k as keyof ProposalDraft]),
                    )
            )
                return prior;
            throw new Error(
                "Proposal revision changed. Read the shared board before updating.",
            );
        }
        validateEntryDecisionChange(prior?.decisionPlan, draft.decisionPlan);
        const { expectedRevision, ...fields } = draft;
        const proposal: TradeProposal = {
            ...fields,
            ...(prior?.decisionPlan && !draft.decisionPlan ? { decisionPlan: prior.decisionPlan } : {}),
            revision: expectedRevision + 1,
            updatedBy: role,
            updatedAt: new Date().toISOString(),
            sourceShiftId: shift.id,
        };
        if (proposal.status !== "closed" && proposal.decisionPlan && proposal.setup &&
            proposal.decisionPlan.horizonHours !== proposal.setup.holdHours)
            throw new Error("Preserved decision horizon and executable setup holdHours must agree; revise the plan explicitly.");
        const dataJson = JSON.stringify(proposal);
        if (existing) {
            const changed = await tx.deskRecord.updateMany({
                where: { id: existing.id, dataJson: existing.dataJson },
                data: {
                    dataJson,
                    shiftId: shift.id,
                    role,
                    createdAt: new Date(),
                },
            });
            if (changed.count !== 1)
                throw new Error(
                    "Proposal revision changed. Read the shared board before updating.",
                );
        } else
            await tx.deskRecord.create({
                data: {
                    bookId: book.id,
                    shiftId: shift.id,
                    key,
                    kind: "trade_proposal",
                    role,
                    dataJson,
                },
            });
        await tx.deskRecord.create({
            data: {
                bookId: book.id,
                shiftId: shift.id,
                key: key + ":revision:" + proposal.revision,
                kind: "proposal_revision",
                role,
                dataJson,
            },
        });
        if(proposal.status==="closed")await retireProposalWatches(tx,book,shift,proposal.key);
        if(role === "lead" && ["closed","parked","candidate"].includes(proposal.status))
            await consumeResearchReviews(tx,book,shift,[...proposal.evidenceIds,...(proposal.setup?.backtestRunIds??[]),
                ...(proposal.researchPlan??[]).flatMap(task=>task.evidenceIds)]);
        return proposal;
    });
}
