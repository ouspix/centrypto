import type { DeskBook } from "@prisma/client";
import { prisma } from "@/lib/db";
import { listInstruments, type DeskInstrument } from "./instruments";
import { accountExposure } from "./market";

type Snapshot = { at: string; directory: DeskInstrument[]; heldIds: string[]; collateralSymbols: string[] };
type Coverage = {
    exposure: "observed" | "last_known" | "inventory_only" | "unknown";
    exposureAsOf: string | null;
    directory: "observed" | "held_instruments_only" | "unknown";
    directoryAsOf: string | null;
    needsReconciliation: boolean;
};

// Bound the delay before dispatching an urgent notice. A slow venue request
// cannot overwrite the cache when it completes after its observation deadline.
async function observe<T>(read: Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([read.catch(() => null), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
    } finally { clearTimeout(timer); }
}

export async function newsExposure(book: DeskBook) {
    const key = "news:last-known-exposure";
    const [observedRegistry, account, cache, inventory] = await Promise.all([
        observe(listInstruments(book.isTestnet)), observe(accountExposure(book)),
        prisma.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key}},select:{dataJson:true}}),
        prisma.deskInventory.findMany({where:{bookId:book.id,quantity:{not:0}},select:{instrumentId:true,updatedAt:true}})
    ]);
    const snapshot: Snapshot | null = cache ? JSON.parse(cache.dataJson) : null;
    const freshRegistry = observedRegistry?.length ? observedRegistry : null;
    const directory = freshRegistry ?? snapshot?.directory ?? [];
    const at = new Date().toISOString();
    const coverage: Coverage = {
        exposure: account ? "observed" : snapshot ? "last_known" : inventory.length ? "inventory_only" : "unknown",
        exposureAsOf: account ? at : snapshot?.at ?? (inventory.length ? new Date(Math.min(...inventory.map(i => +i.updatedAt))).toISOString() : null),
        directory: freshRegistry ? "observed" : directory.length ? "held_instruments_only" : "unknown",
        directoryAsOf: freshRegistry ? at : snapshot?.at ?? null,
        needsReconciliation: !account || !freshRegistry
    };
    if (!account) return {
        directory, coverage, heldIds: [...new Set([...(snapshot?.heldIds ?? []), ...inventory.map(i => i.instrumentId)])],
        collateralSymbols: snapshot?.collateralSymbols ?? []
    };

    const positionCoins = new Set<string>(account.positions.map((p: { coin: string }) => p.coin));
    const coins = new Set([...positionCoins, ...account.openOrders.map(o => o.coin)]);
    const balances = new Set<number>(account.spot.map((b: {token:number}) => b.token));
    const relevant = directory.filter(asset => coins.has(asset.coin) || (asset.kind === "spot" && asset.baseTokenIndex !== undefined && balances.has(asset.baseTokenIndex)));
    const collateralSymbols: string[] = [...new Set<string>(account.spot.map((b: {coin:string}) => b.coin))];
    if (Number(account.equity) > 0 && !collateralSymbols.includes("USDC")) collateralSymbols.push("USDC");
    const network = book.isTestnet ? "testnet" : "mainnet";
    const heldIds = [...new Set([...relevant.map(a => a.id), ...[...positionCoins].filter(c => !c.includes(":")).map(coin => network + ":perp:" + coin)])];
    if (freshRegistry) {
        // Store only instrument identity and exposure presence, never balances
        // or credentials. Retain a recent observation even on a news-quiet day.
        const updated: Snapshot = { at, directory:relevant, heldIds, collateralSymbols };
        if (!snapshot || Date.now() - Date.parse(snapshot.at) > 30_000 ||
            JSON.stringify({...snapshot,at:""}) !== JSON.stringify({...updated,at:""})) {
            const dataJson=JSON.stringify(updated);
            await prisma.deskRecord.upsert({where:{bookId_key:{bookId:book.id,key}},
                create:{bookId:book.id,key,kind:"news_scope",role:"system",dataJson},update:{dataJson}});
        }
    }
    return { directory, heldIds, coverage, collateralSymbols };
}
