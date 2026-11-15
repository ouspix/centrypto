import "server-only";
import {
    hyperliquidInfoUrl,
    getAllMids,
    getClearinghouseState,
    getL2Book,
    getFrontendOpenOrders,
    getSpotClearinghouseState,
} from "@/lib/hyperliquid-info";
import type { DeskBook } from "@prisma/client";
import { listInstruments, type DeskInstrument } from "./instruments";

export async function instrument(isTestnet: boolean, id: unknown): Promise<DeskInstrument> {
    if (typeof id !== "string") throw new Error("Supply a venue instrument ID from the instrument directory.");
    const found = (await listInstruments(isTestnet, id.includes(":perp:") ? "perp" : "all")).find((item) => item.id === id);
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
    // Analytical account reads are staged. Fail early instead of launching four requests
    // during an outage; execution still obtains its own fresh account snapshot.
    const perp = await getClearinghouseState(book.accountAddress, book.isTestnet);
    if (!perp || !Array.isArray(perp.assetPositions)) throw new Error("Account exposure unavailable.");
    const spot = await getSpotClearinghouseState(book.accountAddress, book.isTestnet);
    if (!Array.isArray(spot?.balances)) throw new Error("Account exposure unavailable.");
    const orders = await getFrontendOpenOrders(book.accountAddress, book.isTestnet, true);
    if (!Array.isArray(orders)) throw new Error("Account exposure unavailable.");
    const abstraction = await fetch(hyperliquidInfoUrl(book.isTestnet), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "userAbstraction", user: book.accountAddress }), signal: AbortSignal.timeout(10000) }).then(async r => r.ok ? await r.json() : null).catch(() => null);
    if (!perp || !Array.isArray(perp.assetPositions) || !Array.isArray(spot?.balances) || !Array.isArray(orders))
        throw new Error("Account exposure unavailable.");
    const perpEquity = Number(perp.marginSummary?.accountValue);
    const marginUsed = Number(perp.marginSummary?.totalMarginUsed);
    const spotUsdc = spot.balances.find((b: { coin: string }) => b.coin === "USDC");
    const spotAvailable = spotUsdc ? Math.max(0, Number(spotUsdc.total) - Number(spotUsdc.hold)) : 0;
    return {
        collateral: {
            observedAt: new Date().toISOString(),
            accountMode: typeof abstraction === "string" ? abstraction : "unknown",
            perpEquityUsd: Number.isFinite(perpEquity) ? perpEquity : null,
            perpMarginUsedUsd: Number.isFinite(marginUsed) ? marginUsed : null,
            spotUsdcAvailable: Number.isFinite(spotAvailable) ? spotAvailable : null,
            status: abstraction === "unifiedAccount" && spotAvailable > 0 ? "unified_usdc_collateral_present"
                : abstraction === "portfolioMargin" ? "portfolio_margin_requires_venue_assessment"
                : !["disabled", "default", "dexAbstraction"].includes(abstraction) ? "account_mode_unverified"
                : !Number.isFinite(perpEquity) ? "unknown" : perpEquity <= 0 ? "no_perp_collateral" : "perp_equity_present_requires_order_preview",
            action: abstraction === "unifiedAccount"
                ? "Unified account confirmed: USDC is shared collateral for USDC perps and spot. Zero legacy perp accountValue does not imply unfunded. Do not transfer between spot and perps. A fresh concrete preview must still check size, reservations and risk limits; balance is not execution approval."
                : abstraction === "portfolioMargin" ? "Portfolio margin confirmed; do not infer spendable margin from legacy perp accountValue. Use venue margin assessment. No transfers authorized."
                : ["disabled", "default", "dexAbstraction"].includes(abstraction) && Number.isFinite(perpEquity) && perpEquity <= 0
                ? "Perpetual entries lack reported perp collateral in this separate-balance mode. Spot USDC is separate. An operator must authorize any transfer. Continue hypothetical research."
                : "Resolve account mode and usable margin before concluding funded or unfunded. No transfer is authorized. Continue hypothetical research.",
            transferAuthorized: false,
        },
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
        openOrders: orders.flatMap(function flatten(o: any): any[] {
            return [{ coin: o.coin, side: o.side, price: o.limitPx, quantity: o.sz, orderId: o.oid,
                reduceOnly: o.reduceOnly ?? null, isTrigger: o.isTrigger ?? null,
                triggerPrice: o.triggerPx ?? null, orderType: o.orderType ?? null,
                isPositionTpsl: o.isPositionTpsl ?? null }, ...(o.children ?? []).flatMap(flatten)];
        }),
    };
}

export async function collectMids(testnet: boolean) {
    const [mids, items] = await Promise.all([getAllMids(testnet), listInstruments(testnet)]);
    return items
        .map((item) => ({ instrumentId: item.id, mid: Number(mids[item.coin]) }))
        .filter((m) => Number.isFinite(m.mid) && m.mid > 0);
}
