import "server-only";
import { randomUUID } from "node:crypto";
import type { RoleActivityEvent } from "./activity-types";
import { routineOpening } from "./routine-work";
import { entryDecisionReview, recentDecisionContext } from "./entry-decision";
import Ajv from "ajv";
import {
    codexDeskTransport,
    deskModelJson,
    type DeskTool,
    type DeskTransport,
} from "./runtime";
import {
    deskRoles,
    ROLE_VERSION,
    roleInstructions,
    roleNoteSchema,
    type DeskRole,
    type RoleNote,
} from "./roles";
import { openingSpecialists } from "./work-routing";
import {
    proposalSchema,
    validateProposal,
    researchQuestion,
    reviewedResearchDraft,
    type ProposalDraft,
    type TradeProposal,
    type ProposalReview,
} from "./proposals";

export type { DeskTool, DeskTransport } from "./runtime";
export type { DeskRole, RoleNote } from "./roles";
type Notes = Partial<Record<DeskRole, RoleNote>>;
export type DeskConsultation = {
    requester: DeskRole;
    colleague: DeskRole;
    question: string;
    note: RoleNote;
    proposalKey?: string;
    proposalRevision?: number;
    toolsUsed?: string[];
};

export type RoundtableInput = {
    shiftId: string;
    bookId?: string;
    /** Bounded, still-fresh public observations gathered by earlier roles in this shift. */
    sharedObservations?: () => unknown;
    /** Refresh local policy/reconciliation before each role without model tool reads. */
    refreshContext?: () => Promise<Record<string, unknown>>;
    /** Opening cause, current exposures, changes, due watches, unresolved order receipts. */
    brief: unknown;
    mode: "research" | "live";
    tools: DeskTool[];
    activeRoles?: DeskRole[];
    memory?: Partial<Record<DeskRole, unknown>>;
    /** Only supply notes already committed for THIS shift and book. */
    completed?: Notes;
    /** Already committed consultations for this shift; reuse their analysis, not expired quotes. */
    consultations?: DeskConsultation[];
    proposals?: TradeProposal[];
    /** Prior shifts' findings remain dated evidence, never a fresh/reusable consultation. */
    historicalReviews?: ProposalReview[];
    saveProposal?: (
        draft: ProposalDraft,
        role: DeskRole,
    ) => Promise<TradeProposal>;
    /** Commit a role's note durably before dependent roles run. */
    save: (role: DeskRole, note: RoleNote) => Promise<void>;
    recordConsult?: (entry: DeskConsultation) => Promise<void>;
    onActivity?: (event: RoleActivityEvent) => Promise<void>;
    signal?: AbortSignal;
    transport?: DeskTransport;
};

const validate = new Ajv().compile(roleNoteSchema);
function decodeNote(raw: string): RoleNote {
    const note = JSON.parse(raw);
    if (!validate(note))
        throw new Error(
            "Codex desk journal did not match the role-note schema",
        );
    const result = note as RoleNote;
    if (
        result.followUpAt !== null &&
        (!/(Z|[+-]\d\d:\d\d)$/.test(result.followUpAt) ||
            !Number.isFinite(Date.parse(result.followUpAt)))
    )
        throw new Error("Desk follow-up time must include a timezone");
    return result;
}

function toolsForRole(
    input: RoundtableInput,
    role: DeskRole,
    consult: boolean,
    signal: AbortSignal,
    invocationId: string,
) {
    const opening = input.brief as { admission?: { requiredWorkOnly?: boolean }; triggers?: { kind: string }[] } | null;
    const requiredOnly = opening?.admission?.requiredWorkOnly && !opening.triggers?.some(t => t.kind === "operator");
    return input.tools
        .filter(tool => !requiredOnly || tool.name !== "screen_markets")
        .filter(
            (tool) =>
                tool.access === "read" ||
                (!consult &&
                    (tool.access === "journal" ||
                        (input.mode === "live" &&
                            ((role === "lead" && tool.access === "lead") ||
                                (role === "execution" &&
                                    tool.access === "execution"))))),
        )
        .map((tool) => ({
            ...tool,
            run: async (
                args: Record<string, unknown>,
                ctx: Parameters<DeskTool["run"]>[1],
            ) => {
                if (signal.aborted || ctx.signal.aborted)
                    throw new Error("Desk shift cancelled");
                // Bind the authorization context to the host's shift, never to model or tool arguments.
                return tool.run(args, {
                    ...ctx,
                    role,
                    shiftId: input.shiftId,
                    bookId: input.bookId,
                    invocationId,
                });
            },
        }));
}

export async function runRoundtable(
    input: RoundtableInput,
): Promise<Partial<Record<DeskRole, RoleNote>>> {
    if (!input.shiftId.trim())
        throw new Error("A durable desk shift ID is required");
    const notes: Notes = { ...input.completed };
    const consultations = [...(input.consultations ?? [])];
    const proposals = new Map((input.proposals ?? []).map((p) => [p.key, p]));
    const backlog=(input.brief as {researchBacklog?:Array<{proposalKey:string;attempts:Array<{status:string;originShiftId?:string}>}>}|null)?.researchBacklog??[];
    const submittedResearchProposals=new Set(backlog.filter(p=>p.attempts.some(a=>["queued","running"].includes(a.status)||(a.originShiftId===input.shiftId&&a.status==="completed"))).map(p=>p.proposalKey));
    let newProposals = (input.proposals ?? []).filter(
        (p) => p.sourceShiftId === input.shiftId,
    ).length;
    let proposalWrite = Promise.resolve();
    let specialistCalls = consultations.length;
    let automaticResearchCalls = consultations.filter((c) =>
        c.question.startsWith("[Research task "),
    ).length;
    const pendingConsults = new Map<string, Promise<RoleNote>>();
    for (const note of Object.values(notes)) decodeNote(JSON.stringify(note));
    const transport = input.transport ?? codexDeskTransport;
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) controller.abort();

    const report = async (event: RoleActivityEvent) => {
        try {
            await input.onActivity?.(event);
        } catch {
            console.warn("[Desk activity] Could not record analyst activity");
        }
    };
    const runRole = async (
        role: DeskRole,
        prior: Notes,
        question?: string,
        requester: DeskRole | null = null,
        parentInvocationId: string | null = null,
        assignedProposal?: TradeProposal,
    ): Promise<RoleNote> => {
        if (controller.signal.aborted) throw new Error("Desk shift cancelled");
        const event: RoleActivityEvent = {
            invocationId: randomUUID(),
            role,
            requester,
            ...(question ? { question: question.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            parentInvocationId,
            phase: "started",
            startedAt: new Date().toISOString(),
            endedAt: null,
            error: null,
        };
        await report(event);
        try {
            const tools: DeskTool[] = toolsForRole(
                input,
                role,
                !!question,
                controller.signal,
                event.invocationId,
            );
            tools.push({
                name: "read_trade_proposals",
                access: "read",
                description:
                    "Read this shift's mode-scoped proposal board and reviews. Research and live boards have separate revisions; research_backlog can inspect live ideas but this tool edits neither board. Older-version reviews are historical.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                run: async () => ({
                    mode: input.mode,
                    proposals: [...proposals.values()],
                    entryDecisions: [...proposals.values()].map(p => ({ proposalKey: p.key, revision: p.revision, ...entryDecisionReview(p.decisionPlan) })),
                    reviews: consultations.filter((c) => c.proposalKey),
                    historicalReviews: input.historicalReviews ?? [],
                    remainingSpecialistCalls: Math.max(0, 6 - specialistCalls),
                }),
            });
            if (!question && input.saveProposal)
                tools.push({
                    name: "update_trade_proposal",
                    access: "journal",
                    inputSchema: proposalSchema,
                    description:
                        "Create or revise a draft on THIS shift's mode-scoped board. Use expectedRevision=0 for a new key; preserve findings. On a substantive decision record decisionPlan and its evidence assessment. Before a new discretionary entry also supply decisionPlan.allocation: net continuation/stagnation/failure payoff, support for required extension, concrete event sizing/timing action, and common-driver joint exposure versus cash. Host checks review completeness and ticket consistency, not an alpha score or payoff ratio. Changed criteria require a fresh changeReason. Legacy plans remain readable/closable but cannot authorize a new entry without this review. Research cannot edit live revisions; use resolve_research_idea for findings. Null price/size means unresolved. Only the lead parks/closes proposals. Saving never authorizes an order.",
                    run: async (args) => {
                        const write = proposalWrite.then(async () => {
                            if (controller.signal.aborted)
                                throw new Error("Desk shift cancelled");
                            validateProposal(args, role);
                            const fresh = args.expectedRevision===0 && !proposals.has(args.key);
                            if (
                                fresh &&
                                newProposals >= 4
                            )
                                throw new Error(
                                    "Four new ideas already saved this turn. Revise existing ideas or defer additional discovery to the next turn; carried-over ideas do not consume this budget.",
                                );
                            const stored = await input.saveProposal!(
                                args,
                                role,
                            );
                            if (fresh) newProposals++;
                            proposals.set(stored.key, stored);
                            return stored;
                        });
                        proposalWrite = write.then(
                            () => undefined,
                            () => undefined,
                        );
                        return write;
                    },
                });
            let consultationCount = consultations.filter(
                (c) => c.requester === role,
            ).length;
            if (!question && !input.activeRoles)
                tools.push({
                    name: "consult_colleague",
                    access: "read",
                    description:
                        "Ask only the specialist needed to resolve a concrete question. Include proposalKey for a candidate review; the host attaches the exact revision. Identical completed requests reuse their historical answer. Change the question explicitly when fresh evidence or quotes are needed. At most six new consultations per shift; no nested delegation or transferred authority.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["role", "question"],
                        properties: {
                            role: {
                                type: "string",
                                enum: deskRoles.filter((r) => r !== role),
                            },
                            question: {
                                type: "string",
                                minLength: 1,
                                maxLength: 1000,
                            },
                            proposalKey: {
                                type: "string",
                                minLength: 1,
                                maxLength: 80,
                            },
                        },
                    },
                    run: async (args) => {
                        if (controller.signal.aborted)
                            throw new Error("Desk shift cancelled");
                        const colleague = args.role as DeskRole;
                        if (
                            colleague === role ||
                            !deskRoles.includes(colleague) ||
                            typeof args.question !== "string" ||
                            !args.question.trim() ||
                            args.question.length > 1000
                        )
                            throw new Error(
                                "Invalid or exhausted colleague consultation",
                            );
                        const proposal =
                            typeof args.proposalKey === "string"
                                ? proposals.get(args.proposalKey)
                                : undefined;
                        if (
                            args.proposalKey !== undefined &&
                            (!proposal ||
                                Date.parse(proposal.validUntil) <= Date.now())
                        )
                            throw new Error(
                                "Read a current shared proposal before requesting its review.",
                            );
                        const question = args.question.trim();
                        const match = (c: DeskConsultation) =>
                            c.requester === role &&
                            c.colleague === colleague &&
                            c.question === question &&
                            c.proposalKey === proposal?.key &&
                            c.proposalRevision === proposal?.revision;
                        const saved = consultations.find(match);
                        if (saved)
                            return {
                                colleague,
                                note: saved.note,
                                reused: true,
                                proposalKey: saved.proposalKey,
                                proposalRevision: saved.proposalRevision,
                                warning:
                                    "Historical review; quote validity is unchanged.",
                            };
                        const key = JSON.stringify([
                            role,
                            colleague,
                            question,
                            proposal?.key,
                            proposal?.revision,
                        ]);
                        const pending = pendingConsults.get(key);
                        if (pending)
                            return {
                                colleague,
                                note: await pending,
                                reused: true,
                                proposalKey: proposal?.key,
                                proposalRevision: proposal?.revision,
                            };
                        if (
                            consultationCount >= (role === "lead" ? 6 : 2) ||
                            specialistCalls >= 6
                        )
                            throw new Error(
                                "Specialist budget exhausted; decide or state the unresolved research need.",
                            );
                        consultationCount++;
                        specialistCalls++;
                        const work = runRole(
                            colleague,
                            { ...notes },
                            question,
                            role,
                            event.invocationId,
                            proposal,
                        );
                        pendingConsults.set(key, work);
                        try {
                            const note = await work;
                            return {
                                colleague,
                                mandateVersion: ROLE_VERSION,
                                note,
                                proposalKey: proposal?.key,
                                proposalRevision: proposal?.revision,
                            };
                        } finally {
                            pendingConsults.delete(key);
                        }
                    },
                });
            const usedTools = new Set<string>();
            const hostContext = {
                role,
                shiftId: input.shiftId,
                bookId: input.bookId,
                signal: controller.signal,
                invocationId: event.invocationId,
                callId: "host-research",
            };
            tools.push({
                name: "tool_catalog",
                access: "read",
                description:
                    "List the actual capabilities and permissions available in this session. Research tools do not grant execution authority.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                run: async () =>
                    tools.map((t) => ({
                        name: t.name,
                        access: t.access,
                        description: t.description,
                    })),
            });
            const completedResearchTools = new Set<string>();
            let comparisonRecorded = false;
            const portfolioComparisons = new Set<string>();
            const presentedTools = tools.map((t) => ({
                ...t,
                run: async (
                    a: Record<string, unknown>,
                    c: Parameters<DeskTool["run"]>[1],
                ) => {
                    usedTools.add(t.name);
                    if(t.name === "backtest_strategy" && opening?.triggers?.some(t => t.kind === "hypothesis_research") && a.engine !== "candles" && (!Array.isArray(a.additionalWindows) || a.additionalWindows.length < 2))
                        throw new Error("Scheduled hypothesis research requires a campaign: supply at least two additionalWindows on distinct dates, with fixed rules/costs. A single short window is only a smoke test. Inspect backtest_catalog for supported dates.");
                    // A batched save-and-test call must await the already pending draft commit.
                    if(["backtest_strategy", "set_watch", "manage_watch", "trade_plan"].includes(t.name)&&typeof a.proposalKey==="string")await proposalWrite;
                    const result = await t.run(a, c);
                    if (t.name === "record_candidate_comparison" && (result as { recorded?: boolean })?.recorded) comparisonRecorded = true;
                    if (["record_candidate_comparison", "record_portfolio_comparison"].includes(t.name) && (result as { portfolioRecorded?: boolean })?.portfolioRecorded) {
                        const id = (result as { holdingInstrumentId?: string }).holdingInstrumentId;
                        if (id) portfolioComparisons.add(id);
                    }
                    if(t.name==="backtest_strategy"&&typeof a.proposalKey==="string"&&["queued","running"].includes(String((result as {status?:string})?.status)))submittedResearchProposals.add(a.proposalKey);
                    if(t.name==="backtest_strategy")completedResearchTools.add(t.name);
                    if(t.name==="resolve_research_idea"&&(result as {researchProgress?:boolean})?.researchProgress)completedResearchTools.add(t.name);
                    if(t.name==="start_prospective_test"&&!(result as {reused?:boolean})?.reused)completedResearchTools.add("backtest_strategy");
                    if(t.name==="retry_backtest" && result && typeof result==="object" && ["queued","running"].includes(String((result as {status?:unknown}).status)))completedResearchTools.add("backtest_strategy");
                    return result;
                },
            }));
            const resolveReadyResearch = async () => {
                const consult = tools.find(
                        (t) => t.name === "consult_colleague",
                    ),
                    update = tools.find(
                        (t) => t.name === "update_trade_proposal",
                    );
                if (
                    role !== "lead" ||
                    question ||
                    input.activeRoles ||
                    !consult ||
                    !update
                )
                    return 0;
                let completed = 0;
                for (const key of proposals.keys()) {
                    let p = proposals.get(key)!;
                    if (
                        p.status === "closed" ||
                        Date.parse(p.validUntil) <= Date.now()
                    )
                        continue;
                    for (const initial of p.researchPlan ?? []) {
                        p = proposals.get(key)!;
                        const task = p.researchPlan.find(
                            (t) => t.id === initial.id,
                        );
                        if (!task || task.status !== "ready") continue;
                        // Submission owns the next step through its completion event.
                        // A still-ready draft must not launch a polling consultation.
                        if(submittedResearchProposals.has(p.key)&&["backtest_strategy","backtest_status","retry_backtest"].includes(task.nextTool))continue;
                        const q = researchQuestion(p, task);
                        let receipt = consultations.find(
                            (c) =>
                                c.requester === "lead" &&
                                c.colleague === task.owner &&
                                c.question === q &&
                                c.proposalKey === p.key &&
                                c.proposalRevision === p.revision,
                        );
                        if (!receipt) {
                            if (
                                automaticResearchCalls >= 2 ||
                                specialistCalls >= 6
                            )
                                return completed;
                            automaticResearchCalls++;
                            await consult.run(
                                {
                                    role: task.owner,
                                    question: q,
                                    proposalKey: p.key,
                                },
                                hostContext,
                            );
                            receipt = consultations.find(
                                (c) =>
                                    c.requester === "lead" &&
                                    c.colleague === task.owner &&
                                    c.question === q &&
                                    c.proposalKey === p.key &&
                                    c.proposalRevision === p.revision,
                            );
                        }
                        if (receipt) {
                            await update.run(
                                reviewedResearchDraft(
                                    p,
                                    task.id,
                                    receipt.note,
                                    receipt.toolsUsed ?? [],
                                ) as unknown as Record<string, unknown>,
                                hostContext,
                            );
                            completed++;
                        }
                    }
                }
                return completed;
            };
            // Recovered ready work runs once; committed receipts repair an interrupted
            // proposal update even when this shift's new-consultation budget is spent.
            await resolveReadyResearch();
            let opportunityScan: unknown;
            const opening = input.brief as {
                triggers?: { kind: string; priority?: number; payload?: unknown }[]; routineOnly?: boolean; admission?: { requiredWorkOnly?: boolean; scheduledPortfolioReview?: boolean };
                portfolio?: { holdings?: Array<{ instrumentId: string; quantity: number }> }; portfolioReviewReuse?: unknown;
            } | null;
            const discovery = opening?.triggers?.find(t => t.kind === "opportunity_scan");
            const screening = tools.find((t) => t.name === "screen_markets");
            if (role === "lead" && !question && discovery) opportunityScan = discovery.payload;
            if (
                role === "lead" &&
                !question &&
                !discovery &&
                !opening?.admission?.requiredWorkOnly &&
                !opening?.admission?.scheduledPortfolioReview &&
                (input.mode === "live" || !input.activeRoles) &&
                opening?.routineOnly !== true &&
                screening &&
                opening?.triggers?.some((t) => t.kind === "scheduled")
            ) {
                try {
                    opportunityScan = await screening.run(
                        { limit: 5 },
                        { ...hostContext, callId: randomUUID() },
                    );
                } catch (e) {
                    opportunityScan = {
                        status: "unavailable",
                        reason:
                            e instanceof Error
                                ? e.message
                                : "Screen unavailable",
                    };
                }
            }
            const requiresComparison = role === "lead" && !question && input.mode === "live" &&
                !opening?.admission?.requiredWorkOnly &&
                opening?.routineOnly !== true && !!opening?.triggers?.some(t => t.kind === "scheduled" || t.kind === "opportunity_scan") &&
                tools.some(t => t.name === "record_candidate_comparison");
            const requiresReplay = role === "lead" && !question && opening?.triggers?.some(t => t.kind === "hypothesis_research");
            const scheduledPortfolio = opening?.triggers?.some(t => t.kind === "scheduled");
            const nominatedIds = new Set((discovery?.payload as { comparisonBrief?: { candidates?: Array<{ instrumentId: string }> } })
                ?.comparisonBrief?.candidates?.map(c => c.instrumentId) ?? []);
            // Discovery of an unrelated candidate does not require another journal
            // for every incumbent. Scheduled reviews still cover the whole book.
            const portfolioTargets = (opening?.portfolio?.holdings ?? []).filter(p => p.quantity !== 0 &&
                (scheduledPortfolio || nominatedIds.has(p.instrumentId)));
            const requiresPortfolio = role === "lead" && !question && input.mode === "live" &&
                !opening?.portfolioReviewReuse &&
                portfolioTargets.length > 0 &&
                !opening?.triggers?.some(t => (t.priority ?? 0) >= 10 || ["risk", "correction", "fill", "missed_fill"].includes(t.kind)) &&
                tools.some(t => t.name === "record_portfolio_comparison");
            const missingPortfolio = () => portfolioTargets.filter(p => !portfolioComparisons.has(p.instrumentId)).map(p => p.instrumentId);
            let note: RoleNote | undefined;
            for (let synthesis = 0; synthesis < 2; synthesis++) {
                const observations = await input.sharedObservations?.();
                const brief = input.activeRoles ? routineOpening(input.brief, role) : input.brief;
                const refreshed = await input.refreshContext?.();
                const result = await transport({
                    role,
                    meter: {
                        kind: question ? "consult" : "role",
                        bookId: input.bookId,
                    },
                    shiftId: input.shiftId,
                    signal: controller.signal,
                    schema: roleNoteSchema,
                    instructions: roleInstructions(role, {
                        live: input.mode === "live",
                        consult: !!question,
                    }),
                    tools: presentedTools,
                    input: deskModelJson({
                        openingBrief: refreshed ? { ...(brief as Record<string, unknown>), ...refreshed } : brief,
                        ...(observations &&
                        (!Array.isArray(observations) || observations.length)
                            ? { sharedObservations: observations }
                            : {}),
                        previousJournal: input.memory?.[role] ?? [],
                        decisionContext: recentDecisionContext([...proposals.values()]),
                        ...(requiresComparison ? { comparisonWork: {
                            recorded: comparisonRecorded,
                            previousDecision: note ?? null,
                            instruction: "Compare the strongest distinct candidates and cash using the supplied slate or justified replacements. If openingBrief.admission is present, focus on its decision-sensitive questions; a one- or two-name admitted slate is sufficient. Do not refill it with unchanged deferred names just to reach three. Record actual investigation coverage before the final journal, explaining narrower coverage. On a second synthesis finish using already observed evidence; do not repeat orders, scans or unchanged tool reads. No trade quota and no requirement to find positive expectancy. Admission is permission to investigate, never an entry signal or renewed trade authority.",
                        } } : {}),
                        ...(role === "lead"
                            ? {
                                  previousSpecialistJournals:
                                      Object.fromEntries(
                                          deskRoles
                                              .filter((r) => r !== "lead")
                                              .map((r) => [
                                                  r,
                                                  Array.isArray(
                                                      input.memory?.[r],
                                                  )
                                                      ? (
                                                            input.memory![
                                                                r
                                                            ] as unknown[]
                                                        ).slice(0, 1)
                                                      : [],
                                              ]),
                                      ),
                              }
                            : {}),
                        roundtable: input.activeRoles ? {} : prior,
                        consultations: consultations
                            .filter(
                                (c) =>
                                    role === "lead" ||
                                    c.colleague === role ||
                                    c.requester === role,
                            )
                            .slice(-6),
                        sharedProposals: [...proposals.values()],
                        ...(opportunityScan ? { opportunityScan } : {}),
                        ...(requiresPortfolio ? { portfolioWork: {
                            recorded: missingPortfolio().length === 0,
                            missingHoldingInstrumentIds: missingPortfolio(),
                            previousDecision: note ?? null,
                            instruction: "Record concise hold/cash/rotation assessments for the listed holdings, prioritizing consequential changes; do not repeat recorded holdings. Supply forwardCase: marginal advantage over cash, why evidence outweighs the strongest objection and payoff sensitivity, why the mechanism fits the remaining original time, and its vulnerable assumption. Use checked live-versus-close relations; cite priceEvidenceId plus priceClaims for numerical assertions. Unknown probabilities stay unknown. Holding, cash and unresolved remain valid; a surviving stop or deadline alone is not an investment case. With no credible replacement mark rotation unavailable. On synthesis 1 finish from existing evidence without repeated orders or unchanged reads. Explain any omitted holdings. No trade quota or execution gate; urgent protection comes first.",
                        } } : {}),
                        mandatoryHypothesisTest: requiresReplay ? {
                            instruction: "If an evidence-followup trigger nominates an instrument and question, resolve that specific gap first using its source-shift evidence; do not substitute unrelated discovery. Otherwise use research_landscape, research_backlog and backtest_catalog. Choose a defensible under-tested family/direction from researchLanes; a failed current entry is not grounds to stop historical research. Then test a shortlist mechanism with backtest_strategy engine=candles, source=venue_candles, 30-90 days at 1h (or finer recent 15m), fixed rules/costs and proposalKey. Depth replay requires at least two additionalWindows. A backtest_status read alone is not new research progress; resolve the finding or submit a materially expanded experiment. Or resolve a genuinely changed applicable result; do not use an unchanged administrative disposition to consume every research review. For promising sparse evidence, start_prospective_test registers real frozen-rule forward observation. Do not demand future trade outcomes from the price-only setup_outcomes tool. Queue and return; completion reviews it. Scenario calculations alone do not meet this task. If coverage is unusable, cite the observed catalog and exact gap. No live action is authorized.",
                            replayUsed: completedResearchTools.has("backtest_strategy") || completedResearchTools.has("resolve_research_idea"),
                        } : undefined,
                        researchWork: {
                            remainingAutomaticAssignments: Math.max(
                                0,
                                2 - automaticResearchCalls,
                            ),
                            synthesis,
                            instruction: synthesis
                                ? "Specialist findings are committed. Incorporate them, classify unresolved work as a specific external dependency or close it, and finish the decision. Do not repeat the same research."
                                : "Ready proposal tasks may trigger up to two targeted assignments and one further lead synthesis.",
                        },
                        historicalProposalReviews:
                            input.historicalReviews ?? [],
                        ...(assignedProposal ? { assignedProposal } : {}),
                        workflow: "selective_collaboration",
                        ...(question ? { researchQuestion: question } : {}),
                        role,
                        mandateVersion: ROLE_VERSION,
                        mode: input.mode,
                    }),
                });
                note = decodeNote(result);
                if (synthesis === 0 && ((requiresComparison && !comparisonRecorded) || (requiresPortfolio && missingPortfolio().length > 0)) &&
                    !usedTools.has("work_order") && !usedTools.has("recover_missed_fill")) continue;
                if (synthesis === 0 && requiresReplay && !completedResearchTools.has("backtest_strategy") && !completedResearchTools.has("resolve_research_idea")) continue;
                if (synthesis === 0 && (await resolveReadyResearch())) continue;
                break;
            }
            if (!note) throw new Error("No completed desk assessment");
            if (requiresReplay && !completedResearchTools.has("backtest_strategy") && !completedResearchTools.has("resolve_research_idea"))
                note.summary = "Historical hypothesis test remains incomplete. " + note.summary;
            if (requiresComparison && !comparisonRecorded)
                note.summary = "Candidate comparison not recorded. " + note.summary;
            if (requiresPortfolio && missingPortfolio().length > 0)
                note.summary = "Portfolio alternatives not recorded for " + missingPortfolio().join(", ") + ". " + note.summary;
            if (controller.signal.aborted)
                throw new Error("Desk shift cancelled");
            if (question && requester) {
                const entry: DeskConsultation = {
                    requester,
                    colleague: role,
                    question,
                    note,
                    toolsUsed: [...usedTools],
                    ...(assignedProposal
                        ? {
                              proposalKey: assignedProposal.key,
                              proposalRevision: assignedProposal.revision,
                          }
                        : {}),
                };
                await input.recordConsult?.(entry);
                consultations.push(entry);
            } else {
                await input.save(role, note);
                notes[role] = note;
            }
            await report({
                ...event,
                phase: "completed",
                endedAt: new Date().toISOString(),
            });
            return note;
        } catch (error) {
            await report({
                ...event,
                phase: controller.signal.aborted ? "cancelled" : "failed",
                endedAt: new Date().toISOString(),
                error:
                    error instanceof Error
                        ? error.message.slice(0, 350)
                        : "Analyst turn failed",
            });
            throw error;
        }
    };

    try {
        // Event owners can originate ideas independently. The lead selectively requests
        // further research/execution/risk work instead of an automatic five-role review.
        const waves: DeskRole[][] = input.activeRoles
            ? [
                  input.activeRoles.filter((r) => r !== "lead"),
                  input.activeRoles.includes("lead") ? ["lead"] : [],
              ]
            : [openingSpecialists(input.brief), ["lead"]];
        for (const wave of waves) {
            const prior = { ...notes };
            const tasks = wave
                .filter(
                    (role) =>
                        !notes[role] &&
                        (!input.activeRoles ||
                            input.activeRoles.includes(role)),
                )
                .map(async (role) => {
                    try {
                        await runRole(role, prior);
                    } catch (error) {
                        controller.abort();
                        throw error;
                    }
                });
            const results = await Promise.allSettled(tasks);
            const failure = results.find(
                (r): r is PromiseRejectedResult => r.status === "rejected",
            );
            if (failure) throw failure.reason;
        }
        if (controller.signal.aborted) throw new Error("Desk shift cancelled");
        return notes;
    } finally {
        controller.abort();
        input.signal?.removeEventListener("abort", abort);
    }
}
