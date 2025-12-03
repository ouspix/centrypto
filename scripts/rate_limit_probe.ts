/**
 * Quick Hyperliquid rate limit probe.
 * Sends 20 candleSnapshot requests (testnet) staggered by 200ms between dispatches.
 * No DB writes. Logs per-request status and aggregates counts.
 */

const API_URL = "https://api.hyperliquid-testnet.xyz/info";
const DISPATCH_DELAY_MS = 1000; // between batches
const BATCH_SIZE = 35;

type ProbeResult = {
    coin: string;
    status: number;
    ok: boolean;
    error?: string;
};

async function probeCoin(coin: string): Promise<ProbeResult> {
    try {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                type: "candleSnapshot",
                req: {
                    coin,
                    interval: "1m",
                    startTime: Date.now() - 60 * 60 * 1000 // last hour
                }
            })
        });

        return {
            coin,
            status: res.status,
            ok: res.ok,
            error: res.ok ? undefined : await res.text()
        };
    } catch (err: any) {
        return {
            coin,
            status: -1,
            ok: false,
            error: String(err?.message || err)
        };
    }
}

async function main() {
    const universe = await getUniverseSymbols();
    const coins = universe.length ? universe : [];

    if (!coins.length) {
        console.log("No universe symbols fetched; aborting probe.");
        return;
    }

    console.log(`Dispatching ${coins.length} requests in batches of ${BATCH_SIZE} with ${DISPATCH_DELAY_MS}ms spacing...`);

    const start = Date.now();
    const promises: Promise<ProbeResult>[] = [];

    for (let i = 0; i < coins.length; i += BATCH_SIZE) {
        const batch = coins.slice(i, i + BATCH_SIZE);
        console.log(`Batch ${i / BATCH_SIZE + 1}: ${batch.join(", ")}`);
        batch.forEach(coin => promises.push(probeCoin(coin)));
        if (i + BATCH_SIZE < coins.length) {
            await sleep(DISPATCH_DELAY_MS);
        }
    }

    const results = await Promise.all(promises);
    const durationMs = Date.now() - start;

    const ok = results.filter(r => r.ok).length;
    const r429 = results.filter(r => r.status === 429).length;
    const other = results.length - ok - r429;

    results.forEach(r => {
        console.log(`${r.coin}: status=${r.status} ok=${r.ok} ${r.error ? `err=${r.error.slice(0, 120)}` : ""}`);
    });

    console.log(`\nSummary: ok=${ok}, 429=${r429}, other=${other}, total=${results.length}, duration=${durationMs}ms`);
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getUniverseSymbols(): Promise<string[]> {
    try {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "metaAndAssetCtxs" })
        });

        if (!res.ok) {
            console.warn(`Universe fetch failed: status=${res.status}`);
            return [];
        }

        const data = await res.json();
        let universe: any[] | undefined;

        if (Array.isArray(data)) {
            // New shape: [ { universe, ... }, assetCtxs ]
            if (data[0]?.universe) {
                universe = data[0].universe;
            } else if (Array.isArray(data[0])) {
                // Legacy: [ universeArray, assetCtxsArray ]
                universe = data[0];
            }
        } else if (data?.universe) {
            universe = data.universe;
        }

        if (!Array.isArray(universe)) {
            console.warn("Universe fetch returned unexpected shape.");
            return [];
        }

        const symbols = universe
            .map((u: any) => u?.name)
            .filter((s: any): s is string => typeof s === "string");

        console.log(`Fetched universe size=${symbols.length}`);
        return symbols;
    } catch (err: any) {
        console.warn(`Universe fetch error: ${String(err?.message || err)}`);
        return [];
    }
}

main().catch(err => {
    console.error("Probe failed:", err);
    process.exit(1);
});
