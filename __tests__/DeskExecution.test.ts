// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient, type DeskBook } from "@prisma/client";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeskExecution } from "@/lib/desk/execution";
import { DEFAULT_DESK_MANDATE, SWING_DESK_MANDATE } from "@/lib/desk/mandate";
import { nativeInstruments } from "@/lib/desk/instruments";
import type {
    DeskAccount,
    DeskOrder,
    DeskVenue,
    ExchangeFill,
    SignedAction,
    VenueStatus,
} from "@/lib/desk/execution-types";
import { positionKey } from "@/lib/desk/execution-types";
import { reviewedProposal } from "./fixtures/allocation-review";

const instruments = nativeInstruments(true, [{ name: "kPEPE", szDecimals: 2 }], {
    tokens: [
        { index: 0, name: "USDC", szDecimals: 2, tokenId: "usdc" },
        { index: 4, name: "PEPE", szDecimals: 2, tokenId: "pepe" },
        { index: 7, name: "TEST", szDecimals: 2, tokenId: "test" },
    ],
    universe: [
        { tokens: [4, 0], index: 3, name: "@3" },
        { tokens: [7, 4], index: 8, name: "@8" },
    ],
});
const [perp, spot] = instruments;
const buy = (s = perp): DeskOrder => ({
    instrumentId: s.id,
    side: "buy",
    quantity: 2,
    limitPrice: 100.05,
    stopPrice: 98,
    thesis: "Verified change in token supply",
    eventId: "supply:1",
});
async function saveAllocation(db: PrismaClient, book: DeskBook, order: DeskOrder) {
    if (order.strategyVersion !== "desk-discretionary-1") return;
    await db.deskRecord.create({ data: { bookId: book.id, key: `proposal:${book.version}:live:${order.proposalKey}`,
        kind: "trade_proposal", role: "lead", dataJson: JSON.stringify(reviewedProposal(order)) } });
}
const mandate = {
    ...DEFAULT_DESK_MANDATE,
    capitalUsd: 4000,
    maxOrderUsd: 500,
    maxInstrumentUsd: 900,
    maxRiskPerTradeUsd: 500,
    maxDailyLossUsd: 750,
    minDepthUsd: 1000,
};
type WireOrder = {
    a: number;
    b: boolean;
    p: string;
    s: string;
    c: string;
    t: { limit?: { tif: string }; trigger?: { triggerPx: string; tpsl: string } };
};
class Fixture {
    pos = new Map<string, number>();
    open: DeskAccount["openOrders"] = [];
    statuses = new Map<string | number, VenueStatus>();
    fills: ExchangeFill[] = [];
    actions: SignedAction[] = [];
    partial = false;
    partialStatus = "canceled";
    withholdFills = false;
    fillQueries:number[] = [];
    loseAcknowledgement = false;
    stale = false;
    rejectGuard = false;
    beforeSign?: () => Promise<void>;
    rejectSecond = false;
    bid = 100;
    ask = 100.04;
    fund: { time: number; hash: string; delta: { coin: string; usdc: string; szi: string } }[] = [];
    venue: DeskVenue = {
        instruments: async () => instruments,
        account: async () => ({
            positions: this.pos,
            freeSpot: new Map([
                [0, 5000],
                [4, this.pos.get(positionKey(spot)) ?? 0],
            ]),
            marks: new Map(instruments.map((i) => [i.id, (this.bid + this.ask) / 2])),
            tokenUsd: new Map([
                [0, 1],
                [4, (this.bid + this.ask) / 2],
            ]),
            openOrders: this.open,
            equity: 5000,
            grossUsd: [...this.pos.values()].reduce((s, q) => s + Math.abs(q) * this.ask, 0),
            rollingPnl: 0,
        }),
        book: async () => ({
            time: Date.now() - (this.stale ? 6000 : 0),
            levels: [[{ px: String(this.bid), sz: "1000" }], [{ px: String(this.ask), sz: "1000" }]],
        }),
        fills: async (b, s, e) => {this.fillQueries.push(s);return this.withholdFills?[]:this.fills.filter((f) => f.time >= s && f.time <= e);},
        funding: async () => this.fund,
        status: async (b, id) => this.statuses.get(id) ?? null,
        write: async (b, a, n, authorize, onDispatch) => {
            if (this.beforeSign) await this.beforeSign();
            await authorize();
            onDispatch();
            this.actions.push(a);
            if (a.type === "scheduleCancel") return { status: "ok", response: { type: "default" } };
            if (a.type === "cancelByCloid") {
                for (const x of a.cancels as { cloid: string }[]) {
                    this.open = this.open.filter((o) => o.cloid !== x.cloid);
                    const o = this.statuses.get(x.cloid);
                    if (o) o.status = "canceled";
                }
                return { status: "ok", response: { data: { statuses: ["success"] } } };
            }
            const [w] = a.orders as WireOrder[],
                i = instruments.find((i) => i.asset === w.a)!;
            if (this.rejectSecond && i.kind === "perp")
                return { status: "ok", response: { data: { statuses: [{ error: "second leg rejected" }] } } };
            if (w.t.trigger) {
                if (this.rejectGuard)
                    return { status: "ok", response: { data: { statuses: [{ error: "guard rejected" }] } } };
                const oid = 100000 + this.actions.length;
                this.open.push({
                    coin: i.coin,
                    oid,
                    cloid: w.c,
                    side: w.b ? "B" : "A",
                    sz: w.s,
                    limitPx: w.p,
                    triggerPx: w.t.trigger.triggerPx,
                    reduceOnly: true,
                    isTrigger: true,
                });
                this.statuses.set(w.c, { oid: String(oid), status: "open", cloid: w.c,originalQuantity:+w.s,remainingQuantity:+w.s,statusTimestamp:Date.now(),coin:i.coin,side:w.b?"B":"A" });
                return { status: "ok", response: { data: { statuses: [{ resting: { oid } }] } } };
            }
            const oid = this.actions.length + 100,
                alo = !!w.t.limit && w.t.limit.tif === "Alo",
                quantity = +w.s * (this.partial ? 0.5 : 1);
            const status = {
                oid: String(oid),
                cloid: w.c,
                status: alo ? "open" : this.partial ? this.partialStatus : "filled",
                originalQuantity:+w.s,remainingQuantity:alo?+w.s:+w.s-quantity,statusTimestamp:Date.now(),coin:i.coin,side:(w.b?"B":"A") as "B"|"A",
            };
            this.statuses.set(w.c, status);
            this.statuses.set(oid, status);
            if (alo) this.open.push({ coin: i.coin, oid, cloid: w.c, side: w.b ? "B" : "A", sz: w.s, limitPx: w.p });
            else {
                this.pos.set(positionKey(i), (this.pos.get(positionKey(i)) ?? 0) + (w.b ? 1 : -1) * quantity);
                if (i.kind === "spot" && i.quoteTokenIndex !== 0) {
                    const quoteKey = "spot:" + i.quoteTokenIndex;
                    this.pos.set(
                        quoteKey,
                        (this.pos.get(quoteKey) ?? 0) - (w.b ? 1 : -1) * quantity * (w.b ? this.ask : this.bid),
                    );
                }
                this.fills.push({
                    coin: i.coin,
                    time: Date.now(),
                    oid,
                    tid: oid,
                    px: String(w.b ? this.ask : this.bid),
                    sz: String(quantity),
                    side: w.b ? "B" : "A",
                    fee: "0.03",
                    feeToken: "USDC",
                    closedPnl: "0",
                    hash: "fill" + oid,
                });
            }
            if (this.loseAcknowledgement) {
                this.loseAcknowledgement = false;
                throw new Error("Connection lost after exchange acceptance");
            }
            return {
                status: "ok",
                response: { data: { statuses: [alo ? { resting: { oid } } : { filled: { oid } }] } },
            };
        },
    };
}
let dir: string, db: PrismaClient, book: DeskBook, fixture: Fixture, engine: DeskExecution;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "centrypto-execution-test-"));
    db = new PrismaClient({ datasources: { db: { url: "file:" + path.join(dir, "db.sqlite") } } });
    const paths = [
        "prisma/migrations/20261102000000_desk_books/migration.sql",
        "prisma/migrations/20261102010000_desk_execution/migration.sql",
        "prisma/migrations/20261113110000_order_leverage_snapshots/migration.sql",
    ];
    for (const p of paths) {
        const src = await fs.readFile(p, "utf8");
        for (const s of src
            .split("-- SQLite arbitrates")[0]
            .replace(/^--.*$/gm, "")
            .split(";")
            .filter((s) => s.trim()))
            await db.$executeRawUnsafe(s);
    }
    await db.$executeRawUnsafe(
        "CREATE TABLE WalletRiskControl (id TEXT PRIMARY KEY, userAddress TEXT,isTestnet BOOLEAN,killSwitch BOOLEAN,createdAt DATETIME, updatedAt DATETIME)",
    );
    book = await db.deskBook.create({
        data: {
            ownerAddress: "0xmaster",
            accountAddress: "0xmaster",
            enabled: true,
            isTestnet: true,
            mandateJson: JSON.stringify(mandate),
            kind: "directional",
        },
    });
    fixture = new Fixture();
    engine = new DeskExecution(db, fixture.venue);
});
afterEach(async () => {
    await db.$disconnect();
    await fs.rm(dir, { recursive: true, force: true });
});
describe("autonomous desk execution", () => {
    it("requires an allocation for preview and submission, persists its origin, and leaves reductions available", async () => {
        const order = { ...buy(), strategyVersion: "desk-discretionary-1", proposalKey: "allocation-test", maxHoldHours: 2,
            entryExpiresAt: new Date(Date.now() + 60000).toISOString() };
        await db.deskRecord.create({ data: { bookId: book.id, key: "strategy-rollout:desk-discretionary-1", kind: "strategy_rollout", role: "operator", dataJson: JSON.stringify({ state: "active" }) } });
        await expect(engine.preview(book.id, order)).rejects.toThrow(/current live/);
        await expect(engine.execute(book.id, "missing-allocation", order)).rejects.toThrow(/current live/);
        expect(fixture.actions).toHaveLength(0);
        await saveAllocation(db, book, order);
        const entry = await engine.execute(book.id, "reviewed-entry", order);
        await engine.reconcile(book.id);
        const receipt = await db.deskRecord.findUniqueOrThrow({ where: { bookId_key: { bookId: book.id, key: `entry-allocation:${entry.id}` } } });
        expect(JSON.parse(receipt.dataJson)).toMatchObject({ intentId: entry.id, proposalRevision: 1, allocation: { version: "allocation-1", theme: { family: "recovery" } } });
        await db.deskRecord.delete({ where: { bookId_key: { bookId: book.id, key: `proposal:${book.version}:live:${order.proposalKey}` } } });
        await engine.execute(book.id, "reviewed-entry", order); // idempotent despite a subsequently removed plan
        expect(fixture.actions).toHaveLength(1);
        await engine.execute(book.id, "reduce", { instrumentId: perp.id, side: "sell", quantity: 2, limitPrice: 100,
            reduceOnly: true, thesis: "Emergency reduction remains available without an allocation review" });
        await engine.reconcile(book.id);
        expect(fixture.pos.get(positionKey(perp))).toBe(0);
        expect((await db.deskRecord.findUniqueOrThrow({ where: { id: receipt.id } })).dataJson).toBe(receipt.dataJson);
    });
    it("rechecks the reviewed proposal before signing and never silently adopts a revised assessment", async () => {
        const order = { ...buy(), strategyVersion: "desk-discretionary-1", proposalKey: "changed-allocation", maxHoldHours: 2,
            entryExpiresAt: new Date(Date.now() + 60000).toISOString() };
        await saveAllocation(db, book, order);
        await db.deskRecord.create({ data: { bookId: book.id, key: "strategy-rollout:desk-discretionary-1", kind: "strategy_rollout", role: "operator", dataJson: JSON.stringify({ state: "active" }) } });
        fixture.beforeSign = async () => {
            const changed = reviewedProposal(order); changed.revision = 2;
            await db.deskRecord.update({ where: { bookId_key: { bookId: book.id, key: `proposal:${book.version}:live:${order.proposalKey}` } }, data: { dataJson: JSON.stringify(changed) } });
        };
        const result = await engine.execute(book.id, "changed-before-signing", order);
        expect(result.state).toBe("rejected");
        expect(fixture.actions).toHaveLength(0);
    });
    it("records perp leverage before submitting and attaches the acknowledged order ID", async () => {
        fixture.venue.orderLeverage = async () => ({ type: "cross", value: 5 });
        fixture.beforeSign = async () => {
            expect(await db.orderLeverageSnapshot.count({ where: { accountAddress: book.accountAddress } })).toBe(2);
        };

        const intent = await engine.execute(book.id, "leverage", buy());
        expect(intent.oid).toBeTruthy();
        const rows = await db.orderLeverageSnapshot.findMany({ where: { accountAddress: book.accountAddress } });
        expect(rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ cloid: intent.cloid, oid: intent.oid, leverage: 5, marginMode: "cross" }),
            expect.objectContaining({ cloid: intent.stopCloid, leverage: 5 }),
        ]));
    });

    async function absentIntent(reason = "Exchange exchange HTTP 422") {
        return db.deskIntent.create({ data: {
            bookId: book.id, intentKey: "expired-422", cloid: "entry-422", stopCloid: "stop-422",
            instrumentId: perp.id, asset: perp.asset, coin: perp.coin, side: "sell",
            quantity: 2, limitPrice: 100, arrivalPrice: 100, reservedUsd: 200, fingerprint: "test",
            policyVersion: book.version, state: "unknown", reason,
            createdAt: new Date(Date.now() - 600_000),
            requestJson: JSON.stringify({ strategyVersion: "desk-discretionary-1", reduceOnly: false,
                entryExpiresAt: new Date(Date.now() - 300_000).toISOString() }),
        } });
    }
    async function ageAbsence(id: string) {
        await db.deskRecord.update({ where: { bookId_key: { bookId: book.id, key: "submission-absence:" + id } },
            data: { dataJson: JSON.stringify({ checkedAt: new Date(Date.now() - 61_000).toISOString() }) } });
    }
    it("serializes actual entry and protective prices without toFixed binary tails", async () => {
        fixture.bid = 560.3; fixture.ask = 560.31;
        await engine.execute(book.id, "xmr-prices", { ...buy(), side: "sell", quantity: 0.46,
            limitPrice: 560.3, stopPrice: 570.56 });
        const orders = fixture.actions[0].orders as WireOrder[];
        expect(orders[0].p).toBe("560.3");
        expect(orders[1].p).toBe("570.56");
        expect(orders[1].t.trigger?.triggerPx).toBe("570.56");
    });
    it("releases an expired HTTP 422 only after two complete absence checks, without sending an order", async () => {
        const row = await absentIntent();
        await engine.reconcile(book.id);
        expect((await db.deskIntent.findUniqueOrThrow({ where: { id: row.id } })).state).toBe("unknown");
        await engine.reconcile(book.id); // a rapid repeat is insufficient
        expect((await db.deskIntent.findUniqueOrThrow({ where: { id: row.id } })).reservedUsd).toBe(200);
        await ageAbsence(row.id);
        await engine.reconcile(book.id);
        const done = await db.deskIntent.findUniqueOrThrow({ where: { id: row.id } });
        expect(done.state).toBe("abandoned"); expect(done.reservedUsd).toBe(0);
        expect(fixture.fillQueries).toContain(row.createdAt.getTime() - 120_000);
        expect(fixture.actions).toHaveLength(0);
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "order_reconciliation" } })).toBe(1);
        await engine.reconcile(book.id);
        expect(await db.deskRecord.count({ where: { bookId: book.id, kind: "order_reconciliation" } })).toBe(1);
    });
    it.each(["timeout", "unexpired", "partial", "child", "position", "fill", "open", "read_failure"])(
        "retains uncertainty for %s evidence and never retries", async (condition) => {
            const row = await absentIntent(condition === "timeout" ? "Request timed out" : undefined);
            if (condition !== "timeout") { await engine.reconcile(book.id); await ageAbsence(row.id); }
            if (condition === "unexpired") await db.deskIntent.update({ where: { id: row.id }, data: {
                requestJson: JSON.stringify({ strategyVersion: "desk-discretionary-1", entryExpiresAt: new Date(Date.now() + 60_000).toISOString() }) } });
            if (condition === "partial") await db.deskIntent.update({ where: { id: row.id }, data: { filledQty: 0.5 } });
            if (condition === "child") fixture.statuses.set("stop-422", { oid: "123", status: "open" });
            if (condition === "position") fixture.pos.set(positionKey(perp), 1);
            if (condition === "fill") fixture.fills.push({ coin: perp.coin, oid: 432, tid: 1,
                time: row.createdAt.getTime() + 1000, px: "100", sz: "1", side: "A", fee: "0", closedPnl: "0", hash: "old-fill" });
            if (condition === "open") fixture.open.push({ coin: perp.coin, oid: 123, side: "A", sz: "1", limitPx: "100" });
            if (condition === "read_failure") fixture.venue.fills = async () => { throw new Error("Unavailable fills"); };
            if (condition === "read_failure") await expect(engine.reconcile(book.id)).rejects.toThrow("Unavailable fills");
            else await engine.reconcile(book.id);
            const current = await db.deskIntent.findUniqueOrThrow({ where: { id: row.id } });
            expect(current.state).toBe("unknown"); expect(current.reservedUsd).toBe(200);
            expect(fixture.actions).toHaveLength(0);
        },
    );
    it("blocks the unvalidated news family even if a rollout row claims it is active", async () => {
        await db.deskRecord.create({ data: { bookId: book.id, key: "strategy-rollout:news-momentum-1",
            kind: "strategy_rollout", role: "operator", dataJson: JSON.stringify({ state: "active" }) } });
        const order = { ...buy(), strategyVersion: "news-momentum-1", proposalKey: "news-test",
            maxHoldHours: 2, entryExpiresAt: new Date(Date.now() + 60_000).toISOString() };
        await expect(engine.preview(book.id, order)).rejects.toThrow(/implementation-only/);
        await expect(engine.execute(book.id, "news-test", order)).rejects.toThrow(/implementation-only/);
        expect(fixture.actions).toHaveLength(0);
        expect(await db.deskIntent.count({ where: { bookId: book.id } })).toBe(0);
    });
    it.each(["continuation-1","desk-discretionary-1"])("keeps %s entries research-only and rejects expired plans before signing",async(strategyVersion)=>{
        await db.deskBook.update({where:{id:book.id},data:{mandateJson:JSON.stringify(SWING_DESK_MANDATE)}});
        const plan={...buy(),strategyVersion,proposalKey:"pullback-test",maxHoldHours:2,entryExpiresAt:new Date(Date.now()+3600000).toISOString()};
        await saveAllocation(db, book, plan);
        await expect(engine.execute(book.id,"research-only",plan)).rejects.toThrow(/research-only/);
        await expect(engine.execute(book.id,"old-plan",{...plan,entryExpiresAt:new Date(Date.now()-1000).toISOString()})).rejects.toThrow(/expired/);
        expect(fixture.actions).toHaveLength(0);
    });
    it.each(["continuation-1","desk-discretionary-1"])("rechecks %s activation immediately before signing",async(strategyVersion)=>{
        await db.deskBook.update({where:{id:book.id},data:{mandateJson:JSON.stringify(SWING_DESK_MANDATE)}});
        const rollout=await db.deskRecord.create({data:{bookId:book.id,key:`strategy-rollout:${strategyVersion}`,kind:"strategy_rollout",role:"operator",dataJson:JSON.stringify({state:"active"})}});
        fixture.beforeSign=async()=>{await db.deskRecord.update({where:{id:rollout.id},data:{dataJson:JSON.stringify({state:"research_only"})}});};
        const order={...buy(),strategyVersion,proposalKey:"pullback-test",maxHoldHours:2,entryExpiresAt:new Date(Date.now()+3600000).toISOString()};
        await saveAllocation(db, book, order);
        const result=await engine.execute(book.id,"activation-revoked",order);
        expect(result.state).toBe("rejected");expect(fixture.actions).toHaveLength(0);
    });
    it.each(["continuation-1","desk-discretionary-1"])("persists %s fill-time horizon and performs only a reducing time exit after restart while stopped",async(strategyVersion)=>{
        await db.deskBook.update({where:{id:book.id},data:{mandateJson:JSON.stringify(SWING_DESK_MANDATE)}});
        await db.deskRecord.create({data:{bookId:book.id,key:`strategy-rollout:${strategyVersion}`,kind:"strategy_rollout",role:"operator",dataJson:JSON.stringify({state:"active"})}});
        const plan={...buy(),strategyVersion,proposalKey:"pullback-test",maxHoldHours:2,entryExpiresAt:new Date(Date.now()+3600000).toISOString()};
        await saveAllocation(db, book, plan);
        await engine.execute(book.id,"planned-entry",plan);await engine.reconcile(book.id);
        const row=await db.deskRecord.findUniqueOrThrow({where:{bookId_key:{bookId:book.id,key:`position-plan:${perp.id}`}}});
        const value=JSON.parse(row.dataJson);expect(Date.parse(value.maxHoldUntil)-Date.parse(value.openedAt)).toBe(7200000);
        await db.deskRecord.update({where:{id:row.id},data:{dataJson:JSON.stringify({...value,maxHoldUntil:new Date(Date.now()-1000).toISOString()})}});
        await db.deskBook.update({where:{id:book.id},data:{enabled:false}});
        engine=new DeskExecution(db,fixture.venue);await engine.tick(book.id);await engine.reconcile(book.id);
        expect(fixture.pos.get(positionKey(perp))).toBe(0);
        expect((await engine.state(book.id)).inventory[0].quantity).toBe(0);
    });
    it("reconciles an uncertain partial meme fill on restart, attributes fees and never resubmits the same intent", async () => {
        fixture.partial = true;
        fixture.loseAcknowledgement = true;
        const order = buy();
        const result = await engine.execute(book.id, "open-meme", order);
        expect(result.state).toBe("unknown");
        engine = new DeskExecution(db, fixture.venue);
        await engine.reconcile(book.id);
        await engine.execute(book.id, "open-meme", order);
        await engine.reconcile(book.id);
        const state = await engine.state(book.id);
        expect(state.intents[0].filledQty).toBe(1);
        expect(state.inventory[0].quantity).toBe(1);
        expect(state.fills).toHaveLength(1);
        expect(state.fills[0].feeUsd).toBe(0.03);
        expect(state.intents[0].requestJson).toContain("supply:1");
        expect(fixture.actions).toHaveLength(1);
    });
    it("settles terminal partial IOC fills, preserving original quantity and both live protections",async()=>{
        fixture.partial=true;fixture.partialStatus="filled";
        const entry=await engine.execute(book.id,"partial-ioc",{...buy(),takeProfitPrice:104});
        await engine.tick(book.id);
        const done=await db.deskIntent.findUniqueOrThrow({where:{id:entry.id}});
        expect(done).toMatchObject({quantity:2,filledQty:1,state:"filled",reservedUsd:0});
        expect(fixture.open.map(o=>[o.oid,o.sz,o.triggerPx,o.reduceOnly])).toHaveLength(2);
        const protections=structuredClone(fixture.open),actions=fixture.actions.length;
        await engine.reconcile(book.id);await engine.tick(book.id);
        expect(fixture.open).toEqual(protections);expect(fixture.actions).toHaveLength(actions);
        expect(await db.deskCashFlow.count()).toBe(1);
        expect((await engine.execute(book.id,"partial-ioc",{...buy(),takeProfitPrice:104})).id).toBe(entry.id);
        expect(fixture.actions).toHaveLength(actions);
    });
    it("retains reservations until delayed terminal fills are journaled and recovers beyond the rolling window",async()=>{
        fixture.partial=true;fixture.partialStatus="filled";fixture.withholdFills=true;
        const entry=await engine.execute(book.id,"delayed-partial",buy());
        await engine.reconcile(book.id);
        expect(await db.deskIntent.findUniqueOrThrow({where:{id:entry.id}})).toMatchObject({state:"settling",filledQty:0,reservedUsd:expect.any(Number)});
        expect((await db.deskIntent.findUniqueOrThrow({where:{id:entry.id}})).reservedUsd).toBeGreaterThan(0);
        const old=Date.now()-600000;
        await db.deskBook.update({where:{id:book.id},data:{createdAt:new Date(old-10000)}});
        await db.deskIntent.update({where:{id:entry.id},data:{createdAt:new Date(old)}});
        fixture.fills[0].time=old+1000;fixture.statuses.get(entry.cloid)!.statusTimestamp=old+1000;fixture.withholdFills=false;
        await engine.reconcile(book.id);
        expect(fixture.fillQueries.some(s=>s<=old)).toBe(true);
        expect(await db.deskIntent.findUniqueOrThrow({where:{id:entry.id}})).toMatchObject({state:"filled",filledQty:1,reservedUsd:0});
        const queries=fixture.fillQueries.length;await engine.reconcile(book.id);
        expect(fixture.fillQueries.length-queries).toBe(1);expect(await db.deskCashFlow.count()).toBe(1);
    });
    it("does not release a terminal reservation with contradictory live orders or an unknown venue state",async()=>{
        fixture.partial=true;fixture.partialStatus="filled";
        const entry=await engine.execute(book.id,"contradiction",buy());
        fixture.open.push({coin:perp.coin,oid:Number(entry.oid),cloid:entry.cloid,side:"B",sz:"1",limitPx:"100.05"});
        await engine.reconcile(book.id);
        expect((await db.deskIntent.findUniqueOrThrow({where:{id:entry.id}})).reservedUsd).toBeGreaterThan(0);
        fixture.open=[];fixture.statuses.get(entry.cloid)!.status="future_unknown_state";
        await engine.reconcile(book.id);
        expect(await db.deskIntent.findUniqueOrThrow({where:{id:entry.id}})).toMatchObject({state:"unknown",reservedUsd:expect.any(Number)});
        expect((await db.deskIntent.findUniqueOrThrow({where:{id:entry.id}})).reservedUsd).toBeGreaterThan(0);
    });
    it.each(["repair", "foreign-position", "foreign-order", "other-suspension", "missing-close-flow"])(
        "reconciles a suspended flat close only with complete proof (%s)", async condition => {
            await engine.execute(book.id, "entry", buy());
            await engine.reconcile(book.id);
            const close = await engine.execute(book.id, "close", { ...buy(), side: "sell", stopPrice: undefined, limitPrice: 100, reduceOnly: true });
            await engine.reconcile(book.id);
            const inv = await db.deskInventory.findFirstOrThrow({where:{bookId:book.id,instrumentId:perp.id}});
            expect(inv.quantity).toBe(0);
            await db.deskIntent.update({where:{id:close.id},data:{state:"settling",reservedUsd:200}});
            await db.deskInventory.update({where:{id:inv.id},data:{suspended:true,
                reason:condition==="other-suspension"?"Unattributed exchange fill on managed position":"Exchange inventory differs from desk ledger"}});
            if(condition==="foreign-position")fixture.pos.set(positionKey(perp),1);
            if(condition==="foreign-order")fixture.open.push({coin:perp.coin,oid:999,side:"B",sz:"1",limitPx:"100"});
            if(condition==="missing-close-flow"){
                await db.deskCashFlow.deleteMany({where:{intentId:close.id}});
                fixture.withholdFills=true;
            }
            const actions=fixture.actions.length;
            await engine.reconcile(book.id);
            const after=await db.deskInventory.findUniqueOrThrow({where:{id:inv.id}});
            const intent=await db.deskIntent.findUniqueOrThrow({where:{id:close.id}});
            if(condition==="repair"){
                expect(after).toMatchObject({quantity:0,suspended:false,reason:null,realizedUsd:inv.realizedUsd});
                expect(intent).toMatchObject({state:"filled",reservedUsd:0,filledQty:2});
                await engine.reconcile(book.id);
                expect(await db.deskRecord.count({where:{kind:"inventory_reconciliation"}})).toBe(1);
            } else {
                expect(after.suspended).toBe(true);expect(intent.reservedUsd).toBe(200);
            }
            expect(fixture.actions).toHaveLength(actions);
        });
    it("prices working entry risk by stop distance while preserving notional capital reservations",async()=>{
        await db.deskBook.update({where:{id:book.id},data:{mandateJson:JSON.stringify(SWING_DESK_MANDATE)}});
        const pending=await db.deskIntent.create({data:{bookId:book.id,intentKey:"other",cloid:"0xother",instrumentId:"testnet:perp:OTHER",coin:"OTHER",asset:999,state:"working",side:"buy",quantity:1,filledQty:0,limitPrice:100,arrivalPrice:100,reservedUsd:100,policyVersion:book.version,fingerprint:"other",requestJson:JSON.stringify({stopPrice:98})}});
        fixture.statuses.set(pending.cloid,{oid:"999",status:"open",cloid:pending.cloid});
        const plan={...buy(),strategyVersion:"continuation-1",proposalKey:"fresh",maxHoldHours:2,entryExpiresAt:new Date(Date.now()+3600000).toISOString()};
        expect((await engine.preview(book.id,plan)).quantity).toBe(2);
        expect((await db.deskIntent.findUniqueOrThrow({where:{id:pending.id}})).reservedUsd).toBe(100);
        await db.deskIntent.update({where:{id:pending.id},data:{requestJson:"{}"}});
        await expect(engine.preview(book.id,plan)).rejects.toThrow(/Aggregate open risk/);
        expect(fixture.actions).toHaveLength(0);
    });
    it("rejects mandate breaches, stale quotes and foreign positions before signing", async () => {
        await expect(engine.execute(book.id, "big", { ...buy(), quantity: 8 })).rejects.toThrow(/cap|budget/);
        fixture.stale = true;
        await expect(engine.preview(book.id, buy())).rejects.toThrow(/Stale/);
        fixture.stale = false;
        fixture.pos.set(positionKey(perp), 3);
        await expect(engine.execute(book.id, "manual", buy())).rejects.toThrow(/Foreign/);
        await engine.adopt(book.id, perp.id);
        expect((await engine.preview(book.id, buy())).quantity).toBe(2);
        fixture.pos.set(positionKey(perp), 4);
        await engine.reconcile(book.id);
        expect((await engine.state(book.id)).inventory[0].suspended).toBe(true);
        expect(fixture.actions).toHaveLength(0);
    });
    it("prices a non-USD quote in dollars and cannot spend an operator's quote-token position without handover", async () => {
        const cross = instruments[2],
            order = { ...buy(cross), quantity: 0.02 };
        fixture.pos.set(positionKey(spot), 5);
        await expect(engine.preview(book.id, order)).rejects.toThrow(/Quote token/);
        await engine.adopt(book.id, spot.id);
        expect((await engine.preview(book.id, order)).notionalUsd).toBeGreaterThan(200);
        await engine.execute(book.id, "cross", order);
        const s = await engine.reconcile(book.id);
        expect(s.inventory.find((v) => v.instrumentId === spot.id)?.quantity).toBeCloseTo(5 - 0.02 * fixture.ask);
        expect(s.inventory.find((v) => v.instrumentId === cross.id)?.quantity).toBeCloseTo(0.02);
        expect(s.inventory.some((v) => v.suspended)).toBe(false);
    });
    it("persists a spot/perp pair and unwinds first-leg inventory if the hedge is rejected", async () => {
        fixture.rejectSecond = true;
        const pair = {
            legs: [buy(spot), { ...buy(), side: "sell", limitPrice: 100, stopPrice: 102 }],
            maxUnhedgedUsd: 300,
            timeoutSeconds: 60,
            onFailure: "unwind",
        } as const;
        await engine.pair(book.id, "basis", { ...pair, legs: [...pair.legs] });
        for (let i = 0; i < 4; i++) await engine.tick(book.id);
        expect((await engine.state(book.id)).pairs[0].state).toBe("unwound");
        expect(fixture.pos.get(positionKey(spot))).toBe(0);
        expect(fixture.actions.filter((a) => a.type === "order")).toHaveLength(3);
    });
    it("repairs missing protection, keeps the old stop until replacement is acknowledged and removes it after a close", async () => {
        await engine.execute(book.id, "entry", buy());
        await engine.tick(book.id);
        expect(fixture.open.map((o) => o.triggerPx)).toEqual(["98"]);
        fixture.rejectGuard = true;
        await expect(engine.revise(book.id, perp.id, 99)).rejects.toThrow(/rejection/);
        expect(fixture.open.map((o) => o.triggerPx)).toEqual(["98"]);
        fixture.rejectGuard = false;
        await engine.tick(book.id);
        expect(fixture.open.map((o) => o.triggerPx)).toEqual(["99"]);
        const close = { ...buy(), side: "sell" as const, stopPrice: undefined, limitPrice: 100, reduceOnly: true };
        expect((await engine.execute(book.id, "close", close)).state).toBe("settling");
        await expect(engine.execute(book.id, "new", buy())).rejects.toThrow(/stale protection/);
        await engine.tick(book.id);
        expect(fixture.open).toHaveLength(0);
    });
    it("rechecks disable at signing and releases a reservation when nothing was sent", async () => {
        fixture.beforeSign = async () => {
            await db.deskBook.update({ where: { id: book.id }, data: { enabled: false, version: { increment: 1 } } });
        };
        const r = await engine.execute(book.id, "raced", buy());
        expect(r.state).toBe("rejected");
        expect(r.reservedUsd).toBe(0);
        expect(fixture.actions).toHaveLength(0);
    });
    it("arms venue cancellation first, quotes in isolation, and pulls working orders when the market book is stale", async () => {
        const cfg = { instrumentId: perp.id, halfSpreadBps: 12, orderUsd: 60, inventoryLimitUsd: 200 };
        await expect(engine.configureQuotes(book.id, cfg)).rejects.toThrow(/isolated/);
        const q = await db.deskBook.create({
            data: {
                ownerAddress: book.ownerAddress,
                accountAddress: "0xsub",
                enabled: true,
                isTestnet: true,
                kind: "quoting",
                mandateJson: book.mandateJson,
            },
        });
        await engine.configureQuotes(q.id, cfg);
        await engine.tick(q.id);
        expect(fixture.actions.map((a) => a.type)).toEqual(["scheduleCancel", "order", "order"]);
        expect(fixture.open).toHaveLength(2);
        expect((await engine.state(book.id)).intents).toHaveLength(0);
        fixture.stale = true;
        await expect(engine.tick(q.id)).rejects.toThrow(/Stale/);
        expect(fixture.open).toHaveLength(0);
    });
});
