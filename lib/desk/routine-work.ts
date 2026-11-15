import { fingerprint, watchCondition, watchOutcome, watchAudit, watchView, type WatchLedger } from "./watch-state";
import type { DeskBook, DeskShift, DeskWatch, Prisma } from "@prisma/client";
import { deskRoles, type DeskRole } from "./roles";

type Trigger = { kind: string; payload?: { role?: unknown; passReview?: boolean } };
type StoredBrief = { triggers?: Trigger[] };

function roleName(value: unknown): DeskRole | undefined {
    return deskRoles.find((role) => role === value);
}

/** Missing identity in pre-upgrade routine work gets one lead review. */
export function routineRecipients(brief: StoredBrief): DeskRole[] | null {
    if (!brief.triggers?.length || brief.triggers.some((t) => t.kind !== "watch" && t.kind !== "follow_up" && !(t.kind === "discovery" && t.payload?.passReview === true)))
        return null;
    const names = new Set(brief.triggers.map((t) => roleName(t.payload?.role) ?? "lead"));
    return deskRoles.filter((role) => names.has(role));
}

/** Other simultaneous reminders are independent work, not supporting evidence.
 * The role can request current portfolio state through its normal tools. */
export function routineOpening(brief: unknown, role: DeskRole): unknown {
    if (!brief || typeof brief !== "object") return brief;
    const value = brief as StoredBrief & Record<string, unknown>;
    if (!routineRecipients(value)) return brief;
    const triggers = value.triggers!.filter((t) => (roleName(t.payload?.role) ?? "lead") === role);
    return {
        book: value.book,
        network: value.network,
        mode: value.mode,
        asOf: value.asOf,
        mandate: value.mandate,
        riskPolicy: value.riskPolicy,
        roleVersion: value.roleVersion,
        routineOnly: true,
        activeRoles: [role],
        agenda: value.agenda,
        resuming: value.resuming,
        executionStatus: value.executionStatus,
        protection: value.protection,
        portfolio: value.portfolio,
        admission: value.admission,
        triggers,
        workLedger: value.workLedger,
        watches: Array.isArray(value.watches) ? value.watches.filter((w:any)=>w.owner===role) : [],
    };
}

export function canScheduleRoutine(shift: Pick<DeskShift, "briefJson">) {
    return routineRecipients(JSON.parse(shift.briefJson)) === null;
}

export type WatchRequest = Pick<DeskWatch, "kind" | "thesis" | "deadline"> &
    Partial<Pick<DeskWatch, "eventKey" | "instrumentId" | "side" | "referencePrice" | "outcomeJson" | "threshold">> &
    {proposalKey?:string; subjectKey?:string; keepAfterClosure?:boolean};

export async function requestWatch(tx:Prisma.TransactionClient,book:DeskBook,shift:DeskShift,role:DeskRole,input:WatchRequest) {
    if (input.kind !== "pass" && input.kind !== "technical" && !canScheduleRoutine(shift))
        return {watchId:null,status:"not_scheduled",reason:"A fresh desk event or operator instruction is required to schedule another review."};
    // Serialize metadata unions, including concurrent calls and journal follow-up delivery.
    if(!(await tx.deskBook.updateMany({where:{id:book.id,version:book.version},data:{updatedAt:new Date()}})).count)
        throw new Error("Book changed; watch write revoked");
    if(input.proposalKey){
        const linked=await tx.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key:`proposal:${book.version}:${shift.mode}:${input.proposalKey}`}}});
        if(!linked)return {watchId:null,status:"not_scheduled",followUpEligible:false,purpose:"proposal_required",
            proposalKey:input.proposalKey,mode:shift.mode,
            reason:"Save this proposal with update_trade_proposal in the current mode and await its receipt before set_watch. Do not retry unchanged or claim a watch exists."};
        const p=JSON.parse(linked.dataJson);
        if(input.instrumentId&&!p.legs.some((l:any)=>l.instrumentId===input.instrumentId))throw new Error("Watch instrument must belong to its linked proposal.");
        if(p.status==="closed"&&!input.keepAfterClosure){
            if(input.kind!=="pass")return {watchId:null,status:"not_scheduled",followUpEligible:false,purpose:"closed_proposal",
                reason:"Proposal is closed. Do not retry unchanged. A distinct fresh-assessment monitor requires keepAfterClosure=true and an explanation; never renew entry permission."};
            // A closed pass can still measure its outcome without reopening anything.
            input={...input,outcomeJson:JSON.stringify({...watchOutcome({outcomeJson:input.outcomeJson??null}),monitoringDisabled:true,
                retired:{action:"proposal_closed",proposalKey:input.proposalKey,at:new Date().toISOString()}})};
        }
    }
    const {proposalKey,subjectKey,keepAfterClosure,...fields}=input;
    const shape={...fields,instrumentId:input.instrumentId??null,side:input.side??null,threshold:input.threshold??null,outcomeJson:input.outcomeJson??null};
    const condition=fingerprint(watchCondition(shape));
    const rolePrefix=`routine:${role}:${book.version}:${shift.mode}:`;
    const candidates=await tx.deskWatch.findMany({where:{bookId:book.id,mode:shift.mode,kind:input.kind,status:"open",key:{startsWith:rolePrefix}},orderBy:{createdAt:"asc"}});
    const existing=candidates.find(w=>!watchOutcome(w).monitoringDisabled&&fingerprint(watchCondition(w))===condition);
    const old=existing?watchOutcome(existing):{};
    const previous=old.ledger as WatchLedger|undefined;
    const subject={id:subjectKey??fingerprint([input.thesis,input.eventKey??null,proposalKey??null]),thesis:input.thesis,eventKey:input.eventKey??null,...(proposalKey?{proposalKey}:{}),sourceShiftId:shift.id};
    const subjects=new Map((previous?.subjects??(existing?[{id:existing.id,thesis:existing.thesis,eventKey:existing.eventKey}]:[])).map(x=>[x.id,x]));
    subjects.set(subject.id,subject);
    const ledger:WatchLedger={owner:role,version:book.version,proposalKeys:[...new Set([...(previous?.proposalKeys??[]),...(proposalKey?[proposalKey]:[])])],subjects:[...subjects.values()],
        keepAfterClosure:!!(keepAfterClosure||previous?.keepAfterClosure)};
    if(existing){
        const outcomeJson=JSON.stringify({...old,ledger});
        if(outcomeJson!==existing.outcomeJson){
            await tx.deskWatch.update({where:{id:existing.id},data:{outcomeJson}});
            await watchAudit(tx,book.id,shift.id,role,"coalesced",existing,{ledger},"Same condition; retained distinct subjects and original observation.");
        }
        return {watchId:existing.id,status:"coalesced",deadline:existing.deadline.toISOString(),revision:watchView({...existing,outcomeJson}).revision,followUpEligible:watchView({...existing,outcomeJson}).followUpEligible,purpose:watchView({...existing,outcomeJson}).purpose,subjectCount:subjects.size};
    }
    const key=rolePrefix+condition.slice(0,32)+":"+shift.id;
    const row=await tx.deskWatch.upsert({where:{bookId_key:{bookId:book.id,key}},create:{...fields,bookId:book.id,key,mode:shift.mode,outcomeJson:JSON.stringify({...watchOutcome(shape),ledger})},update:{}});
    return {watchId:row.id,status:row.status,deadline:row.deadline.toISOString(),revision:watchView(row).revision,followUpEligible:watchView(row).followUpEligible,purpose:watchView(row).purpose,subjectCount:ledger.subjects.length};
}

/** Scope attribution is authoritative host metadata, never parsed from thesis text. */
export async function watchOwner(
    tx: Prisma.TransactionClient,
    watch: Pick<DeskWatch, "id" | "bookId" | "key">,
): Promise<DeskRole> {
    const fields = watch.key.split(":");
    if (fields[0] === "routine") return roleName(fields[1]) ?? "lead";
    if (fields[1] === "thesis") {
        const origin = await tx.deskRecord.findUnique({
            where: { bookId_key: { bookId: watch.bookId, key: watch.key } },
            select: { role: true },
        });
        if (origin && roleName(origin.role)) return origin.role as DeskRole;
    } else if (fields[1] === "watch") {
        const rows = await tx.deskRecord.findMany({
            where: { bookId: watch.bookId, shiftId: fields[0], kind: "tool_result", dataJson: { contains: watch.id } },
            select: { role: true, dataJson: true },
        });
        for (const row of rows) {
            const receipt = JSON.parse(row.dataJson);
            if (
                receipt.name === "set_watch" &&
                typeof receipt.result === "string" &&
                receipt.result.includes(watch.id) &&
                roleName(row.role)
            )
                return row.role as DeskRole;
        }
    }
    return "lead";
}
