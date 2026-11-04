import "server-only";
import { routineOpening } from "./routine-work";
import Ajv from "ajv";
import { codexDeskTransport, deskModelJson, type DeskTool, type DeskTransport } from "./runtime";
import { deskRoles, ROLE_VERSION, roleInstructions, roleNoteSchema, type DeskRole, type RoleNote } from "./roles";

export type { DeskTool, DeskTransport } from "./runtime";
export type { DeskRole, RoleNote } from "./roles";
type Notes = Partial<Record<DeskRole, RoleNote>>;

export type RoundtableInput = {
    shiftId: string;
    bookId?: string;
    /** Bounded, still-fresh public observations gathered by earlier roles in this shift. */
    sharedObservations?: () => unknown;
    /** Opening cause, current exposures, changes, due watches, unresolved order receipts. */
    brief: unknown;
    mode: "research" | "live";
    tools: DeskTool[];
    activeRoles?: DeskRole[];
    memory?: Partial<Record<DeskRole, unknown>>;
    /** Only supply notes already committed for THIS shift and book. */
    completed?: Notes;
    /** Commit a role's note durably before dependent roles run. */
    save: (role: DeskRole, note: RoleNote) => Promise<void>;
    recordConsult?: (entry: {
        requester: DeskRole;
        colleague: DeskRole;
        question: string;
        note: RoleNote;
    }) => Promise<void>;
    signal?: AbortSignal;
    transport?: DeskTransport;
};

const validate = new Ajv().compile(roleNoteSchema);
function decodeNote(raw: string): RoleNote {
    const note = JSON.parse(raw);
    if (!validate(note)) throw new Error("Codex desk journal did not match the role-note schema");
    const result = note as RoleNote;
    if (
        result.followUpAt !== null &&
        (!/(Z|[+-]\d\d:\d\d)$/.test(result.followUpAt) || !Number.isFinite(Date.parse(result.followUpAt)))
    )
        throw new Error("Desk follow-up time must include a timezone");
    return result;
}

function toolsForRole(input: RoundtableInput, role: DeskRole, consult: boolean, signal: AbortSignal) {
    return input.tools
        .filter(
            (tool) =>
                tool.access === "read" ||
                (!consult &&
                    (tool.access === "journal" ||
                        (input.mode === "live" &&
                            ((role === "lead" && tool.access === "lead") ||
                                (role === "execution" && tool.access === "execution"))))),
        )
        .map((tool) => ({
            ...tool,
            run: async (args: Record<string, unknown>, ctx: Parameters<DeskTool["run"]>[1]) => {
                if (signal.aborted || ctx.signal.aborted) throw new Error("Desk shift cancelled");
                // Bind the authorization context to the host's shift, never to model or tool arguments.
                return tool.run(args, { ...ctx, role, shiftId: input.shiftId, bookId: input.bookId });
            },
        }));
}

export async function runRoundtable(input: RoundtableInput): Promise<Partial<Record<DeskRole, RoleNote>>> {
    if (!input.shiftId.trim()) throw new Error("A durable desk shift ID is required");
    const notes: Notes = { ...input.completed };
    for (const note of Object.values(notes)) decodeNote(JSON.stringify(note));
    const transport = input.transport ?? codexDeskTransport;
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) controller.abort();

    const runRole = async (role: DeskRole, prior: Notes, question?: string): Promise<RoleNote> => {
        if (controller.signal.aborted) throw new Error("Desk shift cancelled");
        const tools: DeskTool[] = toolsForRole(input, role, !!question, controller.signal);
        let consultations = 0;
        if (!question && !input.activeRoles)
            tools.push({
                name: "consult_colleague",
                access: "read",
                description:
                    "Request another role's independent assessment of a concrete question. It may investigate using research tools; your authority stays with you.",
                inputSchema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["role", "question"],
                    properties: {
                        role: { type: "string", enum: deskRoles.filter((r) => r !== role) },
                        question: { type: "string", minLength: 1, maxLength: 1000 },
                    },
                },
                run: async (args) => {
                    const colleague = args.role as DeskRole;
                    if (
                        colleague === role ||
                        !deskRoles.includes(colleague) ||
                        typeof args.question !== "string" ||
                        !args.question.trim() ||
                        args.question.length > 1000 ||
                        ++consultations > 2
                    )
                        throw new Error("Invalid or exhausted colleague consultation");
                    const note = await runRole(colleague, prior, args.question);
                    await input.recordConsult?.({ requester: role, colleague, question: args.question, note });
                    return { colleague, mandateVersion: ROLE_VERSION, note };
                },
            });
        const observations = await input.sharedObservations?.();
        const result = await transport({
            role,
            meter: { kind: question ? "consult" : "role", bookId: input.bookId },
            shiftId: input.shiftId,
            signal: controller.signal,
            schema: roleNoteSchema,
            instructions: roleInstructions(role, { live: input.mode === "live", consult: !!question }),
            tools,
            input: deskModelJson({
                openingBrief: input.activeRoles ? routineOpening(input.brief,role) : input.brief,
                ...(observations && (!Array.isArray(observations) || observations.length)
                    ? { sharedObservations: observations }
                    : {}),
                previousJournal: input.memory?.[role] ?? [],
                roundtable: input.activeRoles ? {} : prior,
                ...(question ? { researchQuestion: question } : {}),
                role,
                mandateVersion: ROLE_VERSION,
                mode: input.mode,
            }),
        });
        return decodeNote(result);
    };

    try {
        // Research in parallel on a fixed snapshot of the discussion. Execution and risk can
        // challenge the initial pitches. The lead sees every committed view and all dissent.
        for (const wave of [["catalyst", "derivatives"], ["execution", "risk"], ["lead"]] as DeskRole[][]) {
            const prior = { ...notes };
            const tasks = wave
                .filter((role) => !notes[role] && (!input.activeRoles || input.activeRoles.includes(role)))
                .map(async (role) => {
                    try {
                        const note = await runRole(role, prior);
                        if (controller.signal.aborted) throw new Error("Desk shift cancelled");
                        await input.save(role, note);
                        notes[role] = note;
                    } catch (error) {
                        controller.abort();
                        throw error;
                    }
                });
            const results = await Promise.allSettled(tasks);
            const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
            if (failure) throw failure.reason;
        }
        if (controller.signal.aborted) throw new Error("Desk shift cancelled");
        return notes;
    } finally {
        controller.abort();
        input.signal?.removeEventListener("abort", abort);
    }
}
