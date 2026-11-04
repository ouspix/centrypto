import type { DeskBook } from "@prisma/client";
import type { DeskInstrument } from "./instruments";

export type DeskOrder = {
    instrumentId: string;
    side: "buy" | "sell";
    quantity: number;
    limitPrice: number;
    reduceOnly?: boolean;
    stopPrice?: number;
    takeProfitPrice?: number;
    thesis: string;
    eventId?: string;
};
export type DeskPairPlan = {
    legs: [DeskOrder, DeskOrder];
    maxUnhedgedUsd: number;
    timeoutSeconds: number;
    onFailure: "unwind";
};
export type DeskQuoteConfig = {
    instrumentId: string;
    halfSpreadBps: number;
    orderUsd: number;
    inventoryLimitUsd: number;
};
export type Level = { px: string; sz: string };
export type DeskL2 = { time: number; levels: [Level[], Level[]] };
export type LiveOrder = {
    coin: string;
    oid: number;
    cloid?: string | null;
    side: "B" | "A";
    sz: string;
    limitPx: string;
    reduceOnly?: boolean;
    triggerPx?: string;
    isTrigger?: boolean;
    isPositionTpsl?: boolean;
    orderType?: string;
    children?: LiveOrder[];
};
export type ExchangeFill = {
    coin: string;
    oid: number;
    tid: number;
    time: number;
    px: string;
    sz: string;
    side: "B" | "A";
    fee: string;
    feeToken?: string;
    closedPnl: string;
    hash: string;
};
export type Funding = { time: number; hash: string; delta: { coin: string; usdc: string; szi: string } };
export type DeskAccount = {
    positions: Map<string, number>; // Spot keyed by token index, perp by venue coin
    freeSpot: Map<number, number>;
    marks: Map<string, number>; // instrument ID => quote currency
    tokenUsd: Map<number, number>;
    openOrders: LiveOrder[];
    equity: number;
    grossUsd: number;
    rollingPnl: number;
    riskWarnings?: string[];
};
export function positionKey(i: DeskInstrument): string {
    return i.kind === "spot" ? `spot:${i.baseTokenIndex}` : `perp:${i.coin}`;
}
export function fx(i: DeskInstrument, a: DeskAccount): number {
    if (i.kind === "perp") return 1;
    return positive(a.tokenUsd.get(i.quoteTokenIndex!), "quote currency USD rate");
}
export function finite(v: unknown, label: string): number {
    if ((typeof v !== "string" && typeof v !== "number") || v === "" || !Number.isFinite(Number(v)))
        throw new Error(`Missing or invalid ${label}`);
    return Number(v);
}
export function positive(v: unknown, label: string): number {
    const n = finite(v, label);
    if (n <= 0) throw new Error(`Invalid ${label}`);
    return n;
}
export type VenueStatus = { oid: string; status: string; cloid?: string | null } | null;
export type SignedAction = { type: string } & Record<string, unknown>;
export type DeskVenue = {
    instruments(testnet: boolean): Promise<DeskInstrument[]>;
    account(book: DeskBook, instruments: DeskInstrument[]): Promise<DeskAccount>;
    book(book: DeskBook, instrument: DeskInstrument): Promise<DeskL2>;
    fills(book: DeskBook, startTime: number, endTime: number): Promise<ExchangeFill[]>;
    funding(book: DeskBook, startTime: number, endTime: number): Promise<Funding[]>;
    status(book: DeskBook, order: string | number): Promise<VenueStatus>;
    write(
        book: DeskBook,
        action: SignedAction,
        nonce: number,
        authorize: () => Promise<void>,
        onDispatch: () => void,
    ): Promise<unknown>;
};
