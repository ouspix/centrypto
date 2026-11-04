// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runRoundtable, type DeskTool, type DeskTransport, type RoleNote } from "@/lib/desk/roundtable";
import { deskRoles, type DeskRole } from "@/lib/desk/roles";
import { publicResearchTools } from "@/lib/desk/research";
import type { DeskTurn } from "@/lib/desk/runtime";

const note = (role: string): RoleNote => ({ summary: role + " handoff", thesis: "Assess the proposed catalyst", invalidation: "Official correction",
    evidenceIds: ["event:1"], dissent: role === "risk" ? "Market depth fell after the report" : "", followUpAt: null });
const tool = (access: DeskTool["access"], run: DeskTool["run"] = async () => ({})): DeskTool =>
    ({ name: access, description: "test " + access, inputSchema: { type: "object" }, access, run });
const ctx = { shiftId: "run-1", callId: "example", role: "lead" as DeskRole, signal: new AbortController().signal };

describe("desk shifts", () => {
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
        const result = await runRoundtable({ shiftId: "run-1", mode: "live", brief: { wake: "delisting" },
            tools: [tool("read"), tool("journal"), tool("lead", execute), tool("execution")],
            memory: { lead: ["Review SOL before reopening"] }, transport, save: async (role, n) => { ledger[role] = n; } });
        expect(Object.keys(result).sort()).toEqual([...deskRoles].sort());
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
                expect(t.tools.map(x=>x.access)).toEqual(["read"]);
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
        expect([...ran].sort()).toEqual(["execution","lead","risk"]);
        expect(consultantRoles).toEqual(["catalyst"]);
    });
    it("does not advance the lead after a failed checkpointer or a malformed handoff", async () => {
        const transport = vi.fn(async(t:DeskTurn) => t.role === "risk" ? JSON.stringify({ ...note("risk"), followUpAt:"tomorrow" }) : JSON.stringify(note(t.role)));
        await expect(runRoundtable({ shiftId:"run-1", mode:"live", brief:"fill", tools:[], transport, save:async()=>{} })).rejects.toThrow("timezone");
        expect(transport.mock.calls.map(([t])=>t.role)).not.toContain("lead");
        transport.mockClear();
        await expect(runRoundtable({ shiftId:"run-1", mode:"live", brief:"fill", tools:[], transport,
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
            "Find current public reporting on Solana. Focus: official announcement.",
            "Open this source and extract its dated findings: " + url,
        ]);
    });
});
