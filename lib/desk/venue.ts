import "server-only";
import { privateKeyToAccount } from "viem/accounts";
import { signL1Action } from "@nktkas/hyperliquid/signing";
import { getUserHyperliquidApiWalletCredential } from "@/lib/hyperliquid-api-wallet";
import { hyperliquidInfoUrl } from "@/lib/hyperliquid-info";
import { quoteUsdRates, listInstruments } from "./instruments";
import {
    finite,
    positive,
    type DeskAccount,
    type DeskVenue,
    type Funding,
    type ExchangeFill,
    type LiveOrder,
} from "./execution-types";
import type { DeskBook } from "@prisma/client";
import type { DeskInstrument } from "./instruments";

async function post<T>(book: DeskBook, endpoint: "info" | "exchange", payload: unknown): Promise<T> {
    // No stale cache or automatic retry on the execution path, especially after a timeout.
    const url = hyperliquidInfoUrl(book.isTestnet).replace(/info$/, endpoint);
    const res = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Exchange ${endpoint} HTTP ${res.status}`);
    return res.json() as Promise<T>;
}

async function history<T>(book: DeskBook, type: string, startTime: number, endTime: number): Promise<T[]> {
    const rows = await post<T[]>(book, "info", { type, user: book.accountAddress, startTime, endTime });
    if (!Array.isArray(rows)) throw new Error(`Missing ${type}`);
    // Time-range APIs can truncate to 500 rows. Splitting avoids dropping fills sharing a boundary.
    if (rows.length < 500) return rows;
    const mid = Math.floor((startTime + endTime) / 2);
    if (mid <= startTime) throw new Error(`Cannot resolve truncated ${type} interval`);
    return [...(await history<T>(book, type, startTime, mid)), ...(await history<T>(book, type, mid + 1, endTime))];
}
type PerpState = {
    marginSummary: { accountValue: string; totalNtlPos: string };
    assetPositions: { position: { coin: string; szi: string; positionValue: string } }[];
};
type SpotState = { balances: { token: number; coin: string; total: string; hold: string }[] };
async function account(book: DeskBook, instruments: DeskInstrument[]): Promise<DeskAccount> {
    const user = book.accountAddress;
    const [perps, spot, openOrders, mids, portfolio] = await Promise.all([
        post<PerpState>(book, "info", { type: "clearinghouseState", user }),
        post<SpotState>(book, "info", { type: "spotClearinghouseState", user }),
        post<LiveOrder[]>(book, "info", { type: "frontendOpenOrders", user }),
        post<Record<string, string>>(book, "info", { type: "allMids" }),
        post<[string, { pnlHistory: [number, string][] }][]>(book, "info", { type: "portfolio", user }),
    ]);
    if (
        !Array.isArray(perps?.assetPositions) ||
        !Array.isArray(spot?.balances) ||
        !Array.isArray(openOrders) ||
        !Array.isArray(portfolio)
    )
        throw new Error("Incomplete exchange account snapshot");
    const positions = new Map<string, number>(),
        freeSpot = new Map<number, number>(),
        marks = new Map<string, number>();
    for (const i of instruments) if (Number(mids[i.coin]) > 0) marks.set(i.id, positive(mids[i.coin], "mid"));
    const tokenUsd = quoteUsdRates(instruments, marks);
    const riskWarnings: string[] = [];
    let spotUsd = 0,
        grossUsd = finite(perps.marginSummary.totalNtlPos, "gross perp notional");
    for (const { position: p } of perps.assetPositions)
        positions.set("perp:" + p.coin, finite(p.szi, "perp position"));
    for (const b of spot.balances) {
        const qty = finite(b.total, "spot balance"),
            hold = finite(b.hold, "spot hold");
        freeSpot.set(b.token, qty - hold);
        positions.set("spot:" + b.token, qty);
        if (qty === 0) continue;
        // Unknown dust/tokens are never treated as free capital. When pricing existing gross risk is impossible,
        // block increases rather than silently understating portfolio exposure.
        const mark = tokenUsd.get(b.token);
        if (mark === undefined) {
            riskWarnings.push("Unpriced account balance: " + b.coin);
            continue;
        }
        const value = qty * positive(mark, "held spot mark for " + b.coin);
        spotUsd += value;
        if (b.token !== 0) grossUsd += Math.abs(value);
    }
    const hist = portfolio.find(([k]) => k === "day")?.[1]?.pnlHistory;
    const rollingPnl = hist?.length
        ? finite(hist[hist.length - 1][1], "current P&L") - finite(hist[0][1], "prior P&L")
        : 0;
    if (!hist?.length) riskWarnings.push("24h account P&L unavailable");
    const equity = Math.max(spotUsd, finite(perps.marginSummary.accountValue, "perps equity")); // conservative across account modes
    const flat = new Map<number, LiveOrder>();
    const visit = (o: LiveOrder) => {
        flat.set(o.oid, o);
        for (const child of o.children ?? []) visit(child);
    };
    openOrders.forEach(visit);
    return {
        positions,
        marks,
        tokenUsd,
        freeSpot,
        equity,
        grossUsd,
        openOrders: [...flat.values()],
        rollingPnl,
        riskWarnings,
    };
}

export const hyperliquidDeskVenue: DeskVenue = {
    instruments: listInstruments,
    account,
    book: (b, i) => post(b, "info", { type: "l2Book", coin: i.coin }),
    fills: (b, s, e) => history<ExchangeFill>(b, "userFillsByTime", s, e),
    funding: (b, s, e) => history<Funding>(b, "userFunding", s, e),
    async status(b, oid) {
        const r = await post<{
            status: string;
            order?: { order: { oid: number; cloid?: string | null }; status: string };
        }>(b, "info", { type: "orderStatus", user: b.accountAddress, oid });
        if (r.status === "unknownOid") return null;
        if (r.status !== "order" || !r.order?.order?.oid) throw new Error("Invalid exchange order status");
        return { oid: String(r.order.order.oid), status: r.order.status, cloid: r.order.order.cloid };
    },
    async write(book, action, nonce, authorize, onDispatch) {
        if (!["order", "cancelByCloid", "scheduleCancel"].includes(action.type))
            throw new Error("Unsupported desk action");
        const sub = book.accountAddress.toLowerCase() !== book.ownerAddress.toLowerCase();
        if (book.kind === "quoting" && !sub) throw new Error("Quoting requires a dedicated subaccount");
        if (sub) {
            const subs = await post<{ master: string; subAccountUser: string }[] | null>(book, "info", {
                type: "subAccounts",
                user: book.ownerAddress,
            });
            if (
                !subs?.some(
                    (s) =>
                        s.master.toLowerCase() === book.ownerAddress.toLowerCase() &&
                        s.subAccountUser.toLowerCase() === book.accountAddress.toLowerCase(),
                )
            )
                throw new Error("Subaccount ownership could not be verified");
        }
        const cred = await getUserHyperliquidApiWalletCredential(book.ownerAddress, book.isTestnet);
        const vaultAddress = sub ? (book.accountAddress as `0x${string}`) : undefined;
        await authorize();
        const expiresAfter = Date.now() + 8000; // after credential/venue lookups, immediately before signing
        const signature = await signL1Action({
            wallet: privateKeyToAccount(cred.privateKey),
            action,
            nonce,
            isTestnet: book.isTestnet,
            vaultAddress,
            expiresAfter,
        });
        await authorize();
        onDispatch();
        return post(book, "exchange", { action, signature, nonce, vaultAddress, expiresAfter });
    },
};
