import "server-only";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { listInstruments, type DeskInstrument } from "./instruments";
import { discoverMarket } from "./discovery";
import { discoveryFreshnessMs } from "./discovery-queue";

export const discoveryIntervalMs = 60_000;

async function loadSnapshot(isTestnet: boolean, resolve: () => Promise<DeskInstrument[]>, now: number) {
    const db = isTestnet ? marketDbTest : marketDbMain;
    const items = (await resolve()).filter(i => i.kind === "perp" && i.quote === "USDC");
    if (!items.length) throw new Error("Perpetual registry is empty");
    const select = { symbol: true, ts: true, markPrice: true, volume24h: true, fundingRate: true, openInterest: true, indexPrice: true, bookBidPx: true, bookAskPx: true } as const;
    const symbols = items.map(i => i.coin);
    const readWindow = (hours: number) => {
        const end = now - hours * 3_600_000;
        return db.marketTick.findMany({
            where: { ts: { gte: new Date(end - discoveryFreshnessMs), lte: new Date(end + (hours ? 0 : 1000)) }, symbol: { in: symbols } },
            distinct: ["symbol"], orderBy: { ts: "desc" }, select,
        });
    };
    const [ticks, hour, fourHours] = await Promise.all([readWindow(0), readWindow(1), readWindow(4)]);
    return { items, ticks, hour, fourHours };
}

type Snapshot = Awaited<ReturnType<typeof loadSnapshot>>;
const snapshots = new Map<boolean, { startedAt: number; pending: boolean; work: Promise<Snapshot> }>();

export async function readDiscoveryScan(isTestnet: boolean, options: {
    resolve?: () => Promise<DeskInstrument[]>; pinned?: string[]; nominated?: string[];
} = {}) {
    const now = Date.now();
    let snapshot = snapshots.get(isTestnet);
    if (!snapshot || (!snapshot.pending && (now < snapshot.startedAt || now - snapshot.startedAt >= discoveryIntervalMs))) {
        const work = loadSnapshot(isTestnet, options.resolve ?? (() => listInstruments(isTestnet, "perp")), now);
        const entry = { startedAt: now, pending: true, work };
        snapshots.set(isTestnet, entry);
        void work.then(() => { entry.pending = false; }, () => {
            if (snapshots.get(isTestnet) === entry) snapshots.delete(isTestnet);
        });
        snapshot = entry;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const { items, ticks, hour, fourHours } = await Promise.race([
            snapshot.work,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Discovery snapshot timed out")), 8000); }),
        ]);
        // Keep a timed-out read in flight until it settles to avoid piling up queries.
        return discoverMarket(items, ticks, hour, fourHours, options.pinned ?? [], options.nominated ?? [], Date.now());
    } finally { clearTimeout(timer); }
}
