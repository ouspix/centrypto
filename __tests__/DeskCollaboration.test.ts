// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { openingSpecialists } from "@/lib/desk/work-routing";
import {
    runRoundtable,
    type DeskConsultation,
    type RoleNote,
} from "@/lib/desk/roundtable";
import {
    validateProposal,
    researchQuestion,
    type ProposalDraft,
    type TradeProposal,
} from "@/lib/desk/proposals";
import type { DeskTurn } from "@/lib/desk/runtime";

const draft = (): ProposalDraft => ({
    key: "sol-basis",
    expectedRevision: 0,
    status: "researching",
    thesis: "Potential basis dislocation",
    horizon: "One funding interval",
    invalidation: "Spread widens beyond costs",
    missingEvidence: ["Executable exit liquidity"],
    evidenceIds: ["event:1"],
    economics: "Unresolved exit costs",
    researchPlan: [
        {
            id: "exit",
            gap: "Executable exit liquidity",
            owner: "execution",
            question: "What exit liquidity is available?",
            nextTool: "order_book",
            completionCriteria: "Observe a fresh executable exit book",
            status: "waiting_external",
            result: "Awaiting a new venue liquidity observation",
            evidenceIds: [],
        },
    ],
    legs: [
        {
            instrumentId: "mainnet:perp:SOL",
            side: "sell",
            quantity: null,
            entryPrice: null,
        },
    ],
    validUntil: new Date(Date.now() + 3600000).toISOString(),
});
const note = (role: string): RoleNote => ({
    summary: role,
    thesis: "Conditional candidate",
    invalidation: "Costs exceed spread",
    evidenceIds: [],
    dissent: role === "risk" ? "Exit liquidity uncertain" : "",
    followUpAt: null,
});
const call = (t: DeskTurn, name: string, args: object = {}) =>
    t.tools
        .find((x) => x.name === name)!
        .run(args as Record<string, unknown>, {
            role: t.role,
            shiftId: t.shiftId,
            callId: name,
            signal: t.signal!,
        });

describe("selective collaboration", () => {
    it("waits for a pending proposal commit before registering its watch", async () => {
        let committed=false, release!:()=>void;
        const pending=new Promise<void>(resolve=>{release=resolve;});
        const d=draft();
        const watch=vi.fn(async()=>{expect(committed).toBe(true);return {watchId:"saved-watch"};});
        await runRoundtable({shiftId:"save-watch",mode:"research",brief:{triggers:[{kind:"operator"}]},
            tools:[{name:"set_watch",access:"journal",description:"watch",inputSchema:{type:"object"},run:watch}],
            saveProposal:async input=>{await pending;committed=true;return {...input,revision:1,updatedBy:"lead",updatedAt:new Date().toISOString(),sourceShiftId:"save-watch"};},
            save:async()=>{},transport:async t=>{
                const save=call(t,"update_trade_proposal",d);
                const observe=call(t,"set_watch",{proposalKey:d.key});
                await Promise.resolve();expect(watch).not.toHaveBeenCalled();release();
                await Promise.all([save,observe]);return JSON.stringify(note(t.role));
            }});
        expect(watch).toHaveBeenCalledTimes(1);
    });
    it.each([false,true])("defers queued proposal research to its completion event, including recovery=%s",async recovered=>{
        const d=draft();d.researchPlan[0]={...d.researchPlan[0],owner:"derivatives",nextTool:"backtest_strategy",status:"ready"};
        const {expectedRevision,...fields}=d;
        const p={...fields,revision:1,updatedBy:"lead",updatedAt:new Date().toISOString(),sourceShiftId:"queued"} as TradeProposal;
        const transport=vi.fn(async(t:DeskTurn)=>{
            expect(t.role).toBe("lead");
            if(!recovered){await call(t,"update_trade_proposal",d);await call(t,"backtest_strategy",{engine:"candles",proposalKey:d.key});}
            return JSON.stringify(note("lead"));
        });
        await runRoundtable({shiftId:"queued",mode:"research",brief:{triggers:[{kind:"operator"}],researchBacklog:recovered?[{proposalKey:d.key,attempts:[{status:"completed",originShiftId:"queued"}]}]:[]},
            proposals:recovered?[p]:[],saveProposal:async()=>p,save:async()=>{},transport,
            tools:[{name:"backtest_strategy",access:"read",description:"queue",inputSchema:{type:"object"},run:async()=>({status:"queued",runId:"r"})}]});
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it("provides the actual read-only catalog and automatically screens scheduled lead reviews", async () => {
        const scan = vi.fn(async () => ({
            status: "observed",
            candidates: ["BTC"],
        }));
        await runRoundtable({
            shiftId: "screen",
            mode: "research",
            brief: { triggers: [{ kind: "scheduled" }] },
            tools: [
                {
                    name: "screen_markets",
                    access: "read",
                    description: "Scan",
                    inputSchema: { type: "object" },
                    run: scan,
                },
                {
                    name: "submit_order",
                    access: "lead",
                    description: "Place",
                    inputSchema: { type: "object" },
                    run: async () => {
                        throw new Error("No orders in research");
                    },
                },
            ],
            save: async () => {},
            transport: async (t) => {
                expect(JSON.parse(t.input).opportunityScan).toEqual({
                    status: "observed",
                    candidates: ["BTC"],
                });
                expect(
                    ((await call(t, "tool_catalog")) as any[]).map(
                        (t) => t.name,
                    ),
                ).toContain("screen_markets");
                expect(t.tools.every((t) => t.access === "read")).toBe(true);
                return JSON.stringify(note(t.role));
            },
        });
        expect(scan).toHaveBeenCalledTimes(1);
    });
    it("bounds automatic assignments and repairs committed work without repeating the specialist", async () => {
        const { expectedRevision: _, ...d } = draft();
        let p: TradeProposal = {
            ...d,
            revision: 1,
            updatedBy: "lead",
            updatedAt: new Date().toISOString(),
            sourceShiftId: "old",
            researchPlan: Array.from({ length: 3 }, (_, i) => ({
                ...d.researchPlan[0],
                id: "exit-" + i,
                status: "ready",
                result: "",
            })),
        };
        const old: DeskConsultation = {
            requester: "lead",
            colleague: "execution",
            proposalKey: p.key,
            proposalRevision: 1,
            question: researchQuestion(p, p.researchPlan[0]),
            note: note("execution"),
            toolsUsed: ["order_book"],
        };
        const viewed: string[] = [];
        await runRoundtable({
            shiftId: "repair",
            mode: "research",
            brief: {},
            tools: [],
            proposals: [p],
            consultations: [old],
            save: async () => {},
            saveProposal: async (d, r) => {
                const { expectedRevision, ...fields } = d;
                p = {
                    ...fields,
                    revision: expectedRevision + 1,
                    updatedBy: r,
                    updatedAt: new Date().toISOString(),
                    sourceShiftId: "repair",
                };
                return p;
            },
            transport: async (t) => {
                viewed.push(t.role);
                return JSON.stringify(note(t.role));
            },
        });
        expect(viewed).toEqual(["execution", "lead"]); // Recovered receipt + only one remaining automatic call.
        expect(p.researchPlan.map((t) => t.status)).toEqual([
            "review",
            "review",
            "ready",
        ]);
        expect(p.researchPlan[0].methodUsed).toBe(true);
        expect(p.researchPlan[1].methodUsed).toBe(false);
    });
    it.each([
        ["scheduled", []],
        ["operator", []],
        ["research", ["catalyst"]],
        ["discovery", ["catalyst"]],
        ["market_move", ["derivatives"]],
        ["fill", ["execution"]],
        ["risk", ["risk"]],
        ["order_ticket", ["execution"]],
    ])("routes %s to its event owner", (kind, expected) => {
        expect(openingSpecialists({ triggers: [{ kind }] })).toEqual(expected);
    });

    it("coalesces mixed event owners and leaves routine reminders scoped to their owner", async () => {
        expect(
            openingSpecialists({
                triggers: [
                    { kind: "fill" },
                    { kind: "fill" },
                    { kind: "risk" },
                    { kind: "watch", payload: { role: "derivatives" } },
                ],
            }),
        ).toEqual(["derivatives", "execution", "risk"]);
        const roles: string[] = [];
        await runRoundtable({
            shiftId: "routine",
            mode: "research",
            brief: {},
            activeRoles: ["derivatives"],
            tools: [],
            save: async () => {},
            transport: async (t) => {
                roles.push(t.role);
                expect(
                    t.tools.some((x) => x.name === "consult_colleague"),
                ).toBe(false);
                return JSON.stringify(note(t.role));
            },
        });
        expect(roles).toEqual(["derivatives"]);
    });

    it("originates once, reviews the exact proposal revision, coalesces duplicate requests and preserves dissent", async () => {
        const views: DeskTurn[] = [];
        const receipts: DeskConsultation[] = [];
        const persisted: TradeProposal[] = [];
        await runRoundtable({
            shiftId: "selective",
            mode: "live",
            brief: { triggers: [{ kind: "market_move" }] },
            tools: [],
            save: async () => {},
            recordConsult: async (e) => {
                receipts.push(e);
            },
            saveProposal: async (d, role) => {
                const { expectedRevision, ...fields } = d;
                const p = {
                    ...fields,
                    revision: expectedRevision + 1,
                    updatedBy: role,
                    sourceShiftId: "selective",
                    updatedAt: new Date().toISOString(),
                };
                persisted.push(p);
                return p;
            },
            transport: async (t) => {
                views.push(t);
                const input = JSON.parse(t.input);
                if (input.researchQuestion) {
                    expect(t.tools.every((x) => x.access === "read")).toBe(
                        true,
                    );
                    expect(
                        t.tools.some((x) =>
                            [
                                "consult_colleague",
                                "update_trade_proposal",
                            ].includes(x.name),
                        ),
                    ).toBe(false);
                    expect(input.assignedProposal.revision).toBe(
                        persisted.at(-1)!.revision,
                    );
                } else if (t.role === "derivatives") {
                    await call(t, "update_trade_proposal", draft());
                } else if (t.role === "lead") {
                    expect(input.sharedProposals[0].updatedBy).toBe(
                        "derivatives",
                    );
                    const request = {
                        role: "execution",
                        question: "What can we fill at this size?",
                        proposalKey: "sol-basis",
                    };
                    await Promise.all([
                        call(t, "consult_colleague", request),
                        call(t, "consult_colleague", request),
                    ]);
                    await call(t, "update_trade_proposal", {
                        ...draft(),
                        expectedRevision: 1,
                        economics: "Entry costs observed; exit unbounded",
                    });
                    await call(t, "consult_colleague", request); // Same question, different proposal revision.
                    await call(t, "consult_colleague", {
                        ...request,
                        role: "risk",
                        question: "Bound the exit loss",
                    });
                    const board = (await call(t, "read_trade_proposals")) as {
                        reviews: DeskConsultation[];
                    };
                    expect(
                        board.reviews.map((r) => r.proposalRevision),
                    ).toEqual([1, 2, 2]);
                    expect(board.reviews.at(-1)!.note.dissent).toBe(
                        "Exit liquidity uncertain",
                    );
                }
                return JSON.stringify(note(t.role));
            },
        });
        expect(views.map((t) => t.role)).toEqual([
            "derivatives",
            "lead",
            "execution",
            "execution",
            "risk",
        ]);
        expect(receipts).toHaveLength(3);
        expect(views.some((t) => t.role === "catalyst")).toBe(false);
    });

    it("reuses committed reviews on restart and enforces the shared budget without recursive delegation", async () => {
        const prior: DeskConsultation[] = Array.from({ length: 5 }, (_, i) => ({
            requester: "lead",
            colleague: "risk",
            question: "Risk question " + i,
            note: note("risk"),
        }));
        const specialist = vi.fn();
        await runRoundtable({
            shiftId: "resume",
            mode: "research",
            brief: {},
            tools: [],
            consultations: prior,
            save: async () => {},
            transport: async (t) => {
                if (t.role === "lead") {
                    expect(
                        await call(t, "consult_colleague", {
                            role: "risk",
                            question: "Risk question 0",
                        }),
                    ).toHaveProperty("reused", true);
                    await call(t, "consult_colleague", {
                        role: "execution",
                        question: "Refresh the now expired quote",
                    });
                    await expect(
                        call(t, "consult_colleague", {
                            role: "catalyst",
                            question: "Another inquiry",
                        }),
                    ).rejects.toThrow("budget exhausted");
                } else specialist(t.role);
                return JSON.stringify(note(t.role));
            },
        });
        expect(specialist.mock.calls).toEqual([["execution"]]);
    });

    it("validates draft ownership, expiry, exact legs and unknown sizes", () => {
        expect(() => validateProposal(draft(), "derivatives")).not.toThrow();
        expect(() =>
            validateProposal({ ...draft(), researchPlan: [] }, "lead"),
        ).toThrow("Assign every missing");
        expect(() =>
            validateProposal({ ...draft(), status: "closed" }, "risk"),
        ).toThrow("Only the lead");
        expect(() =>
            validateProposal(
                { ...draft(), validUntil: "2020-01-01T00:00:00Z" },
                "lead",
            ),
        ).toThrow("validity");
        expect(() =>
            validateProposal(
                { ...draft(), legs: [draft().legs[0], draft().legs[0]] },
                "lead",
            ),
        ).toThrow("duplicate");
        expect(() =>
            validateProposal(
                { ...draft(), legs: [{ ...draft().legs[0], quantity: -1 }] },
                "lead",
            ),
        ).toThrow("Invalid");
    });

    it("turns a new ready task into specialist work and a second lead synthesis before checkpointing", async () => {
        const views: string[] = [],
            saved: RoleNote[] = [],
            receipts: DeskConsultation[] = [];
        let p: TradeProposal | undefined;
        await runRoundtable({
            shiftId: "work",
            mode: "research",
            brief: {},
            tools: [
                {
                    name: "order_book",
                    access: "read",
                    description: "Observed depth",
                    inputSchema: { type: "object" },
                    run: async () => ({ bidDepth: 2000 }),
                },
            ],
            save: async (_, n) => {
                saved.push(n);
            },
            recordConsult: async (c) => {
                receipts.push(c);
            },
            saveProposal: async (d, r) => {
                const { expectedRevision, ...fields } = d;
                p = {
                    ...fields,
                    revision: expectedRevision + 1,
                    updatedBy: r,
                    updatedAt: new Date().toISOString(),
                    sourceShiftId: "work",
                };
                return p;
            },
            transport: async (t) => {
                views.push(t.role);
                const input = JSON.parse(t.input);
                if (input.researchQuestion) {
                    expect(t.role).toBe("execution");
                    expect(input.assignedProposal.revision).toBe(1);
                    await call(t, "order_book");
                    return JSON.stringify(note("execution"));
                }
                if (input.researchWork.synthesis === 0) {
                    const d = draft();
                    d.researchPlan[0] = {
                        ...d.researchPlan[0],
                        status: "ready",
                        result: "",
                    };
                    await call(t, "update_trade_proposal", d);
                } else {
                    expect(
                        input.sharedProposals[0].researchPlan[0],
                    ).toMatchObject({
                        status: "review",
                        methodUsed: true,
                        assessedRevision: 1,
                    });
                    expect(input.consultations).toHaveLength(1);
                }
                return JSON.stringify({
                    ...note("lead"),
                    summary: "Synthesis " + input.researchWork.synthesis,
                });
            },
        });
        expect(views).toEqual(["lead", "execution", "lead"]);
        expect(saved.map((n) => n.summary)).toEqual(["Synthesis 1"]);
        expect(receipts[0].toolsUsed).toEqual(["order_book"]);
        expect(p!.revision).toBe(2);
    });
});

describe("proposal persistence capacity", () => {
    it("saves new ideas on a full inherited board but bounds new discovery per turn", async () => {
        const inherited = Array.from({ length: 16 }, (_, i) => ({
            ...draft(), key: `old-${i}`, revision: 1, updatedBy: "lead" as const,
            updatedAt: new Date().toISOString(), sourceShiftId: "previous",
        }));
        const saveProposal = vi.fn(async (d: ProposalDraft) => ({
            ...d, revision: d.expectedRevision + 1, updatedBy: "lead" as const,
            updatedAt: new Date().toISOString(), sourceShiftId: "capacity",
        }));
        await runRoundtable({ shiftId: "capacity", mode: "live", brief: {},
            proposals: inherited, tools: [], save: async () => {}, saveProposal,
            transport: async t => {
                for (let i = 0; i < 4; i++)
                    await call(t, "update_trade_proposal", { ...draft(), key: `fresh-${i}` });
                await expect(call(t, "update_trade_proposal", { ...draft(), key: "fifth" })).rejects.toThrow("Four new ideas");
                await call(t, "update_trade_proposal", { ...draft(), key: "old-0", expectedRevision: 1, status: "closed" });
                return JSON.stringify(note("lead"));
            },
        });
        expect(saveProposal).toHaveBeenCalledTimes(5);
    });
});

it("closes an expired plan without renewing its entry permission", () => {
    const expired = { ...draft(), status: "closed" as const, validUntil: "2020-01-02T00:00:00Z",
        setup: { strategyVersion: "continuation-1" as const, entryCondition: "Historic entry condition",
            stopPrice: 101, targetPrice: 95, holdHours: 12, riskBudgetUsd: 6.225,
            entryExpiresAt: "2020-01-01T00:00:00Z", backtestRunIds: [] } };
    expect(() => validateProposal(expired, "lead")).not.toThrow();
    expect(() => validateProposal({ ...expired, status: "candidate" }, "lead")).toThrow();
    expect(() => validateProposal(expired, "risk")).toThrow();
});
