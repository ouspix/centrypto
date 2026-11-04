import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "crypto";
import type { DeskBook, DeskIntent, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import type { DeskInstrument } from "./instruments";
import { parseDeskMandate } from "./mandate";
import { assessDeskOrder, inspectBook, LIVE_ORDER_STATES, parseDeskOrder } from "./execution-risk";
import { keyed, syncLedger, foreignOrdersOnInstrument } from "./execution-ledger";
import {
    fx,
    positionKey,
    positive,
    type DeskAccount,
    type DeskOrder,
    type DeskPairPlan,
    type DeskQuoteConfig,
    type DeskVenue,
    type SignedAction,
} from "./execution-types";
import { hyperliquidDeskVenue } from "./venue";
export type { DeskOrder, DeskPairPlan, DeskQuoteConfig } from "./execution-types";

const authority = new AsyncLocalStorage<() => Promise<void>>();
export const withDeskExecutionAuthority = <T>(check: () => Promise<void>, work: () => Promise<T>) =>
    authority.run(check, work);
type Lock = { book: DeskBook; key: string; token: string };
type Source = "directional" | "pair" | "quote" | "protection";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const cloid = (book: string, key: string) => "0x" + digest(JSON.stringify([book, key])).slice(0, 32);
const ref = (bookId: string, intentKey: string) => ({ bookId_intentKey: { bookId, intentKey } });
const form = (n: number) => n.toFixed(14).replace(/\.?0+$/, "");
function envelope(raw: unknown) {
    const e = raw as {
        status?: string;
        response?:
            | string
            | {
                  data?: {
                      statuses?: ({ error?: string; filled?: { oid: number }; resting?: { oid: number } } | string)[];
                  };
              };
    };
    if (e?.status === "err") throw new Error("Venue rejection: " + String(e.response).slice(0, 400));
    if (e?.status !== "ok") throw new Error("Unrecognized exchange response");
    return typeof e.response === "object" ? e.response?.data?.statuses : undefined;
}

export class DeskExecution {
    constructor(
        private db: PrismaClient,
        private venue: DeskVenue,
    ) {}
    private get(bookId: string) {
        return this.db.deskBook.findUniqueOrThrow({ where: { id: bookId } });
    }
    private async locked<T>(bookId: string, task: (l: Lock) => Promise<T>) {
        const book = await this.get(bookId),
            token = randomUUID();
        // The signing credential can be shared by master and subaccounts. Hold the lease across both.
        const key = book.ownerAddress.toLowerCase() + ":" + book.isTestnet;
        await this.db.deskExecutionLease.upsert({
            where: { key },
            create: { key, token: "", expiresAt: new Date(0) },
            update: {},
        });
        const claim = () =>
            this.db.deskExecutionLease.updateMany({
                where: { key, token },
                data: { expiresAt: new Date(Date.now() + 60_000) },
            });
        const got = await this.db.deskExecutionLease.updateMany({
            where: { key, expiresAt: { lt: new Date() } },
            data: { token, expiresAt: new Date(Date.now() + 60_000) },
        });
        if (!got.count) throw new Error("Desk execution busy; retry with the same intent key");
        const timer = setInterval(() => void claim().catch(() => {}), 15000);
        timer.unref?.();
        try {
            return await task({ book, key, token });
        } finally {
            clearInterval(timer);
            await this.db.deskExecutionLease.updateMany({
                where: { key, token },
                data: { expiresAt: new Date(0), token: "" },
            });
        }
    }
    private async instruments(b: DeskBook) {
        const list = await this.venue.instruments(b.isTestnet);
        if (!list.length) throw new Error("Cannot resolve venue instruments");
        return list;
    }
    private instrument(list: DeskInstrument[], id: string) {
        const i = list.find((i) => i.id === id);
        if (!i) throw new Error("Unknown instrument for book network");
        return i;
    }
    private async authorize(l: Lock, cleanup: boolean) {
        await authority.getStore()?.();
        const [book, lease, kill] = await Promise.all([
            this.get(l.book.id),
            this.db.deskExecutionLease.findUniqueOrThrow({ where: { key: l.key } }),
            this.db.walletRiskControl.findUnique({
                where: { userAddress_isTestnet: { userAddress: l.book.ownerAddress, isTestnet: l.book.isTestnet } },
            }),
        ]);
        if (lease.token !== l.token || lease.expiresAt.getTime() < Date.now()) throw new Error("Execution lease lost");
        if (
            book.accountAddress !== l.book.accountAddress ||
            book.kind !== l.book.kind ||
            book.version !== l.book.version
        )
            throw new Error("Book or mandate changed");
        if (!cleanup && (!book.enabled || kill?.killSwitch)) throw new Error("Desk disabled or kill switch active");
    }
    private async write(
        l: Lock,
        action: SignedAction,
        cleanup: boolean,
        recheck?: () => Promise<void>,
        onDispatch = () => {},
    ) {
        await this.authorize(l, cleanup);
        const row = await this.db.deskExecutionLease.findUniqueOrThrow({ where: { key: l.key } });
        const nonce = Math.max(Date.now(), Number(row.nonce) + 1);
        if (
            !(
                await this.db.deskExecutionLease.updateMany({
                    where: { key: l.key, token: l.token, nonce: row.nonce },
                    data: { nonce: BigInt(nonce) },
                })
            ).count
        )
            throw new Error("Nonce ownership lost");
        return this.venue.write(
            l.book,
            action,
            nonce,
            async () => {
                await this.authorize(l, cleanup);
                if (recheck) await recheck();
            },
            onDispatch,
        );
    }
    private async prepare(l: Lock, o: DeskOrder, source: Source, omit?: string) {
        const b = l.book,
            iList = await this.instruments(b),
            i = this.instrument(iList, o.instrumentId),
            bookId = b.id;
        const { account, metrics, deskGrossUsd } = await syncLedger(this.db, this.venue, b, iList);
        const inv = await this.db.deskInventory.findUnique({ where: keyed(bookId, i.id) });
        const sibling =
            i.kind === "spot"
                ? iList
                      .filter((x) => x.kind === "spot" && x.id !== i.id && x.baseTokenIndex === i.baseTokenIndex)
                      .map((s) => s.id)
                : [];
        if (
            sibling.length &&
            (await this.db.deskInventory.count({
                where: { bookId, instrumentId: { in: sibling }, quantity: { not: 0 } },
            }))
        )
            throw new Error("Spot token already managed through another pair");
        const all = await this.db.deskIntent.findMany({ where: { bookId } });
        if (all.some((r) => r.id !== omit && sibling.includes(r.instrumentId) && LIVE_ORDER_STATES.includes(r.state)))
            throw new Error("Unsettled order on the same spot token through another market");
        if (i.kind === "spot" && i.quoteTokenIndex !== 0) {
            const treasury = iList.find(
                (s) => s.kind === "spot" && s.baseTokenIndex === i.quoteTokenIndex && s.quoteTokenIndex === 0,
            );
            if (!treasury) throw new Error("Cross-quoted market requires a directly priceable quote-token inventory");
            const managed = await this.db.deskInventory.findUnique({ where: keyed(bookId, treasury.id) });
            const actual = account.positions.get(positionKey(treasury)) ?? 0;
            if (
                managed?.suspended ||
                Math.abs(actual - (managed?.quantity ?? 0)) > 1e-9 ||
                (o.side === "buy" && o.quantity * o.limitPrice > actual)
            )
                throw new Error("Quote token must be owned by the desk or handed over before use");
            const conflicts = (id: string) => {
                const other = iList.find((s) => s.id === id);
                return (
                    other?.kind === "spot" &&
                    other.id !== i.id &&
                    (other.baseTokenIndex === i.quoteTokenIndex || other.quoteTokenIndex === i.quoteTokenIndex)
                );
            };
            if (all.some((r) => r.id !== omit && LIVE_ORDER_STATES.includes(r.state) && conflicts(r.instrumentId)))
                throw new Error("Quote token already reserved by a working desk order");
            if (
                account.openOrders.some((o) => {
                    const market = iList.find((s) => s.coin === o.coin);
                    return market && conflicts(market.id);
                })
            )
                throw new Error("Working venue order overlaps quote currency");
        }
        const reserved = all.filter(
            (r) =>
                r.id !== omit &&
                (LIVE_ORDER_STATES.includes(r.state) ||
                    account.openOrders.some(
                        (v) => v.cloid && [r.cloid, r.stopCloid, r.targetCloid].includes(v.cloid),
                    )),
        );
        if (
            !inv?.quantity &&
            account.openOrders.some(
                (o) =>
                    o.coin === i.coin &&
                    o.cloid &&
                    all.some(
                        (r) =>
                            r.stopCloid === o.cloid ||
                            r.targetCloid === o.cloid ||
                            (r.groupKey?.startsWith("guard/") && r.cloid === o.cloid),
                    ),
            )
        )
            throw new Error("Awaiting cancellation of stale protection");
        if (
            source !== "quote" &&
            reserved.some(
                (r) =>
                    r.instrumentId === i.id &&
                    !r.groupKey?.startsWith("guard/") &&
                    LIVE_ORDER_STATES.includes(r.state),
            )
        )
            throw new Error("Existing unsettled order on instrument");
        const depth = await this.venue.book(b, i);
        const preview = assessDeskOrder({
            order: o,
            instrument: i,
            instruments: iList,
            account,
            depth,
            mandate: parseDeskMandate(b.mandateJson),
            reserved,
            owned: inv?.quantity ?? 0,
            suspended: !!inv?.suspended,
            deskGrossUsd,
            dailyPnlUsd: metrics.dailyPnlUsd,
            quoting: source === "quote",
        });
        return { i, preview, account };
    }
    preview(bookId: string, order: DeskOrder) {
        return this.locked(bookId, async (l) => (await this.prepare(l, parseDeskOrder(order), "directional")).preview);
    }
    execute(bookId: string, key: string, order: DeskOrder) {
        return this.locked(bookId, (l) => this.submit(l, key, order, "directional"));
    }
    private async submit(l: Lock, key: string, raw: DeskOrder, source: Source, groupKey?: string) {
        if (!key || key.length > 240) throw new Error("Invalid intent key");
        const o = parseDeskOrder(raw),
            b = l.book,
            bookId = b.id,
            requestJson = JSON.stringify(o),
            fingerprint = digest(requestJson);
        const existing = await this.db.deskIntent.findUnique({ where: ref(bookId, key) });
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new Error("Intent key reused with different order");
            return existing;
        }
        if ((b.kind === "quoting") !== (source === "quote") && source !== "protection")
            throw new Error("Use the dedicated quote engine for a quoting book");
        await this.authorize(l, false);
        const { i, preview: p } = await this.prepare(l, o, source);
        const cid = cloid(bookId, key),
            bracket = i.kind === "perp" && !p.reducing;
        const stopCloid = bracket && p.stopPrice ? cloid(bookId, key + "#stop") : null,
            targetCloid = bracket && p.targetPrice ? cloid(bookId, key + "#target") : null;
        const draft = await this.db.deskIntent.create({
            data: {
                bookId,
                intentKey: key,
                cloid: cid,
                instrumentId: i.id,
                asset: i.asset,
                coin: i.coin,
                side: o.side,
                requestJson,
                fingerprint,
                policyVersion: b.version,
                arrivalPrice: p.arrivalPrice,
                quantity: p.quantity,
                limitPrice: p.limitPrice,
                reservedUsd: p.reservedUsd,
                state: "submitting",
                groupKey,
                stopCloid,
                targetCloid,
            },
        });
        const buy = o.side === "buy",
            orders: Record<string, unknown>[] = [
                {
                    a: i.asset,
                    b: buy,
                    p: form(p.limitPrice),
                    s: form(p.quantity),
                    r: p.reducing && i.kind === "perp",
                    t: { limit: { tif: source === "quote" ? "Alo" : "Ioc" } },
                    c: cid,
                },
            ];
        for (const [px, child, tpsl] of [
            [p.stopPrice, stopCloid, "sl"],
            [p.targetPrice, targetCloid, "tp"],
        ] as const) {
            if (px && child)
                orders.push({
                    a: i.asset,
                    b: !buy,
                    p: form(px),
                    s: form(p.quantity),
                    r: true,
                    t: { trigger: { isMarket: true, triggerPx: form(px), tpsl } },
                    c: child,
                });
        }
        let dispatched = false;
        let state = "unknown",
            oid: string | undefined,
            reason: string | undefined;
        try {
            // Final risk check against the same mandate with fresh positions and executable depth.
            // No inference, queue wait or signer interaction can enlarge the approved order.
            let riskCheckedAt = 0;
            const rawAck = await this.write(
                l,
                { type: "order", orders, grouping: orders.length > 1 ? "normalTpsl" : "na" },
                false,
                async () => {
                    if (Date.now() - riskCheckedAt > 1000) {
                        const latest = await this.prepare(l, o, source, draft.id);
                        if (
                            latest.i.asset !== i.asset ||
                            latest.preview.quantity !== p.quantity ||
                            latest.preview.reducing !== p.reducing ||
                            latest.preview.limitPrice !== p.limitPrice
                        )
                            throw new Error("Instrument or risk changed before signing");
                        if (source === "pair" && groupKey && !key.includes("/unwind")) {
                            const pair = await this.db.deskPair.findUniqueOrThrow({ where: { id: groupKey } });
                            if (
                                pair.deadline <= new Date() ||
                                latest.preview.notionalUsd > JSON.parse(pair.planJson).maxUnhedgedUsd
                            )
                                throw new Error("Pair deadline or unhedged budget exceeded");
                        }
                        if (source === "quote") {
                            const s = await this.db.deskExecutionState.findUniqueOrThrow({ where: { bookId } });
                            if (!s.quoteJson || !s.cancelAt || +s.cancelAt <= Date.now() + 8000)
                                throw new Error("Missing current venue cancellation heartbeat");
                        }
                        riskCheckedAt = Date.now();
                    }
                    await this.authorize(l, false);
                },
                () => {
                    dispatched = true;
                },
            );
            const statuses = envelope(rawAck);
            if (!statuses?.length || typeof statuses[0] !== "object")
                throw new Error("Unrecognized order acknowledgement");
            const first = statuses[0];
            if (first.error) {
                state = "rejected";
                reason = first.error;
            } else if (first.filled || first.resting) {
                oid = String((first.filled ?? first.resting)!.oid);
                state = first.filled ? "settling" : "working";
            }
            if (statuses.slice(1).some((s) => typeof s === "object" && s.error)) {
                reason = "Protection rejected; review and reduce exposure";
                state = "blocked";
            }
        } catch (err) {
            reason = err instanceof Error ? err.message : "Uncertain submission";
            if (!dispatched || reason.startsWith("Venue rejection:")) state = "rejected";
        }
        return this.db.deskIntent.update({
            where: { id: draft.id },
            data: { state, oid, reason, reservedUsd: state === "rejected" ? 0 : undefined },
        });
    }
    private async cancelOne(l: Lock, o: DeskIntent, children = false) {
        const ids = children ? [o.cloid, o.stopCloid, o.targetCloid] : [o.cloid];
        const cancels = ids.filter((s): s is string => !!s).map((c) => ({ asset: o.asset, cloid: c }));
        const statuses = envelope(await this.write(l, { type: "cancelByCloid", cancels }, true));
        if (!statuses || statuses.some((s) => s !== "success")) throw new Error("Exchange cancellation unconfirmed");
        return this.db.deskIntent.update({
            where: { id: o.id },
            data: { reason: "Cancellation acknowledged; awaiting reconciliation" },
        });
    }
    cancel(bookId: string, id: string) {
        return this.locked(bookId, async (l) => {
            const intent = await this.db.deskIntent.findFirstOrThrow({ where: { bookId, id } });
            return this.cancelOne(l, intent);
        });
    }
    adopt(bookId: string, instrumentId: string) {
        return this.locked(bookId, async (l) => {
            const instruments = await this.instruments(l.book),
                i = this.instrument(instruments, instrumentId);
            const { account } = await syncLedger(this.db, this.venue, l.book, instruments),
                q = account.positions.get(positionKey(i)) ?? 0;
            const orders = await this.db.deskIntent.findMany({ where: { bookId } });
            if (
                foreignOrdersOnInstrument(account, i, orders).length ||
                orders.some((o) => o.instrumentId === i.id && LIVE_ORDER_STATES.includes(o.state))
            )
                throw new Error("Resolve existing orders before handover");
            if (i.kind === "spot") {
                const aliases = instruments
                    .filter((x) => x.kind === "spot" && x.baseTokenIndex === i.baseTokenIndex && x.id !== i.id)
                    .map((x) => x.id);
                if (
                    aliases.length &&
                    ((await this.db.deskInventory.count({
                        where: { bookId, instrumentId: { in: aliases }, quantity: { not: 0 } },
                    })) ||
                        orders.some((o) => aliases.includes(o.instrumentId) && LIVE_ORDER_STATES.includes(o.state)))
                )
                    throw new Error("A different spot pair already owns this token");
            }
            const basis = q === 0 ? 0 : positive(account.marks.get(i.id), "handover mark") * fx(i, account),
                since = new Date();
            const old = await this.db.deskInventory.findUnique({ where: keyed(bookId, i.id) });
            const accrual = old && old.quantity && basis ? (basis - old.basis) * old.quantity : 0;
            return this.db.deskInventory.upsert({
                where: keyed(bookId, i.id),
                create: { bookId, instrumentId, quantity: q, basis, since },
                update: {
                    quantity: q,
                    basis,
                    since,
                    realizedUsd: { increment: accrual },
                    suspended: false,
                    reason: "Operator handover",
                    stopPrice: null,
                    targetPrice: null,
                },
            });
        });
    }
    reconcile(bookId: string) {
        return this.locked(bookId, async (l) => {
            await syncLedger(this.db, this.venue, l.book, await this.instruments(l.book));
            return this.state(bookId);
        });
    }
    async state(bookId: string) {
        const where = { bookId };
        const [inventory, intents, fills, pairs, metrics] = await Promise.all([
            this.db.deskInventory.findMany({ where }),
            this.db.deskIntent.findMany({ where, orderBy: { createdAt: "desc" }, take: 120 }),
            this.db.deskCashFlow.findMany({ where, orderBy: { occurredAt: "desc" }, take: 150 }),
            this.db.deskPair.findMany({ where, orderBy: { createdAt: "desc" }, take: 50 }),
            this.db.deskExecutionState.findUnique({ where }),
        ]);
        return { inventory, intents, fills, pairs, metrics };
    }
    async abandon(bookId: string, intentId: string) {
        return this.locked(bookId, async (l) => {
            const o = await this.db.deskIntent.findFirstOrThrow({ where: { bookId, id: intentId } });
            if (!["submitting", "unknown"].includes(o.state) || o.createdAt.getTime() > Date.now() - 120000)
                throw new Error("Only an uncertain submission older than two minutes can be released");
            const list = await this.instruments(l.book),
                i = this.instrument(list, o.instrumentId);
            const { account } = await syncLedger(this.db, this.venue, l.book, list);
            if (
                (await this.venue.status(l.book, o.cloid)) ||
                o.filledQty > 0 ||
                account.openOrders.some((row) => row.cloid === o.cloid)
            )
                throw new Error("Venue has evidence of this order; reconcile normally");
            const inv = await this.db.deskInventory.findUnique({ where: keyed(bookId, i.id) });
            if (inv?.suspended || Math.abs((inv?.quantity ?? 0) - (account.positions.get(positionKey(i)) ?? 0)) > 1e-9)
                throw new Error("Reconcile inventory before releasing the reservation");
            return this.db.deskIntent.update({
                where: { id: o.id },
                data: {
                    state: "abandoned",
                    reservedUsd: 0,
                    reason: "Operator released reservation after venue reconciliation",
                },
            });
        });
    }
    revise(bookId: string, instrumentId: string, stopPrice: number, takeProfitPrice?: number) {
        return this.locked(bookId, async (l) => {
            await this.authorize(l, false);
            const list = await this.instruments(l.book),
                i = this.instrument(list, instrumentId);
            const { account } = await syncLedger(this.db, this.venue, l.book, list);
            const inv = await this.db.deskInventory.findUniqueOrThrow({ where: keyed(bookId, i.id) });
            const { bid, ask, mid } = inspectBook(await this.venue.book(l.book, i));
            if (
                inv.suspended ||
                !inv.quantity ||
                Math.abs(inv.quantity - (account.positions.get(positionKey(i)) ?? 0)) > 1e-9
            )
                throw new Error("Position ownership unresolved");
            const stop = positive(
                formatPrice(positive(stopPrice, "stop").toFixed(14), i.szDecimals, i.kind === "perp"),
                "stop",
            );
            const target =
                takeProfitPrice === undefined
                    ? null
                    : positive(
                          formatPrice(
                              positive(takeProfitPrice, "target").toFixed(14),
                              i.szDecimals,
                              i.kind === "perp",
                          ),
                          "target",
                      );
            const long = inv.quantity > 0;
            if (long ? stop >= bid : stop <= ask) throw new Error("Protective stop is already crossed");
            if (target && (long ? target <= ask : target >= bid)) throw new Error("Target is already crossed");
            const risk = Math.abs(mid - stop) * Math.abs(inv.quantity) * fx(i, account);
            if (risk > parseDeskMandate(l.book.mandateJson).maxRiskPerTradeUsd)
                throw new Error("Revised stop exceeds remaining risk budget");
            await this.db.deskInventory.update({
                where: { id: inv.id },
                data: { stopPrice: stop, targetPrice: target },
            });
            await this.protect(l, list, account);
            return this.db.deskInventory.findUniqueOrThrow({ where: { id: inv.id } });
        });
    }
    private async cancelCli(l: Lock, asset: number, id: string) {
        const result = envelope(await this.write(l, { type: "cancelByCloid", cancels: [{ asset, cloid: id }] }, true));
        if (!result || result[0] !== "success") throw new Error("Protective cancellation requires reconciliation");
    }
    private async protect(l: Lock, list: DeskInstrument[], account: DeskAccount) {
        const bookId = l.book.id;
        const records = await this.db.deskIntent.findMany({ where: { bookId } });
        const invRows = await this.db.deskInventory.findMany({ where: { bookId } });
        const stopped =
            !l.book.enabled ||
            !!(
                await this.db.walletRiskControl.findUnique({
                    where: {
                        userAddress_isTestnet: { userAddress: l.book.ownerAddress, isTestnet: l.book.isTestnet },
                    },
                })
            )?.killSwitch;
        const byChild = new Map<string, { parent: DeskIntent; type: "sl" | "tp" }>();
        for (const o of records) {
            if (o.stopCloid) byChild.set(o.stopCloid, { parent: o, type: "sl" });
            if (o.targetCloid) byChild.set(o.targetCloid, { parent: o, type: "tp" });
            if (o.groupKey === "guard/sl" || o.groupKey === "guard/tp")
                byChild.set(o.cloid, { parent: o, type: o.groupKey === "guard/sl" ? "sl" : "tp" });
        }
        // The dedicated quoting account keeps a venue dead-man rather than per-fill brackets.
        if (l.book.kind === "quoting") return;
        for (const inv of invRows) {
            const i = list.find((v) => v.id === inv.instrumentId);
            if (!i) continue;
            const live = account.positions.get(positionKey(i)) ?? 0;
            const ours = account.openOrders.filter((o) => o.coin === i.coin && o.cloid && byChild.has(o.cloid));
            const collision = inv.suspended || Math.abs(live - inv.quantity) > Math.max(1e-9, Math.abs(live) * 1e-9);
            if (collision || !live) {
                // Only touch our identified orders, and remove dormant stops before this symbol can be reused.
                for (const o of ours) await this.cancelCli(l, i.asset, o.cloid!);
                for (const r of records.filter(
                    (o) => o.instrumentId === i.id && o.state === "working" && !byChild.has(o.cloid) && collision,
                ))
                    await this.cancelOne(l, r);
                continue;
            }
            if (i.kind !== "perp" || stopped) continue;
            for (const type of ["sl", "tp"] as const) {
                const desired = type === "sl" ? inv.stopPrice : inv.targetPrice;
                const group = "guard/" + type;
                const liveGuards = ours.filter((o) => byChild.get(o.cloid!)!.type === type);
                const keep = liveGuards.find(
                    (o) =>
                        Number(o.triggerPx) === desired &&
                        o.side === (live > 0 ? "A" : "B") &&
                        (o.isPositionTpsl === true || Math.abs(Number(o.sz) - Math.abs(live)) < 1e-9),
                );
                if (desired && !keep) {
                    const observed = inspectBook(await this.venue.book(l.book, i));
                    const crossed =
                        type === "sl"
                            ? live > 0
                                ? observed.bid <= desired
                                : observed.ask >= desired
                            : live > 0
                              ? observed.bid >= desired
                              : observed.ask <= desired;
                    if (crossed) {
                        const close = await this.submit(
                            l,
                            "crossed/" + inv.id + "/" + inv.updatedAt.getTime(),
                            {
                                instrumentId: i.id,
                                side: live > 0 ? "sell" : "buy",
                                quantity: Math.abs(live),
                                limitPrice: live > 0 ? observed.bid : observed.ask,
                                reduceOnly: true,
                                thesis: "Standing " + type + " exit",
                            },
                            "protection",
                        );
                        if (close.state === "rejected")
                            throw new Error("Crossed protection exit rejected: " + close.reason);
                        break;
                    }
                    if (
                        records.some(
                            (r) =>
                                r.instrumentId === i.id &&
                                r.groupKey === group &&
                                ["unknown", "submitting"].includes(r.state),
                        )
                    )
                        throw new Error("Reconcile uncertain protective order before replacement");
                    const intentKey = "protect/" + randomUUID(),
                        cid = cloid(bookId, intentKey);
                    const row = await this.db.deskIntent.create({
                        data: {
                            bookId,
                            intentKey,
                            cloid: cid,
                            instrumentId: i.id,
                            asset: i.asset,
                            coin: i.coin,
                            requestJson: JSON.stringify({ thesis: "Maintain exchange protection", reduceOnly: true }),
                            fingerprint: cid,
                            policyVersion: l.book.version,
                            state: "submitting",
                            side: live > 0 ? "sell" : "buy",
                            arrivalPrice: observed.mid,
                            quantity: Math.abs(live),
                            limitPrice: desired,
                            reservedUsd: 0,
                            groupKey: group,
                        },
                    });
                    let dispatched = false;
                    try {
                        const action = {
                            type: "order",
                            orders: [
                                {
                                    a: i.asset,
                                    b: live < 0,
                                    p: form(desired),
                                    s: formatSize(Math.abs(live).toFixed(14), i.szDecimals),
                                    r: true,
                                    t: { trigger: { isMarket: true, triggerPx: form(desired), tpsl: type } },
                                    c: cid,
                                },
                            ],
                            grouping: "na",
                        };
                        const ack = envelope(
                            await this.write(l, action, false, undefined, () => {
                                dispatched = true;
                            }),
                        )?.[0];
                        if (typeof ack === "object" && ack.error) throw new Error("Venue rejection: " + ack.error);
                        if (typeof ack !== "object" || !ack.resting)
                            throw new Error("Missing protective acknowledgement");
                        await this.db.deskIntent.update({
                            where: { id: row.id },
                            data: { oid: String(ack.resting.oid), state: "working" },
                        });
                    } catch (e) {
                        const reason = e instanceof Error ? e.message : "Uncertain protection";
                        const failed = !dispatched || reason.startsWith("Venue rejection:");
                        await this.db.deskIntent.update({
                            where: { id: row.id },
                            data: { state: failed ? "rejected" : "unknown", reason },
                        });
                        if (failed && type === "sl" && !liveGuards.length) {
                            await this.submit(
                                l,
                                "unguarded/" + inv.id + "/" + inv.updatedAt.getTime(),
                                {
                                    instrumentId: i.id,
                                    side: live > 0 ? "sell" : "buy",
                                    quantity: Math.abs(live),
                                    limitPrice: live > 0 ? observed.bid : observed.ask,
                                    reduceOnly: true,
                                    thesis: "Exchange rejected stop; reduce unprotected risk",
                                },
                                "protection",
                            );
                        }
                        throw e;
                    }
                }
                // Leave the old working stop in place until its replacement has a positive acknowledgement.
                for (const o of liveGuards) if (o !== keep) await this.cancelCli(l, i.asset, o.cloid!);
            }
        }
        if (stopped)
            for (const o of records.filter((r) => r.state === "working" && !byChild.has(r.cloid)))
                await this.cancelOne(l, o);
    }
    async pair(bookId: string, intentKey: string, input: DeskPairPlan) {
        return this.locked(bookId, async (l) => {
            if (!intentKey || intentKey.length > 140 || l.book.kind !== "directional")
                throw new Error("Invalid pair request");
            if (
                input?.onFailure !== "unwind" ||
                input.legs?.length !== 2 ||
                !Number.isInteger(input.timeoutSeconds) ||
                input.timeoutSeconds < 5 ||
                input.timeoutSeconds > 300
            )
                throw new Error("Pair requires two legs, a 5–300 s deadline and an unwind plan");
            const legs = input.legs.map(parseDeskOrder) as [DeskOrder, DeskOrder];
            if (
                legs[0].instrumentId === legs[1].instrumentId ||
                legs[0].side === legs[1].side ||
                legs.some((o) => o.reduceOnly)
            )
                throw new Error("Pair requires opposing new exposure on distinct instruments");
            const plan: DeskPairPlan = {
                legs,
                maxUnhedgedUsd: positive(input.maxUnhedgedUsd, "unhedged budget"),
                timeoutSeconds: input.timeoutSeconds,
                onFailure: "unwind",
            };
            const planJson = JSON.stringify({ ...plan, bookVersion: l.book.version });
            let pair = await this.db.deskPair.findUnique({ where: ref(bookId, intentKey) });
            if (pair) {
                if (pair.planJson !== planJson) throw new Error("Pair intent key already used");
                return pair;
            }
            await this.authorize(l, false);
            for (const leg of legs) {
                const p = await this.prepare(l, leg, "pair");
                if (p.preview.reducing || p.preview.notionalUsd > plan.maxUnhedgedUsd)
                    throw new Error("Pair exceeds unhedged exposure or collides with opposite inventory");
            }
            pair = await this.db.deskPair.create({
                data: {
                    bookId,
                    intentKey,
                    planJson,
                    state: "first",
                    deadline: new Date(Date.now() + 1000 * plan.timeoutSeconds),
                },
            });
            // A durable state machine, also advanced by the independent fill/recovery tick.
            return this.advancePair(l, pair);
        });
    }
    private async advancePair(
        l: Lock,
        pair: { id: string; bookId: string; state: string; planJson: string; deadline: Date },
    ) {
        const set = (state: string, reason?: string) =>
            this.db.deskPair.update({ where: { id: pair.id }, data: { state, reason } });
        const plan: DeskPairPlan & { bookVersion: number } = JSON.parse(pair.planJson),
            [a, b] = plan.legs;
        const key = (part: string) => "pair/" + pair.id + "/" + part;
        const leg = async (part: string) => this.db.deskIntent.findUnique({ where: ref(l.book.id, key(part)) });
        const expired = pair.deadline.getTime() <= Date.now() || plan.bookVersion !== l.book.version;
        let first = await leg("first"),
            second = await leg("second");
        if (!first) {
            if (expired || !l.book.enabled) return set("expired", "Deadline passed before submission");
            first = await this.submit(l, key("first"), a, "pair", pair.id);
        }
        if (!first.filledQty) {
            if (["terminal", "rejected", "filled"].includes(first.state))
                return set("no_fill", first.reason ?? undefined);
            if (expired && first.state === "working") await this.cancelOne(l, first);
            return set("first", "Awaiting confirmed first-leg fills");
        }
        if (
            !second &&
            pair.state !== "unwind" &&
            !expired &&
            l.book.enabled &&
            ["terminal", "filled"].includes(first.state)
        ) {
            const hedgeQty = b.quantity * Math.min(1, first.filledQty / a.quantity);
            try {
                second = await this.submit(l, key("second"), { ...b, quantity: hedgeQty }, "pair", pair.id);
            } catch (e) {
                return set("unwind", String(e));
            }
        }
        if (
            second &&
            ["filled", "terminal"].includes(second.state) &&
            Math.abs(second.filledQty - second.quantity) < 1e-9
        )
            return set("complete");
        if (
            !expired &&
            pair.state !== "unwind" &&
            l.book.enabled &&
            (!second || !["rejected", "terminal"].includes(second.state))
        )
            return set("hedging");
        if (
            [first, second].some(
                (o) => o && ["unknown", "submitting", "working", "settling", "blocked"].includes(o.state),
            )
        ) {
            for (const o of [first, second]) if (o?.state === "working") await this.cancelOne(l, o);
            return set("unwind", "Reconciling both legs before unwind");
        }
        const list = await this.instruments(l.book);
        for (const [k, o] of [first, second].entries()) {
            if (!o?.filledQty) continue;
            const prefix = key("unwind" + k + "/");
            const prior = await this.db.deskIntent.findMany({
                where: { bookId: l.book.id, intentKey: { startsWith: prefix } },
            });
            if (prior.some((row) => LIVE_ORDER_STATES.includes(row.state)))
                return set("unwind", "Awaiting unwind acknowledgement");
            const i = this.instrument(list, o.instrumentId),
                remaining = o.filledQty - prior.reduce((acc, row) => acc + row.filledQty, 0);
            if (remaining < 10 ** -i.szDecimals * 0.999999) continue;
            const inv = await this.db.deskInventory.findUnique({ where: keyed(l.book.id, i.id) });
            if (!inv || inv.suspended || inv.quantity * (o.side === "buy" ? 1 : -1) <= 0)
                return set("intervention", "Pair inventory is ambiguous");
            if (!l.book.enabled) return set("unwind", "Book disabled with residual inventory");
            const { bid, ask } = inspectBook(await this.venue.book(l.book, i)),
                buy = o.side === "sell";
            if (prior.length >= 5) return set("intervention", "Unwind remained partial after five attempts");
            await this.submit(
                l,
                prefix + prior.length,
                {
                    instrumentId: i.id,
                    side: buy ? "buy" : "sell",
                    quantity: Math.min(Math.abs(inv.quantity), remaining),
                    limitPrice: buy ? ask : bid,
                    reduceOnly: true,
                    thesis: "Unwind incomplete pair " + pair.id,
                },
                "pair",
                pair.id,
            );
            return set("unwind");
        }
        return set("unwound");
    }
    configureQuotes(bookId: string, config: DeskQuoteConfig | null) {
        return this.locked(bookId, async (l) => {
            if (l.book.kind !== "quoting" || l.book.accountAddress.toLowerCase() === l.book.ownerAddress.toLowerCase())
                throw new Error("Quoting requires an isolated subaccount");
            if (config) {
                await this.authorize(l, false);
                const m = parseDeskMandate(l.book.mandateJson);
                this.instrument(await this.instruments(l.book), config.instrumentId);
                if (
                    positive(config.halfSpreadBps, "quote spread") >= 1000 ||
                    positive(config.orderUsd, "quote size") < 10 ||
                    config.orderUsd > m.maxOrderUsd ||
                    positive(config.inventoryLimitUsd, "inventory limit") >
                        Math.min(m.maxInstrumentUsd, m.maxRiskPerTradeUsd) ||
                    config.orderUsd > config.inventoryLimitUsd
                )
                    throw new Error("Quote parameters exceed mandate");
            }
            const quoteJson = config ? JSON.stringify({ ...config, bookVersion: l.book.version }) : null;
            return this.db.deskExecutionState.upsert({
                where: { bookId },
                create: { bookId, quoteJson },
                update: { quoteJson, lastQuotedAt: null },
            });
        });
    }
    private async tickQuotes(l: Lock) {
        const bookId = l.book.id,
            b = l.book;
        const record = await this.db.deskExecutionState.findUniqueOrThrow({ where: { bookId } });
        const live = await this.db.deskIntent.findMany({
            where: { bookId, groupKey: "maker", state: { in: LIVE_ORDER_STATES } },
        });
        const cancelQuotes = async () => {
            for (const o of live.filter(
                (o) => o.state === "working" || o.state === "unknown" || o.state === "submitting",
            ))
                await this.cancelOne(l, o);
        };
        if (!b.enabled || !record.quoteJson) {
            await cancelQuotes();
            if (!live.length)
                await this.db.deskExecutionState.update({
                    where: { bookId },
                    data: { quoteJson: null, cancelAt: null },
                });
            return;
        }
        try {
            const cfg = JSON.parse(record.quoteJson) as DeskQuoteConfig & { bookVersion: number },
                m = parseDeskMandate(b.mandateJson);
            if (
                cfg.bookVersion !== b.version ||
                cfg.inventoryLimitUsd > Math.min(m.maxInstrumentUsd, m.maxRiskPerTradeUsd) ||
                cfg.orderUsd > m.maxOrderUsd
            )
                throw new Error("Standing quote authorization exceeds current mandate");
            const instruments = await this.instruments(b),
                i = this.instrument(instruments, cfg.instrumentId);
            await this.authorize(l, false);
            const account = await this.venue.account(b, instruments);
            const all = await this.db.deskIntent.findMany({ where: { bookId } });
            if (
                account.openOrders.some(
                    (o) => !all.some((r) => r.oid === String(o.oid) || (!!o.cloid && r.cloid === o.cloid)),
                )
            )
                throw new Error("Foreign orders present on quoting subaccount");
            if (account.riskWarnings?.length) throw new Error(account.riskWarnings.join("; "));
            const outstanding = live.reduce((sum, o) => sum + o.reservedUsd, 0);
            if (
                Math.min(account.rollingPnl, record.dailyPnlUsd) <= -m.maxDailyLossUsd ||
                account.grossUsd + outstanding > Math.min(account.equity, m.capitalUsd) * m.maxGrossLeverage
            )
                throw new Error("Quoting account exceeds loss or gross exposure limit");
            const inv = await this.db.deskInventory.findUnique({ where: keyed(bookId, i.id) });
            const actual = account.positions.get(positionKey(i)) ?? 0;
            if (inv?.suspended || Math.abs(actual - (inv?.quantity ?? 0)) > 1e-9)
                throw new Error("Quote inventory requires reconciliation");
            const { bid, ask, mid } = inspectBook(await this.venue.book(b, i)),
                currency = fx(i, account),
                inventoryUsd = actual * mid * currency;
            if (!record.cancelAt || record.cancelAt.getTime() - Date.now() < 35_000) {
                const time = Date.now() + 65_000;
                const acknowledgement = await this.write(l, { type: "scheduleCancel", time }, false);
                envelope(acknowledgement);
                if ((acknowledgement as { response?: { type?: string } })?.response?.type !== "default")
                    throw new Error("Venue did not acknowledge scheduled cancellation");
                await this.db.deskExecutionState.update({ where: { bookId }, data: { cancelAt: new Date(time) } });
            }
            if (live.some((o) => o.state !== "working")) return;
            const skew = Math.max(-1, Math.min(1, inventoryUsd / cfg.inventoryLimitUsd));
            const center = mid * (1 - (skew * cfg.halfSpreadBps) / 10000);
            const desired = new Map<string, { quantity: number; limitPrice: number }>();
            for (const side of ["buy", "sell"] as const) {
                const buy = side === "buy",
                    capacity = cfg.inventoryLimitUsd + (buy ? -inventoryUsd : inventoryUsd);
                let usd = Math.min(cfg.orderUsd, capacity);
                if (actual * (buy ? 1 : -1) < 0) usd = Math.min(usd, Math.abs(inventoryUsd));
                if (i.kind === "spot" && !buy) usd = Math.min(usd, Math.max(0, inventoryUsd));
                const raw = buy
                    ? Math.min(bid, center * (1 - cfg.halfSpreadBps / 10000))
                    : Math.max(ask, center * (1 + cfg.halfSpreadBps / 10000));
                const price = Number(formatPrice(raw.toFixed(14), i.szDecimals, i.kind === "perp"));
                const qty = Number(formatSize((usd / (price * currency)).toFixed(i.szDecimals + 4), i.szDecimals));
                if (price > 0 && qty > 0 && qty * price * currency >= 10)
                    desired.set(side, { quantity: qty, limitPrice: price });
            }
            let cancelled = false;
            for (const o of live) {
                const want = desired.get(o.side);
                if (
                    !want ||
                    o.instrumentId !== i.id ||
                    Math.abs(want.limitPrice - o.limitPrice) / mid > cfg.halfSpreadBps / 40000 ||
                    Math.abs(want.quantity - (o.quantity - o.filledQty)) >= 10 ** -i.szDecimals
                ) {
                    await this.cancelOne(l, o);
                    cancelled = true;
                } else desired.delete(o.side);
            }
            if (cancelled) return; // replacement only after exchange confirms previous order is gone
            for (const [side, params] of desired) {
                await this.submit(
                    l,
                    "quote/" + randomUUID(),
                    {
                        instrumentId: i.id,
                        side: side as "buy" | "sell",
                        ...params,
                        thesis: "Standing two-sided quote",
                    },
                    "quote",
                    "maker",
                );
            }
            await this.db.deskExecutionState.update({ where: { bookId }, data: { lastQuotedAt: new Date() } });
        } catch (e) {
            await cancelQuotes();
            throw e;
        }
    }
    tick(bookId: string) {
        return this.locked(bookId, async (l) => {
            const b = l.book;
            let quoteLoopStarted = false;
            try {
                const list = await this.instruments(b);
                const { account } = await syncLedger(this.db, this.venue, b, list);
                await this.protect(l, list, account);
                for (const p of await this.db.deskPair.findMany({
                    where: { bookId, state: { in: ["first", "hedging", "unwind"] } },
                }))
                    await this.advancePair(l, p);
                if (b.kind === "quoting") {
                    quoteLoopStarted = true;
                    await this.tickQuotes(l);
                }
                if (b.enabled && b.kind === "directional") {
                    // Spot protection is monitored locally. Risk checks charge the full spot purchase as risk on entry.
                    for (const inv of await this.db.deskInventory.findMany({
                        where: { bookId, suspended: false, quantity: { gt: 0 } },
                    })) {
                        const i = list.find((x) => x.id === inv.instrumentId);
                        if (i?.kind !== "spot" || (!inv.stopPrice && !inv.targetPrice)) continue;
                        const { bid } = inspectBook(await this.venue.book(b, i));
                        if ((inv.stopPrice && bid <= inv.stopPrice) || (inv.targetPrice && bid >= inv.targetPrice)) {
                            await this.submit(
                                l,
                                "protect/" + inv.id + "/" + inv.updatedAt.getTime(),
                                {
                                    instrumentId: i.id,
                                    side: "sell",
                                    quantity: inv.quantity,
                                    limitPrice: bid,
                                    reduceOnly: true,
                                    thesis: "Standing spot exit",
                                },
                                "protection",
                            );
                        }
                    }
                }
                await this.db.deskExecutionState.update({
                    where: { bookId },
                    data: { lastError: account.riskWarnings?.join("; ") || null },
                });
            } catch (err) {
                const lastError = err instanceof Error ? err.message : "Desk reconciliation failed";
                if (b.kind === "quoting" && !quoteLoopStarted) {
                    // Even when a read endpoint is unavailable, attempt to pull our own quotes.
                    // The previously armed exchange timer covers a total network outage.
                    const pending = await this.db.deskIntent.findMany({
                        where: { bookId, groupKey: "maker", state: { in: LIVE_ORDER_STATES } },
                    });
                    for (const o of pending) {
                        try {
                            await this.cancelOne(l, o);
                        } catch {
                            /* The venue deadline remains armed. */
                        }
                    }
                }
                await this.db.deskExecutionState.upsert({
                    where: { bookId },
                    create: { bookId, lastError },
                    update: { lastError },
                });
                throw err;
            }
        });
    }
}
const desk = new DeskExecution(prisma, hyperliquidDeskVenue);
export const abandonDeskIntent = desk.abandon.bind(desk);
export const reviseDeskProtection = desk.revise.bind(desk);
export const previewDeskOrder = desk.preview.bind(desk);
export const executeDeskOrder = desk.execute.bind(desk);
export const cancelDeskOrder = desk.cancel.bind(desk);
export const adoptDeskPosition = desk.adopt.bind(desk);
export const reconcileDeskBook = desk.reconcile.bind(desk);
export const deskExecutionState = desk.state.bind(desk);
export const executeDeskPair = desk.pair.bind(desk);
export const configureDeskQuotes = desk.configureQuotes.bind(desk);
export const tickDeskExecution = desk.tick.bind(desk);
