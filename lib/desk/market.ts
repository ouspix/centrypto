import "server-only";
import {
    getAllMids,
    getClearinghouseState,
    getL2Book,
    getOpenOrders,
    getSpotClearinghouseState,
} from "@/lib/hyperliquid-info";
import type { DeskBook } from "@prisma/client";
import { listInstruments, type DeskInstrument } from "./instruments";

export async function instrument(isTestnet: boolean, id: unknown): Promise<DeskInstrument> {
    if (typeof id !== "string") throw new Error("Supply a venue instrument ID from the instrument directory.");
    const found = (await listInstruments(isTestnet)).find((item) => item.id === id);
    if (!found) throw new Error("Instrument is unavailable on this network.");
    return found;
}

export async function publicQuote(item: DeskInstrument, testnet: boolean, fullDepth = false) {
    const book = await getL2Book(item.coin, testnet);
    const bid = Number(book?.levels?.[0]?.[0]?.px),
        ask = Number(book?.levels?.[1]?.[0]?.px);
    const age = Date.now() - Number(book?.time);
    if (!(age >= -1000 && age <= 10000 && bid > 0 && ask >= bid))
        throw new Error("A fresh two-sided book is unavailable.");
    return {
        instrumentId: item.id,
        time: book.time as number,
        bid,
        ask,
        spreadBps: ((ask - bid) * 20000) / (ask + bid),
        bids: fullDepth ? book.levels[0] : book.levels[0].slice(0, 6),
        asks: fullDepth ? book.levels[1] : book.levels[1].slice(0, 6),
    };
}

// Addresses and signing state stay in the host. The desktop inference context gets exposure only.
export async function accountExposure(book: DeskBook) {
    const [perp, spot, orders] = await Promise.all([
        getClearinghouseState(book.accountAddress, book.isTestnet),
        getSpotClearinghouseState(book.accountAddress, book.isTestnet),
        getOpenOrders(book.accountAddress, book.isTestnet),
    ]);
    if (!perp || !Array.isArray(perp.assetPositions) || !Array.isArray(spot?.balances) || !Array.isArray(orders))
        throw new Error("Account exposure unavailable.");
    return {
        equity: perp.marginSummary?.accountValue,
        positions: perp.assetPositions.map(
            (p: { position: { coin: string; szi: string; positionValue: string; unrealizedPnl: string } }) => ({
                coin: p.position.coin,
                quantity: p.position.szi,
                value: p.position.positionValue,
                unrealized: p.position.unrealizedPnl,
            }),
        ),
        spot: spot.balances
            .filter((b: { total: string }) => Number(b.total) > 0)
            .map((b: { coin: string; token: number; total: string; hold: string }) => ({
                coin: b.coin,
                token: b.token,
                quantity: b.total,
                locked: b.hold,
            })),
        openOrders: orders.map((o) => ({ coin: o.coin, side: o.side, price: o.limitPx, quantity: o.sz })),
    };
}

export async function collectMids(testnet: boolean) {
    const [mids, items] = await Promise.all([getAllMids(testnet), listInstruments(testnet)]);
    return items
        .map((item) => ({ instrumentId: item.id, mid: Number(mids[item.coin]) }))
        .filter((m) => Number.isFinite(m.mid) && m.mid > 0);
}
