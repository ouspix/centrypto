// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient, type DeskBook } from "@prisma/client";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeskExecution } from "@/lib/desk/execution";
import { DEFAULT_DESK_MANDATE } from "@/lib/desk/mandate";
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
        fills: async (b, s, e) => this.fills.filter((f) => f.time >= s && f.time <= e),
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
                this.statuses.set(w.c, { oid: String(oid), status: "open", cloid: w.c });
                return { status: "ok", response: { data: { statuses: [{ resting: { oid } }] } } };
            }
            const oid = this.actions.length + 100,
                alo = !!w.t.limit && w.t.limit.tif === "Alo",
                quantity = +w.s * (this.partial ? 0.5 : 1);
            const status = {
                oid: String(oid),
                cloid: w.c,
                status: alo ? "open" : this.partial ? "canceled" : "filled",
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
