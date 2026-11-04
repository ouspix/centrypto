import type { DeskMandate } from "@/lib/desk/mandate";

export type Book = {
    id: string;
    ownerAddress: string;
    accountAddress: string;
    isTestnet: boolean;
    kind: "directional" | "quoting";
    enabled: boolean;
    mandateJson: string;
    frequencySeconds: number;
    version: number;
    heartbeatAt: string | null;
    lastError: string | null;
};
export type JournalEntry = {
    id: number;
    shiftId: string | null;
    role: string;
    kind: string;
    createdAt: string;
    dataJson: string;
};
export type Watch = {
    id: string;
    kind: string;
    status: string;
    instrumentId: string | null;
    eventKey: string | null;
    thesis: string;
    deadline: string;
    threshold: number | null;
    referencePrice: number | null;
    outcomeJson: string | null;
};
export type Shift = {
    id: string;
    mode: string;
    status: string;
    briefJson: string;
    createdAt: string;
    error: string | null;
};
export type Inventory = {
    id: string;
    instrumentId: string;
    quantity: number;
    basis: number;
    realizedUsd: number;
    fundingUsd: number;
    suspended: boolean;
    reason: string | null;
};
export type Intent = {
    id: string;
    instrumentId: string;
    intentKey: string;
    state: string;
    side: string;
    quantity: number;
    filledQty: number;
    limitPrice: number;
    arrivalPrice: number;
    updatedAt: string;
    reason: string | null;
    requestJson: string;
};
export type Fill = {
    id: string;
    intentId: string | null;
    instrumentId: string;
    kind: string;
    quantity: number;
    price: number;
    feeUsd: number;
    pnlUsd: number;
    shortfallUsd: number;
    occurredAt: string;
};
export type Pair = { id: string; intentKey: string; state: string; deadline: string; reason: string | null };
export type Metrics = {
    netPnlUsd: number;
    dailyPnlUsd: number;
    unrealizedUsd: number;
    drawdownUsd: number;
    lastSync: string | null;
    quoteJson: string | null;
    lastQuotedAt: string | null;
    cancelAt: string | null;
    lastError: string | null;
};
export type Overview = {
    books: Book[];
    book: Book | null;
    records: JournalEntry[];
    shifts: Shift[];
    watches: Watch[];
    killSwitch: boolean;
    state: { inventory: Inventory[]; intents: Intent[]; fills: Fill[]; pairs: Pair[]; metrics: Metrics | null } | null;
};
export type Action = (payload: Record<string, unknown>) => Promise<boolean>;

export const mandateLabels: Record<keyof DeskMandate, string> = {
    capitalUsd: "Allocated capital ($)",
    maxOrderUsd: "Maximum order ($)",
    maxInstrumentUsd: "Maximum per instrument ($)",
    maxGrossLeverage: "Maximum gross leverage (×)",
    maxDailyLossUsd: "Daily loss limit ($)",
    maxRiskPerTradeUsd: "Risk per trade ($)",
    maxSlippageBps: "Maximum slippage (bps)",
    minDepthUsd: "Minimum book depth ($)",
};
export const dollars = (n: number | null | undefined) =>
    n == null || !Number.isFinite(n)
        ? "—"
        : n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
export const dateTime = (t: string | null | undefined) =>
    t && Number.isFinite(Date.parse(t)) ? new Date(t).toLocaleString() : "—";
export const shortAddress = (s: string) => s.slice(0, 6) + "…" + s.slice(-4);
export const readData = (raw: string | null | undefined): Record<string, unknown> => {
    try {
        const v = JSON.parse(raw ?? "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
        return {};
    }
};
export const field = (o: Record<string, unknown>, k: string) =>
    typeof o[k] === "string" || typeof o[k] === "number" ? String(o[k]) : "";
