import type { DeskBook, PrismaClient } from "@prisma/client";
import type { TradeProposal } from "./proposals";

export const fundingPurpose = {type:"string",enum:["decision_research","setup_cost","carry_research","position_risk"]};
export type FundingSetup = {instrumentId:string; qualifying:boolean; validUntil:number};

/** Eligibility uses existing observations or local records, never new market/account reads. */
export class FundingReadGate {
  private setups = new Map<string,FundingSetup>();
  private observedPositions = new Set<string>();
  private positionsUntil = 0;
  observeSetup(setup:FundingSetup) { this.setups.set(setup.instrumentId,setup); }
  observePositions(ids:string[]) { this.observedPositions = new Set(ids); this.positionsUntil=Date.now()+5000; }
  constructor(private db:PrismaClient, private book:DeskBook, private mode:string) {}
  async check(instrumentId:string,purpose:unknown,proposalKey?:unknown,question?:unknown) {
    if(purpose === "decision_research") {
      if(typeof question!=="string" || question.trim().length<10 || question.length>1000)throw new Error("State the concrete funding/positioning question in 10-1000 characters.");
      return null;
    }
    if(purpose === "setup_cost") {
      const setup=this.setups.get(instrumentId);
      if(setup?.qualifying && setup.validUntil>Date.now())return null;
      return {status:"deferred",reason:"No fresh qualifying continuation reference setup was observed. For a discretionary funding/positioning question use purpose=decision_research with the concrete question; no candle qualification is required."};
    }
    if(purpose === "position_risk") {
      if(this.positionsUntil>Date.now() && this.observedPositions.has(instrumentId))return null;
      const held=await this.db.deskInventory.findFirst({where:{bookId:this.book.id,instrumentId,quantity:{not:0}}});
      if(held)return null;
      return {status:"deferred",reason:"No owned or already-observed account position needs funding risk assessment. Do not fetch account data merely to unlock this tool."};
    }
    if(purpose === "carry_research") {
      if(typeof proposalKey === "string") {
        const keys=[`proposal:${this.book.version}:${this.mode}:${proposalKey}`,
          `proposal:${this.book.version}:live:${proposalKey}`];
        const rows=await this.db.deskRecord.findMany({where:{bookId:this.book.id,kind:"trade_proposal",key:{in:keys}}});
        const plans=rows.map(r=>JSON.parse(r.dataJson) as TradeProposal);
        if(plans.some(p=>p.status!=="closed" && Date.parse(p.validUntil)>Date.now() &&
          p.legs.some(l=>l.instrumentId===instrumentId) &&
          p.researchPlan?.some(t=>["funding_and_basis","funding_history"].includes(t.nextTool) &&
            ["ready","review"].includes(t.status))))return null;
      }
      return {status:"deferred",reason:"Carry research needs proposalKey for an open, unexpired idea with this leg and an unresolved funding research task. State the carry mechanism and hypothesis first."};
    }
    throw new Error("Choose purpose=decision_research, setup_cost, carry_research or position_risk.");
  }
}
