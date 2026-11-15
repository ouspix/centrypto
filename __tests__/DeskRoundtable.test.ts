// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runRoundtable, type DeskTool, type DeskTransport, type RoleNote } from "@/lib/desk/roundtable";
import { type DeskRole } from "@/lib/desk/roles";
import { publicResearchTools } from "@/lib/desk/research";
import type { DeskTurn } from "@/lib/desk/runtime";

const note = (role: string): RoleNote => ({ summary: role + " handoff", thesis: "Assess the proposed catalyst", invalidation: "Official correction",
    evidenceIds: ["event:1"], dissent: role === "risk" ? "Market depth fell after the report" : "", followUpAt: null });
const tool = (access: DeskTool["access"], run: DeskTool["run"] = async () => ({})): DeskTool =>
    ({ name: access, description: "test " + access, inputSchema: { type: "object" }, access, run });
const ctx = { shiftId: "run-1", callId: "example", role: "lead" as DeskRole, signal: new AbortController().signal };

describe("desk shifts", () => {
    it.each([false, true])("limits discovery portfolio work to nominated holdings (held=%s)", async held => {
        const journal = { ...tool("journal", async a => ({ recorded: true, portfolioRecorded: true, holdingInstrumentId: a.holdingInstrumentId })), name: "record_portfolio_comparison" };
        const transport = vi.fn(async (turn: DeskTurn) => {
            const work = JSON.parse(turn.input).portfolioWork;
            if (held) {
                expect(work.missingHoldingInstrumentIds).toEqual(["A"]);
                await turn.tools.find(t => t.name === journal.name)!.run({ holdingInstrumentId: "A" }, ctx);
            } else expect(work).toBeUndefined();
            return JSON.stringify(note(turn.role));
        });
        await runRoundtable({ shiftId: "run-1", mode: "live", brief: {
            portfolio: { holdings: ["A", "B"].map(instrumentId => ({ instrumentId, quantity: 1 })) },
            triggers: [{ kind: "opportunity_scan", payload: { comparisonBrief: { candidates: [{ instrumentId: held ? "A" : "C" }] } } }],
        }, tools: [journal], transport, save: async () => {} });
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it("tracks missing holdings separately rather than accepting the first journal as full coverage", async () => {
        const journal = { ...tool("journal", async a => ({ recorded: true, portfolioRecorded: true, holdingInstrumentId: a.holdingInstrumentId })), name: "record_portfolio_comparison" };
        const transport = vi.fn(async (turn: DeskTurn) => {
            const work = JSON.parse(turn.input).portfolioWork;
            expect(work.missingHoldingInstrumentIds).toEqual(work.previousDecision ? ["B"] : ["A", "B"]);
            await turn.tools.find(t => t.name === journal.name)!.run({ holdingInstrumentId: work.previousDecision ? "B" : "A" }, ctx);
            return JSON.stringify(note(turn.role));
        });
        const result = await runRoundtable({ shiftId: "run-1", mode: "live", brief: { portfolio: { holdings: ["A", "B"].map(instrumentId => ({ instrumentId, quantity: 1 })) },
            admission: { requiredWorkOnly: true }, triggers: [{ kind: "scheduled" }] }, tools: [journal], transport, save: async () => {} });
        expect(transport).toHaveBeenCalledTimes(2); expect(result.lead?.summary).not.toContain("not recorded");
    });
    it("reuses a recent completed portfolio assessment without another holding synthesis", async () => {
        const transport = vi.fn(async (turn: DeskTurn) => { expect(JSON.parse(turn.input).portfolioWork).toBeUndefined(); return JSON.stringify(note(turn.role)); });
        await runRoundtable({ shiftId: "run-1", mode: "live", brief: { portfolio: { holdings: [{ instrumentId: "A", quantity: 1 }] }, portfolioReviewReuse: { shiftId: "previous" },
            triggers: [{ kind: "opportunity_scan", payload: {} }] }, tools: [{ ...tool("journal"), name: "record_portfolio_comparison" }], transport, save: async () => {} });
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it("records holding alternatives with at most one shared synthesis and no order requirement", async () => {
        const journal = { ...tool("journal", async () => ({ recorded: true, portfolioRecorded: true, holdingInstrumentId: "A" })), name: "record_portfolio_comparison" };
        const transport = vi.fn(async (turn: DeskTurn) => {
            const work = JSON.parse(turn.input).portfolioWork;
            expect(work).toBeDefined();
            if (work.previousDecision) await turn.tools.find(t => t.name === journal.name)!.run({}, ctx);
            return JSON.stringify(note(turn.role));
        });
        const result = await runRoundtable({ shiftId: "run-1", mode: "live", brief: { portfolio: { holdings: [{ instrumentId: "A", quantity: 1 }] },
            admission: { requiredWorkOnly: true }, triggers: [{ kind: "scheduled" }] }, tools: [journal], transport, save: async () => {} });
        expect(transport).toHaveBeenCalledTimes(2);
        expect(result.lead?.summary).not.toContain("not recorded");
    });
    it("does not demand portfolio journaling or an extra synthesis for urgent protection", async () => {
        const journal = { ...tool("journal"), name: "record_portfolio_comparison" };
        const transport = vi.fn(async (turn: DeskTurn) => {
            expect(JSON.parse(turn.input).portfolioWork).toBeUndefined();
            return JSON.stringify(note(turn.role));
        });
        await runRoundtable({ shiftId: "run-1", mode: "live", brief: { portfolio: { holdings: [{ quantity: 1 }] },
            admission: { requiredWorkOnly: true }, triggers: [{ kind: "scheduled" }, { kind: "risk", priority: 10 }] },
            tools: [journal], transport, save: async () => {} });
        expect(transport.mock.calls.filter(([t]) => t.role === "lead")).toHaveLength(1);
    });
    it("keeps required reviews focused without delaying or hiding protective tools", async () => {
        const screen = vi.fn(async () => ({})), protect = vi.fn(async () => ({}));
        const transport: DeskTransport = async turn => {
            expect(turn.tools.some(t => t.name === "screen_markets")).toBe(false);
            if (turn.role === "lead") await turn.tools.find(t => t.name === "protect_position")!.run({}, ctx);
            return JSON.stringify(note(turn.role));
        };
        await runRoundtable({ shiftId: "run-1", mode: "live", brief: { admission: { requiredWorkOnly: true },
            triggers: [{ kind: "scheduled" }, { kind: "risk" }] },
            tools: [{ ...tool("read", screen), name: "screen_markets" }, { ...tool("lead", protect), name: "protect_position" }],
            transport, save: async () => {} });
        expect(screen).not.toHaveBeenCalled(); expect(protect).toHaveBeenCalledTimes(1);
    });
    it("marks scheduled research incomplete when the lead only writes qualitative objections",async()=>{
        const transport=vi.fn(async()=>JSON.stringify(note("lead")));
        const result=await runRoundtable({shiftId:"run-1",mode:"research",brief:{triggers:[{kind:"hypothesis_research"}]},tools:[],transport,save:async()=>{}});
        expect(transport).toHaveBeenCalledTimes(2);
        expect(result.lead?.summary).toContain("test remains incomplete");
    });
    it("accepts a queued experiment without polling or granting trading authority",async()=>{
        const run=vi.fn(async()=>({runId:"job",status:"queued"}));
        const transport=vi.fn(async(turn:DeskTurn)=>{
            expect(turn.tools.some(t=>t.access==="execution")).toBe(false);
            await turn.tools.find(t=>t.name==="backtest_strategy")!.run({additionalWindows:[{start:"2026-04-02T00:00:00Z",end:"2026-04-02T06:00:00Z"},{start:"2026-04-03T00:00:00Z",end:"2026-04-03T06:00:00Z"}]},ctx);
            return JSON.stringify(note("lead"));
        });
        const result=await runRoundtable({shiftId:"run-1",mode:"research",brief:{triggers:[{kind:"hypothesis_research"}]},tools:[{...tool("read",run),name:"backtest_strategy"},tool("execution")],transport,save:async()=>{}});
        expect(transport).toHaveBeenCalledTimes(1);expect(result.lead?.summary).not.toContain("incomplete");
    });
    it("hands a consultation back to its specialist and the lead without granting trading authority", async () => {
        const views: DeskTurn[] = [];
        const transport: DeskTransport = async turn => {
            views.push(turn);
            const input = JSON.parse(turn.input);
            if (turn.role === "catalyst" && !input.researchQuestion) {
                await turn.tools.find(t => t.name === "consult_colleague")!.run({ role: "execution", question: "Price the candidate" }, ctx);
            }
            return JSON.stringify(note(turn.role));
        };
        await runRoundtable({ shiftId: "run-1", mode: "live", brief: { triggers: [{ kind: "research" }] }, tools: [tool("lead"), tool("read")],
            transport, save: async () => {} });
        for (const role of ["lead"]) {
            const primary = views.find(t => t.role === role && !JSON.parse(t.input).researchQuestion)!;
            expect(JSON.parse(primary.input).consultations).toContainEqual(expect.objectContaining({ colleague: "execution", question: "Price the candidate" }));
        }
        const consult = views.find(t => JSON.parse(t.input).researchQuestion)!;
        expect(consult.tools.some(t => t.access === "lead")).toBe(false);
        expect(views.filter(t => t.role === "execution")).toHaveLength(1);
    });
    it("works a whole shift, checkpoints pitches independently, and supplies dissent to the live lead", async () => {
        const views = new Map<DeskRole, DeskTurn>();
        const ledger: Partial<Record<DeskRole,RoleNote>> = {};
        const execute = vi.fn(async () => ({ receipt: "intent:1" }));
        const transport: DeskTransport = async turn => {
            views.set(turn.role, turn);
            if (turn.role === "lead") {
                expect(JSON.parse(turn.input).roundtable.risk.dissent).toContain("depth fell");
                expect(JSON.parse(turn.input).previousJournal).toEqual(["Review SOL before reopening"]);
                const submit = turn.tools.find(t => t.access === "lead")!;
                await submit.run({}, { ...ctx, role: "execution", shiftId: "forged" });
            }
            return JSON.stringify(note(turn.role));
        };
        const result = await runRoundtable({ shiftId: "run-1", mode: "live", brief: { triggers: [{ kind: "risk" }] },
            tools: [tool("read"), tool("journal"), tool("lead", execute), tool("execution")],
            memory: { lead: ["Review SOL before reopening"] }, transport, save: async (role, n) => { ledger[role] = n; } });
        expect(Object.keys(result).sort()).toEqual(["lead", "risk"]);
        expect(ledger).toEqual(result);
        expect(execute.mock.calls).toEqual([[{}, expect.objectContaining({ role: "lead", shiftId: "run-1" })]]);
        for (const [role, t] of views) {
            expect(t.tools.some(x => x.access === "lead")).toBe(role === "lead");
            expect(t.tools.some(x => x.access === "execution")).toBe(role === "execution");
        }
    });
    it("uses persisted checkpoints after interruption, and never exposes live tools to manual or consultant sessions", async () => {
        const ran = new Set<DeskRole>();
        const consultantRoles: DeskRole[] = [];
        const completed: Partial<Record<DeskRole,RoleNote>> = { catalyst: note("catalyst"), derivatives: note("derivatives") };
        const transport: DeskTransport = async t => {
            const input = JSON.parse(t.input);
            if (input.researchQuestion) {
                consultantRoles.push(t.role);
                expect(t.tools.every(x=>x.access === "read")).toBe(true);
            } else {
                ran.add(t.role);
                expect(t.tools.every(x => x.access === "read" || x.access === "journal")).toBe(true);
                if (t.role === "lead") {
                    const consult = t.tools.find(x => x.name === "consult_colleague")!;
                    const answer = await consult.run({ role: "catalyst", question: "What did the original issuer confirm?" }, ctx);
                    expect(answer).toHaveProperty("note.summary", "catalyst handoff");
                }
            }
            return JSON.stringify(note(t.role));
        };
        await runRoundtable({ shiftId: "run-1", mode: "research", brief: "operator research", completed, transport,
            save: async (r,n) => { completed[r]=n; }, tools: ["read","journal","lead","execution"].map(a => tool(a as DeskTool["access"])) });
        expect([...ran]).toEqual(["lead"]);
        expect(consultantRoles).toEqual(["catalyst"]);
    });
    it("does not advance the lead after a failed checkpointer or a malformed handoff", async () => {
        const transport = vi.fn(async(t:DeskTurn) => t.role === "risk" ? JSON.stringify({ ...note("risk"), followUpAt:"tomorrow" }) : JSON.stringify(note(t.role)));
        await expect(runRoundtable({ shiftId:"run-1", mode:"live", brief:{ triggers: [{ kind: "risk" }] }, tools:[], transport, save:async()=>{} })).rejects.toThrow("timezone");
        expect(transport.mock.calls.map(([t])=>t.role)).not.toContain("lead");
        transport.mockClear();
        transport.mockImplementation(async t => JSON.stringify(note(t.role)));
        await expect(runRoundtable({ shiftId:"run-1", mode:"live", brief:{ triggers: [{ kind: "risk" }] }, tools:[], transport,
            save:async()=>{throw new Error("storage unavailable");} })).rejects.toThrow("storage unavailable");
        expect(transport.mock.calls.map(([t])=>t.role)).not.toContain("lead");
    });
});

describe("public research isolation", () => {
    it("dispatches only catalog topics; returns only observed, attributable sources and reads by receipt", async () => {
        const url = "https://publisher.example/releases/1";
        const transport = vi.fn(async (turn:DeskTurn, seen:(item:Record<string,unknown>)=>void) => {
            expect(turn.tools).toEqual([]);
            expect(turn.input).not.toContain("sensitive");
            seen({action:{type:"openPage",url}});
            return JSON.stringify({sources: [url, "https://fabricated.example/story", "http://127.0.0.1/secret"].map(u=>({
                url:u, title:"Issuer statement", finding:"No deployment date", publishedAt:null,
            }))});
        });
        const tools = publicResearchTools({topics:async()=>[{id:"asset:sol",label:"Solana"}],transport});
        await expect(tools[1].run({topicId:"sensitive-account",angle:"official announcement"},ctx)).rejects.toThrow();
        const search = await tools[1].run({topicId:"asset:sol",angle:"official announcement"},ctx) as { sources: {evidenceId:string;url:string}[] };
        expect(search.sources).toHaveLength(1);
        expect(search.sources[0].url).toBe(url);
        await expect(tools[2].run({evidenceId:"https://publisher.example/?sensitive-account"},ctx)).rejects.toThrow();
        await tools[2].run({evidenceId:search.sources[0].evidenceId},ctx);
        expect(transport.mock.calls.map(([t])=>t.input)).toEqual([
            expect.stringContaining("Public research subject: Solana.\nFind current public reporting. Focus: official announcement."),
            expect.stringContaining("Public research subject: Solana.\nOpen this source and extract its dated findings: " + url),
        ]);
    });
});

describe("office activity reporting", () => {
    it("reports committed primary work and consultations with separate identities", async () => {
        const events: import("@/lib/desk/activity-types").RoleActivityEvent[] = [];
        const saved = new Set<string>();
        const tools = [tool("read")];
        const transport: DeskTransport = async turn => {
            const input = JSON.parse(turn.input);
            if (turn.role === "lead" && !input.researchQuestion) {
                await turn.tools.find(t => t.name === "consult_colleague")!.run(
                    { role: "catalyst", question: "Verify the announcement" }, ctx);
            }
            if (turn.role === "catalyst") await turn.tools[0].run({}, ctx);
            return JSON.stringify(note(turn.role));
        };
        const read = vi.fn(async () => ({})); tools[0].run = read;
        await runRoundtable({ shiftId: "office", mode: "research", brief: { triggers: [{ kind: "research" }] }, tools, transport,
            save: async role => { saved.add(role); },
            recordConsult: async () => { saved.add("consult"); },
            onActivity: async event => {
                if (event.phase === "completed") expect(saved.has(event.requester ? "consult" : event.role)).toBe(true);
                events.push(event);
            } });
        const consult = events.find(e => e.phase === "started" && e.requester === "lead")!;
        const primary = events.find(e => e.phase === "started" && e.role === "catalyst" && !e.requester)!;
        expect(consult.invocationId).not.toBe(primary.invocationId);
        expect(consult.question).toBe("Verify the announcement");
        expect(consult.parentInvocationId).toBe(events.find(e => e.role === "lead" && e.phase === "started")?.invocationId);
        expect(read).toHaveBeenCalledWith({}, expect.objectContaining({ invocationId: primary.invocationId, role: "catalyst", shiftId: "office" }));
    });
    it("keeps telemetry failures observational and reports actual turn failures", async () => {
        const completed = await runRoundtable({ shiftId: "office", mode: "research", brief: {}, tools: [],
            activeRoles: ["lead"], transport: async () => JSON.stringify(note("lead")),
            save: async () => {}, onActivity: async () => { throw new Error("telemetry unavailable"); } });
        expect(completed.lead?.summary).toBe("lead handoff");
        const events: string[] = [];
        await expect(runRoundtable({ shiftId: "office", mode: "research", brief: {}, tools: [],
            activeRoles: ["lead"], transport: async () => { throw new Error("Capacity"); },
            save: async () => {}, onActivity: async event => { events.push(event.phase); } })).rejects.toThrow("Capacity");
        expect(events).toEqual(["started", "failed"]);
    });
});

it("supplies one scan to a scheduled active lead and requests one bounded missing comparison follow-through", async () => {
    const scan = vi.fn(async () => ({ comparisonBrief: { candidates: [{ instrumentId: "A" }] } }));
    let turns = 0;
    const recordComparison = vi.fn(async () => ({ recorded: true }));
    const transport: DeskTransport = async turn => {
        turns++;
        const input = JSON.parse(turn.input);
        expect(input.opportunityScan.comparisonBrief.candidates).toHaveLength(1);
        expect(input.comparisonWork.recorded).toBe(false);
        if (turns === 2) {
            expect(input.comparisonWork.previousDecision.summary).toBe("lead handoff");
            await turn.tools.find(t => t.name === "record_candidate_comparison")!.run({}, ctx);
        }
        return JSON.stringify(note("lead"));
    };
    const result = await runRoundtable({ shiftId: "comparison", mode: "live", activeRoles: ["lead"],
        brief: { triggers: [{ kind: "scheduled" }] },
        tools: [{ ...tool("read", scan), name: "screen_markets" }, { ...tool("journal", recordComparison), name: "record_candidate_comparison" }],
        transport, save: async () => {} });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(turns).toBe(2);
    expect(result.lead?.summary).toBe("lead handoff");
});
it("keeps missed-fill reviews focused rather than imposing a new discovery comparison", async () => {
    const scan = vi.fn(async () => ({}));
    const transport = vi.fn(async (turn: DeskTurn) => {
        expect(JSON.parse(turn.input).comparisonWork).toBeUndefined();
        return JSON.stringify(note("lead"));
    });
    await runRoundtable({ shiftId: "recovery", mode: "live", activeRoles: ["lead"], brief: { triggers: [{ kind: "missed_fill" }] },
        tools: [{ ...tool("read", scan), name: "screen_markets" }, { ...tool("journal"), name: "record_candidate_comparison" }], transport, save: async () => {} });
    expect(scan).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
});


it.each([true, false])("routes a freshly reconciled exit to the lead once, retaining execution for uncertainty (fresh=%s)", async fresh => {
    const roles: string[] = [];
    const now = Date.now();
    const protection = { status: "observed", validUntil: new Date(now + (fresh ? 30000 : -1)).toISOString(),
        flatPositions: [{ instrumentId: "mainnet:perp:ETH", noVenueOrders: true }] };
    await runRoundtable({ shiftId: "verified-exit", mode: "live", tools: [],
        brief: { protection, triggers: [{ kind: "fill", payload: { instrumentId: "mainnet:perp:ETH" } }] },
        save: async () => {}, transport: async turn => { roles.push(turn.role); return JSON.stringify(note(turn.role)); } });
    expect(roles).toEqual(fresh ? ["lead"] : ["execution", "lead"]);
});

it.each([false, true])("supplies current policy and reconciliation to each role without strategy-profile tool calls (routine=%s)", async routine => {
    let revision = 0;
    const profileTool = { ...tool("read", vi.fn()), name: "strategy_profile" };
    const seen: number[] = [];
    await runRoundtable({ shiftId: "policy-brief", mode: "research", tools: [profileTool],
        ...(routine ? { activeRoles: ["execution", "lead"] as DeskRole[] } : {}),
        brief: { triggers: [{ kind: "fill", payload: {} }] },
        refreshContext: async () => ({ strategyProfile: { bookVersion: ++revision }, protection: { revision } }),
        save: async () => {}, transport: async turn => {
            const opening = JSON.parse(turn.input).openingBrief;
            seen.push(opening.strategyProfile.bookVersion);
            expect(opening.protection.revision).toBe(revision);
            expect(turn.instructions).toContain("Use it directly");
            return JSON.stringify(note(turn.role));
        } });
    expect(seen).toEqual([1, 2]);
    expect(profileTool.run).not.toHaveBeenCalled();
});
