import { hyperliquidInfoPost, waitForHyperliquidSlot as waitForLimiterSlot } from "@/lib/rate-limit/hyperliquid-limiter";
import { safeError, safeWarn } from "@/lib/log/safeLogger";

export type AssetMeta = {
    name: string;
    szDecimals: number;
    maxLeverage: number;
    onlyIsolated: boolean;
    isPerp: boolean;
    minSz: number;
};

export type MetaAndAssetCtxs = {
    universe: any[];
    assetCtxs: any[];
};

export type ExtraAgent = {
    address: string;
    name: string;
    validUntil: number;
};

export function hyperliquidInfoUrl(isTestnet: boolean): string {
    return isTestnet
        ? "https://api.hyperliquid-testnet.xyz/info"
        : "https://api.hyperliquid.xyz/info";
}

export type AssetLeverage = { type: 'cross' | 'isolated'; value: number };

export async function getActiveAssetLeverage(user: string, coin: string, isTestnet: boolean): Promise<AssetLeverage | null> {
    try {
        const response = await fetch(hyperliquidInfoUrl(isTestnet), {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'activeAssetData', user, coin }),
            signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) return null;
        const data = await response.json() as { user?: string; coin?: string; leverage?: AssetLeverage };
        const leverage = data?.leverage;
        if (data?.user?.toLowerCase() !== user.toLowerCase() || data.coin !== coin) return null;
        return leverage && (leverage.type === 'cross' || leverage.type === 'isolated')
            && Number.isSafeInteger(leverage.value) && leverage.value > 0 ? leverage : null;
    } catch (error) {
        safeWarn("Could not observe Hyperliquid order leverage", error);
        return null;
    }
}

export async function waitForHyperliquidSlot(): Promise<void> {
    await waitForLimiterSlot();
}

export async function getMeta(isTestnet: boolean): Promise<AssetMeta[]> {
    try {
        const data = await hyperliquidInfoPost<{ universe?: AssetMeta[] }>(
            "hl:info:meta",
            hyperliquidInfoUrl(isTestnet),
            { type: "meta" },
            { ttlMs: 20 * 60_000, staleMs: 60 * 60_000, allowStale: true }
        );
        return Array.isArray(data?.universe) ? data.universe : [];
    } catch (error) {
        safeError("Error fetching Hyperliquid metadata", error);
        return [];
    }
}

export async function getClearinghouseState(userAddress: string, isTestnet: boolean = false) {
    try {
        return await hyperliquidInfoPost<any>(
            "hl:info:clearinghouseState",
            hyperliquidInfoUrl(isTestnet),
            {
                type: "clearinghouseState",
                user: userAddress.toLowerCase()
            },
            { ttlMs: 2_000, staleMs: 5_000, allowStale: true }
        );
    } catch (error) {
        safeError("Error fetching Hyperliquid clearinghouse state", error);
        return null;
    }
}

export async function getSpotClearinghouseState(userAddress: string, isTestnet: boolean = false) {
    try {
        return await hyperliquidInfoPost<any>(
            "hl:info:spotClearinghouseState",
            hyperliquidInfoUrl(isTestnet),
            {
                type: "spotClearinghouseState",
                user: userAddress.toLowerCase()
            },
            { ttlMs: 2_000, staleMs: 5_000, allowStale: true }
        );
    } catch (error) {
        safeError("Error fetching Hyperliquid spot clearinghouse state", error);
        return null;
    }
}

export async function getAllMids(isTestnet: boolean = false): Promise<Record<string, string>> {
    try {
        const mids = await hyperliquidInfoPost<Record<string, string>>(
            "hl:info:allMids",
            hyperliquidInfoUrl(isTestnet),
            { type: "allMids" },
            { ttlMs: 1_000, staleMs: 5_000, allowStale: true }
        );
        return mids && typeof mids === "object" ? mids : {};
    } catch (error) {
        safeError("Error fetching Hyperliquid mids", error);
        return {};
    }
}

export async function getMetaAndAssetCtxs(isTestnet: boolean = false): Promise<MetaAndAssetCtxs | null> {
    try {
        const data = await hyperliquidInfoPost<any>(
            "hl:info:metaAndAssetCtxs",
            hyperliquidInfoUrl(isTestnet),
            { type: "metaAndAssetCtxs" },
            { ttlMs: 10_000, staleMs: 60_000, allowStale: true }
        );

        let universe: any[] | undefined;
        let assetCtxs: any[] | undefined;

        if (Array.isArray(data)) {
            if (data.length >= 2 && data[0]?.universe && Array.isArray(data[1])) {
                universe = data[0].universe;
                assetCtxs = data[1];
            } else if (data.length >= 2 && Array.isArray(data[0]) && Array.isArray(data[1])) {
                universe = data[0];
                assetCtxs = data[1];
            }
        } else if (data?.universe && data?.assetCtxs) {
            universe = data.universe;
            assetCtxs = data.assetCtxs;
        }

        if (!universe || !assetCtxs) {
            safeWarn("Unexpected Hyperliquid metaAndAssetCtxs response shape");
            return null;
        }

        return { universe, assetCtxs };
    } catch (error) {
        safeError("Error fetching Hyperliquid metaAndAssetCtxs", error);
        return null;
    }
}

export async function getOHLCV(coin: string, interval: string, isTestnet: boolean = false, startTime?: number) {
    try {
        const start = startTime || (Date.now() - (1000 * 60 * 60 * 24));
        return await hyperliquidInfoPost<any[]>(
            "hl:info:candleSnapshot",
            hyperliquidInfoUrl(isTestnet),
            {
                type: "candleSnapshot",
                req: { coin, interval, startTime: start }
            },
            { ttlMs: 3_000, staleMs: 30_000, allowStale: true }
        );
    } catch (error) {
        safeError("Error fetching Hyperliquid candles", error);
        return [];
    }
}

export async function getL2Book(coin: string, isTestnet: boolean = false) {
    try {
        return await hyperliquidInfoPost<any>(
            "hl:info:l2Book",
            hyperliquidInfoUrl(isTestnet),
            {
                type: "l2Book",
                coin
            },
            { ttlMs: 1_000, staleMs: 5_000, allowStale: true }
        );
    } catch (error) {
        safeError("Error fetching Hyperliquid L2 book", error);
        return null;
    }
}

export async function getUserFills(userAddress: string, isTestnet: boolean = false) {
    try {
        return await hyperliquidInfoPost<any[]>(
            "hl:info:userFills",
            hyperliquidInfoUrl(isTestnet),
            {
                type: "userFills",
                user: userAddress.toLowerCase()
            },
            { ttlMs: 2_000, staleMs: 5_000, allowStale: true }
        );
    } catch (error) {
        safeError("Error fetching Hyperliquid user fills", error);
        return [];
    }
}

export async function getUserFillsByTime(userAddress: string, isTestnet: boolean = false, startTime?: number, endTime?: number) {
    try {
        const request: Record<string, unknown> = {
            type: "userFillsByTime",
            user: userAddress.toLowerCase()
        };
        if (startTime !== undefined) request.startTime = startTime;
        if (endTime !== undefined) request.endTime = endTime;

        return await hyperliquidInfoPost<any[]>(
            "hl:info:userFillsByTime",
            hyperliquidInfoUrl(isTestnet),
            request,
            { ttlMs: 2_000, staleMs: 5_000, allowStale: true }
        );
    } catch (error) {
        safeError("Error fetching Hyperliquid user fills by time", error);
        return [];
    }
}

export async function getOpenOrders(userAddress: string, isTestnet: boolean = false) {
    try {
        return await hyperliquidInfoPost<any[]>(
            "hl:info:openOrders",
            hyperliquidInfoUrl(isTestnet),
            {
                type: "openOrders",
                user: userAddress.toLowerCase()
            },
            { ttlMs: 1_000, staleMs: 5_000, allowStale: true }
        );
    } catch (error) {
        safeError("Error fetching Hyperliquid open orders", error);
        return null;
    }
}

export async function getFrontendOpenOrders(userAddress: string, isTestnet: boolean = false, fresh = false) {
    try {
        return await hyperliquidInfoPost<any[]>(
            "hl:info:frontendOpenOrders",
            hyperliquidInfoUrl(isTestnet),
            {
                type: "frontendOpenOrders",
                user: userAddress.toLowerCase()
            },
            fresh ? { ttlMs: 0, staleMs: 0, allowStale: false } : { ttlMs: 1_000, staleMs: 5_000, allowStale: true }
        );
    } catch (error) {
        safeError("Error fetching Hyperliquid frontend open orders", error);
        return null;
    }
}

export async function getOrderStatus(userAddress: string, oidOrCloid: string | number, isTestnet: boolean = false) {
    try {
        const oid = typeof oidOrCloid === "number" || /^\d+$/.test(String(oidOrCloid))
            ? Number(oidOrCloid)
            : oidOrCloid;
        return await hyperliquidInfoPost<any>(
            "hl:info:orderStatus",
            hyperliquidInfoUrl(isTestnet),
            {
                type: "orderStatus",
                user: userAddress.toLowerCase(),
                oid
            },
            { ttlMs: 1_000, staleMs: 5_000, allowStale: true }
        );
    } catch (error) {
        safeError("Error fetching Hyperliquid order status", error);
        return null;
    }
}

export async function getExtraAgents(userAddress: string, isTestnet: boolean = false): Promise<ExtraAgent[]> {
    try {
        const agents = await hyperliquidInfoPost<ExtraAgent[]>(
            "hl:info:extraAgents",
            hyperliquidInfoUrl(isTestnet),
            {
                type: "extraAgents",
                user: userAddress.toLowerCase()
            },
            { ttlMs: 10_000, staleMs: 30_000, allowStale: true }
        );
        return Array.isArray(agents) ? agents : [];
    } catch (error) {
        safeError("Error fetching Hyperliquid API wallet agents", error);
        return [];
    }
}
