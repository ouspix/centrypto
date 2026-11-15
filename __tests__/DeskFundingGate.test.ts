// @vitest-environment node
import {it,expect,vi} from "vitest";
import type {DeskBook,PrismaClient} from "@prisma/client";
import {FundingReadGate} from "@/lib/desk/funding-gate";
const sol="mainnet:perp:SOL";
function setup(){
    const held=vi.fn().mockResolvedValue(null),plans=vi.fn().mockResolvedValue([]);
    const db={deskInventory:{findFirst:held},deskRecord:{findMany:plans}} as unknown as PrismaClient;
    return {gate:new FundingReadGate(db,{id:"book",version:12} as DeskBook,"research"),held,plans};
}
it("requires a fresh qualifying setup without fetching eligibility data",async()=>{
    const {gate,held,plans}=setup();
    expect(await gate.check(sol,"setup_cost")).toMatchObject({status:"deferred"});
    gate.observeSetup({instrumentId:sol,qualifying:false,validUntil:Date.now()+60000});
    expect(await gate.check(sol,"setup_cost")).toMatchObject({status:"deferred"});
    gate.observeSetup({instrumentId:sol,qualifying:true,validUntil:Date.now()+60000});
    expect(await gate.check(sol,"setup_cost")).toBeNull();
    gate.observeSetup({instrumentId:sol,qualifying:true,validUntil:Date.now()-1});
    expect(await gate.check(sol,"setup_cost")).toMatchObject({status:"deferred"});
    expect(held).not.toHaveBeenCalled();expect(plans).not.toHaveBeenCalled();
});
it("allows existing position risk without an account refresh",async()=>{
    const {gate,held}=setup();
    expect(await gate.check(sol,"position_risk")).toMatchObject({status:"deferred"});
    held.mockResolvedValue({quantity:1});expect(await gate.check(sol,"position_risk")).toBeNull();
    held.mockClear();gate.observePositions([sol]);expect(await gate.check(sol,"position_risk")).toBeNull();expect(held).not.toHaveBeenCalled();
});
it("requires a live scoped carry plan with an unresolved funding question",async()=>{
    const {gate,plans}=setup();
    expect(await gate.check(sol,"carry_research")).toMatchObject({status:"deferred"});expect(plans).not.toHaveBeenCalled();
    const plan={status:"researching",validUntil:new Date(Date.now()+60000),legs:[{instrumentId:sol}],researchPlan:[{nextTool:"funding_history",status:"ready"}]};
    plans.mockResolvedValue([{dataJson:JSON.stringify(plan)}]);expect(await gate.check(sol,"carry_research","sol-carry")).toBeNull();
    for(const bad of [{...plan,status:"closed"},{...plan,legs:[]},{...plan,validUntil:new Date(0)},{...plan,researchPlan:[]}]){
        plans.mockResolvedValue([{dataJson:JSON.stringify(bad)}]);expect(await gate.check(sol,"carry_research","sol-carry")).toMatchObject({status:"deferred"});
    }
});

it("permits a concrete decision question before a setup or proposal without eligibility reads",async()=>{
    const {gate,held,plans}=setup();
    gate.observeSetup({instrumentId:sol,qualifying:false,validUntil:Date.now()+60000});
    expect(await gate.check(sol,"decision_research",undefined,"Is the funding cost material to a six-hour short?")).toBeNull();
    await expect(gate.check(sol,"decision_research")).rejects.toThrow(/question/);
    await expect(gate.check(sol,"decision_research",undefined,"   ")).rejects.toThrow(/question/);
    expect(held).not.toHaveBeenCalled();expect(plans).not.toHaveBeenCalled();
});
